/**
 * Subject + topic data access — SERVER-ONLY.
 *
 * Every function takes the trusted `institutionId` (resolved from the session
 * via `AuthPrincipal`, NEVER from a request body or query param) and applies it
 * as a hard filter to both reads and writes — the same tenant-isolation
 * contract as lib/data/students.ts, lib/data/teachers.ts and
 * lib/data/classes.ts (AGENTS.md §5). The service-role client bypasses RLS,
 * so the `.eq("institution_id", …)` filters here are what isolate tenants.
 *
 * TWO SCOPES, ONE TABLE
 * `institution_id IS NULL` marks a PLATFORM-catalogue row (shared starter
 * content). Reads always show platform ∪ own rows; writes ONLY ever touch the
 * caller's own rows — `getSubjectForWrite` / `getTopicForWrite` are the
 * writable-scope gates, so a planted platform id can never be edited or
 * archived from a tenant screen (the UI hiding the button is not the
 * enforcement).
 *
 * WHY THE TENANT CHECKS ARE LOAD-BEARING
 * The FKs (`topics.subject_id`, `topics.parent_id`,
 * `subject_exam_categories.category_id`) prove the referenced row EXISTS, not
 * that the caller may see it — a cross-tenant id passes the FK. Every
 * subject/parent id is therefore verified visible-to-the-caller (and every
 * category id verified against the platform lookup) before it reaches a row.
 *
 * ARCHIVE INSTEAD OF DELETE (AGENTS.md §6)
 * Questions, exams and results (prompts 15–27) will reference these ids, so
 * nothing here deletes. `setSubjectStatus` / `setTopicStatus` flip
 * active ⇄ archived; archived rows stay readable for history but are refused
 * by the selectable checks. The blocking rules live in the pure module
 * (`subjectArchiveBlocked` / `topicArchiveBlocked`) so they are unit-testable.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import {
  normalizeSubjectInput,
  normalizeTopicInput,
  subjectArchiveBlocked,
  toOrgContainsPattern,
  topicArchiveBlocked,
  type CatalogueStatus,
  type SubjectErrors,
  type SubjectInput,
  type SubjectListQuery,
  type TopicErrors,
  type TopicInput,
} from "@/lib/subjects";

/** An examination category (platform lookup: JAMB, WAEC, NECO, Custom…). */
export type ExamCategory = {
  id: string;
  code: string;
  name: string;
};

/** A subject as the app uses it (camelCase). `institutionId: null` = platform. */
export type SubjectRecord = {
  id: string;
  institutionId: string | null;
  name: string;
  code: string | null;
  status: CatalogueStatus;
  isSeed: boolean;
  categoryIds: string[];
  categoryNames: string[];
  /** Active topics visible to this tenant; filled by list/detail reads. */
  topicCount: number;
  createdAt: string;
  updatedAt: string;
};

/** A topic as the app uses it (camelCase). `institutionId: null` = platform. */
export type TopicRecord = {
  id: string;
  subjectId: string;
  institutionId: string | null;
  parentId: string | null;
  name: string;
  status: CatalogueStatus;
  isSeed: boolean;
  /** Active subtopics; filled by the subject-detail read. */
  childCount: number;
  createdAt: string;
  updatedAt: string;
};

type SubjectRow = {
  id: string;
  institution_id: string | null;
  name: string;
  code: string | null;
  status: string;
  is_seed: boolean;
  created_at: string;
  updated_at: string;
};

type TopicRow = {
  id: string;
  subject_id: string;
  institution_id: string | null;
  parent_id: string | null;
  name: string;
  status: string;
  is_seed: boolean;
  created_at: string;
  updated_at: string;
};

/** Cast a DB status string, failing closed to `active` for unknown values. */
function toStatus(value: string): CatalogueStatus {
  return value === "archived" ? "archived" : "active";
}

function toSubject(row: SubjectRow): SubjectRecord {
  return {
    id: row.id,
    institutionId: row.institution_id,
    name: row.name,
    code: row.code,
    status: toStatus(row.status),
    isSeed: row.is_seed,
    categoryIds: [],
    categoryNames: [],
    topicCount: 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTopic(row: TopicRow): TopicRecord {
  return {
    id: row.id,
    subjectId: row.subject_id,
    institutionId: row.institution_id,
    parentId: row.parent_id,
    name: row.name,
    status: toStatus(row.status),
    isSeed: row.is_seed,
    childCount: 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SUBJECT_SELECT =
  "id, institution_id, name, code, status, is_seed, created_at, updated_at";

const TOPIC_SELECT =
  "id, subject_id, institution_id, parent_id, name, status, is_seed, created_at, updated_at";

/** The tenant half of every visibility filter: platform rows ∪ this tenant's. */
function tenantScope(institutionId: string): string {
  // institutionId is the trusted session-derived uuid, never client input.
  return `institution_id.is.null,institution_id.eq.${institutionId}`;
}

// --- Examination categories ---------------------------------------------------

/** Active platform categories, display-ordered — the picker list. The
 *  catalogue is platform-wide, so no tenant filter applies to READS here; the
 *  data layer still validates category ids tenant-side on every WRITE. */
export async function listCategories(): Promise<ExamCategory[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("exam_categories")
    .select("id, code, name")
    .eq("status", "active")
    .order("display_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    code: row.code as string,
    name: row.name as string,
  }));
}

/** Which of the supplied category ids exist as ACTIVE platform rows. */
async function filterKnownCategoryIds(
  candidateIds: string[],
): Promise<Set<string>> {
  const known = new Set<string>();
  if (candidateIds.length === 0) return known;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("exam_categories")
    .select("id")
    .in("id", candidateIds)
    .eq("status", "active");
  if (error) throw error;
  for (const row of data ?? []) known.add(row.id as string);
  return known;
}

/** Category id/name pairs attached to the given subjects (one query). */
async function categoriesForSubjects(
  subjectIds: string[],
): Promise<Map<string, { ids: string[]; names: string[] }>> {
  const result = new Map<string, { ids: string[]; names: string[] }>();
  if (subjectIds.length === 0) return result;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("subject_exam_categories")
    .select("subject_id, category_id, exam_categories(name)")
    .in("subject_id", subjectIds);

  if (error) throw error;
  for (const raw of data ?? []) {
    const row = raw as unknown as {
      subject_id: string;
      category_id: string;
      exam_categories: { name: string } | null;
    };
    const entry = result.get(row.subject_id) ?? { ids: [], names: [] };
    entry.ids.push(row.category_id);
    if (row.exam_categories) entry.names.push(row.exam_categories.name);
    result.set(row.subject_id, entry);
  }
  return result;
}

/** Replace a subject's category links. Ids must already be platform-validated. */
async function replaceSubjectCategories(
  subjectId: string,
  categoryIds: string[],
): Promise<void> {
  const supabase = createAdminClient();

  const { error: deleteError } = await supabase
    .from("subject_exam_categories")
    .delete()
    .eq("subject_id", subjectId);
  if (deleteError) throw deleteError;

  if (categoryIds.length === 0) return;
  const rows = categoryIds.map((category_id) => ({ subject_id: subjectId, category_id }));
  const { error: insertError } = await supabase
    .from("subject_exam_categories")
    .insert(rows);
  if (insertError) throw insertError;
}

// --- Subjects -------------------------------------------------------------------

/** Active topics visible to this tenant under a subject (platform ∪ own). */
async function countActiveTopicsForSubject(
  institutionId: string,
  subjectId: string,
): Promise<number> {
  const supabase = createAdminClient();
  const { count, error } = await supabase
    .from("topics")
    .select("id", { count: "exact", head: true })
    .eq("subject_id", subjectId)
    .eq("status", "active")
    .or(tenantScope(institutionId));
  if (error) throw error;
  return count ?? 0;
}

/** Topic counts per subject, tenant-guarded (each count re-scopes visibility). */
async function topicCountsForSubjects(
  institutionId: string,
  subjectIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (subjectIds.length === 0) return counts;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("topics")
    .select("subject_id")
    .in("subject_id", subjectIds)
    .eq("status", "active")
    .or(tenantScope(institutionId));

  if (error) throw error;
  for (const row of data ?? []) {
    const subjectId = row.subject_id as string;
    counts.set(subjectId, (counts.get(subjectId) ?? 0) + 1);
  }
  return counts;
}

/** List subjects visible to one institution (platform ∪ own) with filters. */
export async function listSubjectsPage(
  institutionId: string,
  query: SubjectListQuery,
): Promise<{ rows: SubjectRecord[]; total: number }> {
  const supabase = createAdminClient();

  let builder = supabase
    .from("subjects")
    .select(SUBJECT_SELECT, { count: "exact" });

  // Origin narrows within the visible scope; it never widens past it.
  if (query.origin === "platform") {
    builder = builder.is("institution_id", null);
  } else if (query.origin === "institution") {
    builder = builder.eq("institution_id", institutionId);
  } else {
    builder = builder.or(tenantScope(institutionId));
  }

  if (query.q) {
    const pattern = toOrgContainsPattern(query.q);
    if (pattern) builder = builder.ilike("name", pattern);
  }
  if (query.status) {
    builder = builder.eq("status", query.status);
  }
  if (query.categoryId) {
    // Resolve the join side first, then constrain to visible subjects — a
    // category planted with another tenant's subject ids can only ever yield
    // subjects this caller can see, because the outer scope filter stays on.
    const linkSupabase = createAdminClient();
    const { data: links, error: linkError } = await linkSupabase
      .from("subject_exam_categories")
      .select("subject_id")
      .eq("category_id", query.categoryId);
    if (linkError) throw linkError;
    const subjectIds = [...new Set((links ?? []).map((row) => row.subject_id as string))];
    if (subjectIds.length === 0) return { rows: [], total: 0 };
    builder = builder.in("id", subjectIds);
  }

  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  const { data, error, count } = await builder
    .order("name", { ascending: true })
    .range(from, to);

  if (error) throw error;

  const rows = (data ?? []).map((row) => toSubject(row as unknown as SubjectRow));
  const ids = rows.map((row) => row.id);
  const [categories, topicCounts] = await Promise.all([
    categoriesForSubjects(ids),
    topicCountsForSubjects(institutionId, ids),
  ]);
  for (const row of rows) {
    const entry = categories.get(row.id);
    row.categoryIds = entry?.ids ?? [];
    row.categoryNames = entry?.names ?? [];
    row.topicCount = topicCounts.get(row.id) ?? 0;
  }

  return { rows, total: count ?? 0 };
}

/**
 * Fetch one VISIBLE subject (platform or own), tenant-scoped. `null` means
 * absent OR another institution's — the caller renders "not found" and
 * existence is never leaked.
 */
export async function getSubject(
  institutionId: string,
  id: string,
): Promise<SubjectRecord | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("subjects")
    .select(SUBJECT_SELECT)
    .eq("id", id)
    .or(tenantScope(institutionId))
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const record = toSubject(data as unknown as SubjectRow);
  const [categories, topicCounts] = await Promise.all([
    categoriesForSubjects([record.id]),
    topicCountsForSubjects(institutionId, [record.id]),
  ]);
  const entry = categories.get(record.id);
  record.categoryIds = entry?.ids ?? [];
  record.categoryNames = entry?.names ?? [];
  record.topicCount = topicCounts.get(record.id) ?? 0;
  return record;
}

/**
 * Fetch one subject for a WRITE: only the tenant's OWN rows resolve — a
 * platform id (or another tenant's) yields `null`, so edits, renames and
 * archive flips can never reach shared or foreign content.
 */
export async function getSubjectForWrite(
  institutionId: string,
  id: string,
): Promise<SubjectRecord | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("subjects")
    .select(SUBJECT_SELECT)
    .eq("id", id)
    .eq("institution_id", institutionId)
    .maybeSingle();

  if (error) throw error;
  return data ? toSubject(data as unknown as SubjectRow) : null;
}

/** Whether a subject id is visible (platform or own) to this tenant. */
export async function subjectIsVisible(
  institutionId: string,
  subjectId: string,
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("subjects")
    .select("id")
    .eq("id", subjectId)
    .or(tenantScope(institutionId))
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** Whether a subject is visible AND still `active` — the picker guard for
 *  question/exam workflows (prompts 15–18). Archived subjects stay readable
 *  for history but are never newly selectable. */
export async function subjectIsSelectable(
  institutionId: string,
  subjectId: string,
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("subjects")
    .select("id")
    .eq("id", subjectId)
    .eq("status", "active")
    .or(tenantScope(institutionId))
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** Map a name clash (23505) to the field the admin can fix. Uniqueness is
 *  per-scope, so a live clash can only be with another row in THIS tenant. */
function subjectNameConflict(error: { code?: string }): SubjectErrors | null {
  if (error.code !== "23505") return null;
  return {
    name: "Your institution already has an active subject with that name.",
  };
}

/**
 * Insert an institution-owned subject. The tenant id is forced onto the row
 * from the trusted principal, so a crafted payload can never create (or
 * spoof) platform-catalogue content. Category ids are validated against the
 * active platform lookup before any write.
 */
export async function createSubject(
  institutionId: string,
  input: SubjectInput,
): Promise<{ ok: true; id: string } | { ok: false; errors: SubjectErrors }> {
  const clean = normalizeSubjectInput(input);

  const known = await filterKnownCategoryIds(clean.categoryIds);
  if (clean.categoryIds.some((id) => !known.has(id))) {
    return {
      ok: false,
      errors: { categoryIds: "Choose one of the available exam categories." },
    };
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("subjects")
    .insert({
      institution_id: institutionId,
      name: clean.name,
      code: clean.code || null,
      status: "active",
      is_seed: false,
    })
    .select("id")
    .single();

  if (error) {
    const fieldErrors = subjectNameConflict(error);
    if (fieldErrors) return { ok: false, errors: fieldErrors };
    throw error;
  }
  const id = (data as { id: string }).id;
  await replaceSubjectCategories(id, clean.categoryIds);
  return { ok: true, id };
}

/**
 * Update an institution-owned subject (name, code, categories). Platform rows
 * and other tenants' rows do not resolve through `getSubjectForWrite`, so the
 * write is scoped before it happens; keeping a subject's own current name is
 * always allowed even when the platform catalogue carries the same label.
 */
export async function updateSubject(
  institutionId: string,
  id: string,
  input: SubjectInput,
): Promise<{ ok: true; id: string } | { ok: false; errors: SubjectErrors }> {
  const clean = normalizeSubjectInput(input);
  const current = await getSubjectForWrite(institutionId, id);
  if (!current) return { ok: false, errors: {} };

  const known = await filterKnownCategoryIds(clean.categoryIds);
  if (clean.categoryIds.some((id) => !known.has(id))) {
    return {
      ok: false,
      errors: { categoryIds: "Choose one of the available exam categories." },
    };
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("subjects")
    .update({ name: clean.name, code: clean.code || null })
    .eq("id", id)
    .eq("institution_id", institutionId)
    .select("id")
    .maybeSingle();

  if (error) {
    const fieldErrors = subjectNameConflict(error);
    if (fieldErrors) return { ok: false, errors: fieldErrors };
    throw error;
  }
  if (!data) return { ok: false, errors: {} };

  await replaceSubjectCategories(id, clean.categoryIds);
  return { ok: true, id };
}

/**
 * Archive or restore an institution-owned subject — the non-destructive
 * removal (AGENTS.md §6). Refused while ACTIVE topics are still visible under
 * it, so a retired subject never strands a live catalogue branch. Nothing is
 * ever deleted, so future questions/exams/results keep resolving.
 */
export async function setSubjectStatus(
  institutionId: string,
  id: string,
  status: CatalogueStatus,
): Promise<
  | { ok: true }
  | { ok: false; reason: "notFound" }
  | { ok: false; reason: "topicsAttached"; attached: number }
> {
  const record = await getSubjectForWrite(institutionId, id);
  if (!record) return { ok: false, reason: "notFound" };

  if (status === "archived") {
    const attached = await countActiveTopicsForSubject(institutionId, id);
    const blocked = subjectArchiveBlocked({ activeTopics: attached });
    if (blocked) return { ok: false, reason: "topicsAttached", attached };
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("subjects")
    .update({ status })
    .eq("id", id)
    .eq("institution_id", institutionId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return data ? { ok: true } : { ok: false, reason: "notFound" };
}

// --- Topics -----------------------------------------------------------------------

/**
 * Visible topics of one subject (platform ∪ own), parents first then name.
 * The subject itself must be visible, or nothing is returned.
 */
export async function listTopicsForSubject(
  institutionId: string,
  subjectId: string,
): Promise<TopicRecord[]> {
  if (!(await subjectIsVisible(institutionId, subjectId))) return [];

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("topics")
    .select(TOPIC_SELECT)
    .eq("subject_id", subjectId)
    .or(tenantScope(institutionId))
    .order("parent_id", { ascending: true, nullsFirst: true })
    .order("name", { ascending: true });

  if (error) throw error;
  const rows = (data ?? []).map((row) => toTopic(row as unknown as TopicRow));

  const childCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.parentId) childCounts.set(row.parentId, (childCounts.get(row.parentId) ?? 0) + 1);
  }
  for (const row of rows) {
    row.childCount = childCounts.get(row.id) ?? 0;
  }
  return rows;
}

/** Fetch one VISIBLE topic (platform or own); `null` never leaks existence. */
export async function getTopic(
  institutionId: string,
  id: string,
): Promise<TopicRecord | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("topics")
    .select(TOPIC_SELECT)
    .eq("id", id)
    .or(tenantScope(institutionId))
    .maybeSingle();

  if (error) throw error;
  return data ? toTopic(data as unknown as TopicRow) : null;
}

/** Fetch one topic for a WRITE: only the tenant's OWN rows resolve. */
export async function getTopicForWrite(
  institutionId: string,
  id: string,
): Promise<TopicRecord | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("topics")
    .select(TOPIC_SELECT)
    .eq("id", id)
    .eq("institution_id", institutionId)
    .maybeSingle();

  if (error) throw error;
  return data ? toTopic(data as unknown as TopicRow) : null;
}

/** Map a per-subject name clash (23505) to the field the admin can fix.
 *  Uniqueness is per-scope, so a live clash can only be with another topic
 *  this tenant already placed under the same subject. */
function topicNameConflict(error: { code?: string }): TopicErrors | null {
  if (error.code !== "23505") return null;
  return {
    name: "Your institution already has an active topic with that name under this subject.",
  };
}

/**
 * Insert an institution-owned topic under a VISIBLE, ACTIVE subject. A parent
 * (for a subtopic) must be visible, in the SAME subject, active, and itself
 * top-level — the one-level depth rule the DB trigger also enforces is
 * checked here first so the user gets a field error, not a 500. An archived
 * subject is retired for history only, so new topics are refused server-side
 * (not just hidden in the UI) — AGENTS.md §5, §6.
 */
export async function createTopic(
  institutionId: string,
  input: TopicInput,
): Promise<{ ok: true; id: string } | { ok: false; errors: TopicErrors }> {
  const clean = normalizeTopicInput(input);

  if (!(await subjectIsSelectable(institutionId, clean.subjectId))) {
    return { ok: false, errors: { subjectId: "Choose an active subject." } };
  }

  if (clean.parentId) {
    const parent = await getTopic(institutionId, clean.parentId);
    if (!parent || parent.subjectId !== clean.subjectId) {
      return {
        ok: false,
        errors: { parentId: "Choose a topic from this subject, or none." },
      };
    }
    if (parent.parentId || parent.status !== "active") {
      return {
        ok: false,
        errors: { parentId: "Subtopics must sit directly under an active top-level topic." },
      };
    }
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("topics")
    .insert({
      subject_id: clean.subjectId,
      institution_id: institutionId,
      parent_id: clean.parentId || null,
      name: clean.name,
      status: "active",
      is_seed: false,
    })
    .select("id")
    .single();

  if (error) {
    const fieldErrors = topicNameConflict(error);
    if (fieldErrors) return { ok: false, errors: fieldErrors };
    throw error;
  }
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * Rename an institution-owned topic. The subject and parent links are NOT
 * editable: moving a topic between subjects or hierarchies would silently
 * re-cut every future topic-level statistic, so history stays anchored to the
 * row's original relationships (AGENTS.md §6).
 */
export async function updateTopic(
  institutionId: string,
  id: string,
  input: TopicInput,
): Promise<{ ok: true; id: string } | { ok: false; errors: TopicErrors }> {
  const clean = normalizeTopicInput(input);
  const current = await getTopicForWrite(institutionId, id);
  if (!current) return { ok: false, errors: {} };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("topics")
    .update({ name: clean.name })
    .eq("id", id)
    .eq("institution_id", institutionId)
    .select("id")
    .maybeSingle();

  if (error) {
    const fieldErrors = topicNameConflict(error);
    if (fieldErrors) return { ok: false, errors: fieldErrors };
    throw error;
  }
  if (!data) return { ok: false, errors: {} };
  return { ok: true, id };
}

/**
 * Archive or restore an institution-owned topic. Refused while ACTIVE
 * subtopics are still attached, so a retired topic never strands a live
 * branch. Nothing is deleted — historical results keep resolving this id.
 */
export async function setTopicStatus(
  institutionId: string,
  id: string,
  status: CatalogueStatus,
): Promise<
  | { ok: true }
  | { ok: false; reason: "notFound" }
  | { ok: false; reason: "subtopicsAttached"; attached: number }
> {
  const record = await getTopicForWrite(institutionId, id);
  if (!record) return { ok: false, reason: "notFound" };

  if (status === "archived") {
    const supabase = createAdminClient();
    const { count, error } = await supabase
      .from("topics")
      .select("id", { count: "exact", head: true })
      .eq("parent_id", id)
      .eq("status", "active")
      .or(tenantScope(institutionId));
    if (error) throw error;
    const attached = count ?? 0;
    if (topicArchiveBlocked({ activeChildTopics: attached })) {
      return { ok: false, reason: "subtopicsAttached", attached };
    }
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("topics")
    .update({ status })
    .eq("id", id)
    .eq("institution_id", institutionId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return data ? { ok: true } : { ok: false, reason: "notFound" };
}

/**
 * Whether a topic id is visible AND active to this tenant — the picker guard
 * question/exam workflows (prompts 15–18) will apply to topic selections.
 */
export async function topicIsSelectable(
  institutionId: string,
  topicId: string,
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("topics")
    .select("id")
    .eq("id", topicId)
    .eq("status", "active")
    .or(tenantScope(institutionId))
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}
