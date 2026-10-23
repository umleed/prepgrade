/**
 * Question bank data access — SERVER-ONLY.
 *
 * Every function takes the trusted `institutionId` (resolved from the session
 * via `AuthPrincipal`, NEVER from a request body or query param) and applies it
 * as a hard filter to both reads and writes — the same tenant-isolation
 * contract as lib/data/students.ts, teachers.ts, classes.ts and subjects.ts
 * (AGENTS.md §5). The service-role client bypasses RLS, so the
 * `.eq("institution_id", …)` filters here are what isolate tenants.
 *
 * TENANT-OWNED ONLY (0006_questions.sql)
 * Unlike the subject/topic catalogue there is no platform question scope:
 * every row belongs to exactly one institution, so reads and writes share one
 * filter and "writable scope" equals "visible scope". The subject/topic a
 * question is filed under may still be PLATFORM rows (the catalogue is
 * shared) — `subjectIsSelectable` / `topicIsSelectable` from the subjects
 * layer resolve that visibility, and every id is checked before it reaches a
 * row. That check is load-bearing — the FK alone proves existence, not access.
 *
 * ANSWER-KEY SAFETY (AGENTS.md §6)
 * `correct_option_index` is read and written here, but every consumer is a
 * server component behind a `question.manage` role guard. Nothing in this
 * module is reachable from a client bundle.
 *
 * ARCHIVE INSTEAD OF DELETE (AGENTS.md §6)
 * Exams and results (prompts 17–25) will reference these ids, so nothing here
 * deletes. `setQuestionStatus` flips active ⇄ archived; archived questions
 * stay readable for history but are refused by the selectable check the exam
 * builder (prompt 18) will use.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import {
  normalizeQuestionInput,
  questionMeaningChanged,
  toOrgContainsPattern,
  type QuestionInput,
  type QuestionListQuery,
  type QuestionStatus,
} from "@/lib/questions";
import { questionDedupeKey } from "@/lib/question-import";
import {
  subjectIsSelectable,
  topicIsSelectable,
  getTopic,
  listCategories,
} from "@/lib/data/subjects";

/** A question as the app uses it (camelCase). Options are plain strings. */
export type QuestionRecord = {
  id: string;
  institutionId: string;
  createdBy: string;
  questionType: string;
  difficulty: string;
  subjectId: string;
  topicId: string | null;
  categoryId: string | null;
  questionText: string;
  options: string[];
  correctOptionIndex: number;
  explanation: string;
  marks: number;
  learningObjective: string;
  provenance: string;
  sourceLabel: string;
  sourceYear: string;
  licenseNotes: string;
  status: QuestionStatus;
  createdAt: string;
  updatedAt: string;
  /** Filled by list/detail reads for display; never trusted from input. */
  subjectName: string;
  topicName: string | null;
  categoryName: string | null;
};

type QuestionRow = {
  id: string;
  institution_id: string;
  created_by: string;
  question_type: string;
  difficulty: string;
  subject_id: string;
  topic_id: string | null;
  exam_category_id: string | null;
  question_text: string;
  options: unknown;
  correct_option_index: number;
  explanation: string | null;
  marks: number;
  learning_objective: string | null;
  provenance: string;
  source_label: string | null;
  source_year: number | null;
  license_notes: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

const QUESTION_SELECT =
  "id, institution_id, created_by, question_type, difficulty, subject_id, topic_id, exam_category_id, question_text, options, correct_option_index, explanation, marks, learning_objective, provenance, source_label, source_year, license_notes, status, created_at, updated_at";

/** Cast a DB status string, failing closed to `active` for unknown values. */
function toStatus(value: string): QuestionStatus {
  return value === "archived" ? "archived" : "active";
}

/**
 * Parse the jsonb options column defensively: only an array of strings (the
 * shape the data layer writes) survives; anything else yields empty options,
 * which the UI renders as a content problem rather than crashing.
 */
function toOptions(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toQuestion(row: QuestionRow): QuestionRecord {
  return {
    id: row.id,
    institutionId: row.institution_id,
    createdBy: row.created_by,
    questionType: row.question_type,
    difficulty: row.difficulty,
    subjectId: row.subject_id,
    topicId: row.topic_id,
    categoryId: row.exam_category_id,
    questionText: row.question_text,
    options: toOptions(row.options),
    correctOptionIndex: row.correct_option_index,
    explanation: row.explanation ?? "",
    marks: row.marks,
    learningObjective: row.learning_objective ?? "",
    provenance: row.provenance,
    sourceLabel: row.source_label ?? "",
    sourceYear: row.source_year === null ? "" : String(row.source_year),
    licenseNotes: row.license_notes ?? "",
    status: toStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subjectName: "",
    topicName: null,
    categoryName: null,
  };
}

/** Row → insert/update payload; "" optional columns become NULL. */
function toPayload(clean: QuestionInput) {
  return {
    question_type: clean.questionType,
    difficulty: clean.difficulty,
    subject_id: clean.subjectId,
    topic_id: clean.topicId || null,
    exam_category_id: clean.categoryId || null,
    question_text: clean.questionText,
    options: clean.options,
    correct_option_index: clean.correctOptionIndex,
    explanation: clean.explanation || null,
    marks: clean.marks,
    learning_objective: clean.learningObjective || null,
    provenance: clean.provenance,
    source_label: clean.sourceLabel || null,
    source_year: clean.sourceYear ? Number.parseInt(clean.sourceYear, 10) : null,
    license_notes: clean.licenseNotes || null,
  };
}

/**
 * Shared write validation: the subject must be visible AND active, the topic
 * (when set) visible, active AND under that subject, and the category (when
 * set) an active platform row. Field errors, never exceptions.
 */
async function linkErrorsFor(
  institutionId: string,
  clean: QuestionInput,
): Promise<Partial<Pick<QuestionInput, "subjectId" | "topicId" | "categoryId">>> {
  if (!(await subjectIsSelectable(institutionId, clean.subjectId))) {
    return { subjectId: "Choose an active subject." };
  }

  if (clean.topicId) {
    const topic = await getTopic(institutionId, clean.topicId);
    if (!topic || topic.subjectId !== clean.subjectId) {
      return { topicId: "Choose a topic from the same subject, or none." };
    }
    if (!(await topicIsSelectable(institutionId, clean.topicId))) {
      return { topicId: "Choose an active topic, or none." };
    }
  }

  if (clean.categoryId) {
    const categories = await listCategories();
    if (!categories.some((category) => category.id === clean.categoryId)) {
      return { categoryId: "Choose one of the available exam categories." };
    }
  }

  return {};
}

/** Attach display names for subject/topic/category (one small read each). */
async function fillNames(
  institutionId: string,
  records: QuestionRecord[],
): Promise<void> {
  if (records.length === 0) return;

  const supabase = createAdminClient();
  const subjectIds = [...new Set(records.map((row) => row.subjectId))];
  const topicIds = [...new Set(records.map((row) => row.topicId).filter((id): id is string => Boolean(id)))];
  const categoryIds = [...new Set(records.map((row) => row.categoryId).filter((id): id is string => Boolean(id)))];

  const [subjects, topics, categories] = await Promise.all([
    supabase.from("subjects").select("id, name").in("id", subjectIds),
    topicIds.length > 0
      ? supabase.from("topics").select("id, name").in("id", topicIds)
      : Promise.resolve({ data: [], error: null }),
    categoryIds.length > 0
      ? supabase.from("exam_categories").select("id, name").in("id", categoryIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (subjects.error) throw subjects.error;
  if (topics.error) throw topics.error;
  if (categories.error) throw categories.error;

  const subjectNames = new Map<string, string>(
    (subjects.data ?? []).map((row) => [row.id as string, row.name as string]),
  );
  const topicNames = new Map<string, string>(
    (topics.data ?? []).map((row) => [row.id as string, row.name as string]),
  );
  const categoryNames = new Map<string, string>(
    (categories.data ?? []).map((row) => [row.id as string, row.name as string]),
  );

  for (const record of records) {
    record.subjectName = subjectNames.get(record.subjectId) ?? "—";
    record.topicName = record.topicId ? topicNames.get(record.topicId) ?? "—" : null;
    record.categoryName = record.categoryId ? categoryNames.get(record.categoryId) ?? null : null;
  }
}

// --- Reads -----------------------------------------------------------------------

/** List this institution's questions with filters, newest first, paginated. */
export async function listQuestionsPage(
  institutionId: string,
  query: QuestionListQuery,
  currentUserId: string,
): Promise<{ rows: QuestionRecord[]; total: number }> {
  const supabase = createAdminClient();

  let builder = supabase
    .from("questions")
    .select(QUESTION_SELECT, { count: "exact" })
    .eq("institution_id", institutionId);

  if (query.q) {
    const pattern = toOrgContainsPattern(query.q);
    if (pattern) builder = builder.ilike("question_text", pattern);
  }
  if (query.subjectId) builder = builder.eq("subject_id", query.subjectId);
  if (query.topicId) builder = builder.eq("topic_id", query.topicId);
  if (query.difficulty) builder = builder.eq("difficulty", query.difficulty);
  if (query.status) builder = builder.eq("status", query.status);
  if (query.mine) builder = builder.eq("created_by", currentUserId);

  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  const { data, error, count } = await builder
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) throw error;

  const rows = (data ?? []).map((row) => toQuestion(row as unknown as QuestionRow));
  await fillNames(institutionId, rows);
  return { rows, total: count ?? 0 };
}

/**
 * Fetch one question of THIS institution. `null` means absent OR another
 * institution's — existence is never leaked (AGENTS.md §5).
 */
export async function getQuestion(
  institutionId: string,
  id: string,
): Promise<QuestionRecord | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("questions")
    .select(QUESTION_SELECT)
    .eq("id", id)
    .eq("institution_id", institutionId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const record = toQuestion(data as unknown as QuestionRow);
  await fillNames(institutionId, [record]);
  return record;
}

export type QuestionBankStats = {
  /** Active questions in the bank. */
  total: number;
  /** Active questions authored by the current user. */
  mine: number;
  /** Distinct active subjects the bank's live questions are filed under. */
  subjectsCovered: number;
};

/** Headline counts for the bank overview cards (active rows only). */
export async function getBankStats(
  institutionId: string,
  currentUserId: string,
): Promise<QuestionBankStats> {
  const supabase = createAdminClient();

  const [total, mine, subjectRows] = await Promise.all([
    supabase
      .from("questions")
      .select("id", { count: "exact", head: true })
      .eq("institution_id", institutionId)
      .eq("status", "active"),
    supabase
      .from("questions")
      .select("id", { count: "exact", head: true })
      .eq("institution_id", institutionId)
      .eq("status", "active")
      .eq("created_by", currentUserId),
    supabase
      .from("questions")
      .select("subject_id")
      .eq("institution_id", institutionId)
      .eq("status", "active"),
  ]);

  if (total.error) throw total.error;
  if (mine.error) throw mine.error;
  if (subjectRows.error) throw subjectRows.error;

  return {
    total: total.count ?? 0,
    mine: mine.count ?? 0,
    subjectsCovered: new Set((subjectRows.data ?? []).map((row) => row.subject_id as string)).size,
  };
}

/** One entry of the bank's Subjects & Topics navigation tree. */
export type SubjectFacet = {
  id: string;
  name: string;
  questionCount: number;
  topics: { id: string; name: string; parentId: string | null; questionCount: number }[];
};

/**
 * The left-hand navigation tree: visible ACTIVE subjects (platform ∪ own)
 * with live question counts, and — when a subject is selected — its visible
 * active topics/subtopics with counts. Counts only ever include THIS
 * institution's active questions, so the tree never leaks another tenant's
 * content volumes.
 */
export async function getSubjectFacet(
  institutionId: string,
  selectedSubjectId: string,
): Promise<SubjectFacet[]> {
  const supabase = createAdminClient();

  const scope = `institution_id.is.null,institution_id.eq.${institutionId}`;

  const [subjectsRes, countsRes] = await Promise.all([
    supabase
      .from("subjects")
      .select("id, name")
      .eq("status", "active")
      .or(scope)
      .order("name", { ascending: true }),
    supabase
      .from("questions")
      .select("subject_id, topic_id")
      .eq("institution_id", institutionId)
      .eq("status", "active"),
  ]);

  if (subjectsRes.error) throw subjectsRes.error;
  if (countsRes.error) throw countsRes.error;

  const subjectCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  for (const row of countsRes.data ?? []) {
    const subjectId = row.subject_id as string;
    subjectCounts.set(subjectId, (subjectCounts.get(subjectId) ?? 0) + 1);
    if (row.topic_id) {
      const topicId = row.topic_id as string;
      topicCounts.set(topicId, (topicCounts.get(topicId) ?? 0) + 1);
    }
  }

  const facets: SubjectFacet[] = (subjectsRes.data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    questionCount: subjectCounts.get(row.id as string) ?? 0,
    topics: [],
  }));

  // Topics are only worth fetching for the opened branch.
  if (selectedSubjectId && facets.some((facet) => facet.id === selectedSubjectId)) {
    const topicsRes = await supabase
      .from("topics")
      .select("id, name, parent_id")
      .eq("subject_id", selectedSubjectId)
      .eq("status", "active")
      .or(scope)
      .order("name", { ascending: true });

    if (topicsRes.error) throw topicsRes.error;
    const facet = facets.find((entry) => entry.id === selectedSubjectId);
    if (facet) {
      facet.topics = (topicsRes.data ?? []).map((row) => ({
        id: row.id as string,
        name: row.name as string,
        parentId: row.parent_id as string | null,
        questionCount: topicCounts.get(row.id as string) ?? 0,
      }));
    }
  }

  return facets;
}

/**
 * All visible ACTIVE topics (platform ∪ own) with their subject link — the
 * authoring form's topic picker. The form filters these by the chosen subject
 * client-side; the server re-validates the same-subject rule on write, so a
 * tampered selection can never file a question under a foreign/mismatched
 * topic (AGENTS.md §5).
 */
export async function listSelectableTopics(
  institutionId: string,
): Promise<
  { id: string; name: string; subjectId: string; parentId: string | null }[]
> {
  const supabase = createAdminClient();
  const scope = `institution_id.is.null,institution_id.eq.${institutionId}`;

  const { data, error } = await supabase
    .from("topics")
    .select("id, name, subject_id, parent_id")
    .eq("status", "active")
    .or(scope)
    .order("name", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    subjectId: row.subject_id as string,
    parentId: row.parent_id as string | null,
  }));
}

/**
 * Everything the authoring form needs to offer valid picker choices for one
 * tenant: active visible subjects, active visible topics/subtopics (with their
 * subject link), and the active platform categories. A single call so the
 * new/edit pages stay thin; failures propagate to the page's honest error
 * state rather than a partially-filled form.
 */
export async function getQuestionFormOptions(institutionId: string): Promise<{
  subjects: { id: string; name: string }[];
  topics: { id: string; name: string; subjectId: string; parentId: string | null }[];
  categories: { id: string; name: string }[];
}> {
  const supabase = createAdminClient();
  const scope = `institution_id.is.null,institution_id.eq.${institutionId}`;

  const [subjectsRes, topics, categoriesRes] = await Promise.all([
    supabase
      .from("subjects")
      .select("id, name")
      .eq("status", "active")
      .or(scope)
      .order("name", { ascending: true }),
    listSelectableTopics(institutionId),
    listCategories(),
  ]);

  if (subjectsRes.error) throw subjectsRes.error;

  return {
    subjects: (subjectsRes.data ?? []).map((row) => ({
      id: row.id as string,
      name: row.name as string,
    })),
    topics,
    categories: categoriesRes.map((category) => ({
      id: category.id,
      name: category.name,
    })),
  };
}

// --- Writes ------------------------------------------------------------------------

export type QuestionWriteErrors = Partial<
  Record<
    | "subjectId"
    | "topicId"
    | "categoryId"
    | "questionText"
    | "options"
    | "correctOptionIndex"
    | "difficulty"
    | "questionType"
    | "marks"
    | "explanation"
    | "learningObjective"
    | "provenance"
    | "sourceLabel"
    | "sourceYear"
    | "licenseNotes",
    string
  >
>;

export type QuestionWriteResult =
  | { ok: true; id: string }
  | { ok: false; errors: QuestionWriteErrors };

/**
 * Insert an institution-owned question. The tenant id and `created_by` come
 * from the trusted principal, so a crafted payload can never author content in
 * another tenant or spoof authorship. Link ids (subject/topic/category) are
 * validated against the caller's tenant BEFORE any write — the load-bearing
 * check the FKs cannot make.
 */
export async function createQuestion(
  institutionId: string,
  userId: string,
  input: QuestionInput,
): Promise<QuestionWriteResult> {
  const clean = normalizeQuestionInput(input);

  const linkErrors = await linkErrorsFor(institutionId, clean);
  if (Object.keys(linkErrors).length > 0) return { ok: false, errors: linkErrors };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("questions")
    .insert({
      ...toPayload(clean),
      institution_id: institutionId,
      created_by: userId,
      status: "active",
    })
    .select("id")
    .single();

  if (error) throw error;
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * Case/space-insensitive keys of this tenant's ACTIVE question texts, used by
 * the import flow (prompt 34) to skip rows that already exist rather than
 * re-import them. Only THIS institution's rows are read, so one tenant never
 * sees — or is deduplicated against — another's content (AGENTS.md §5).
 */
export async function getActiveQuestionKeys(institutionId: string): Promise<Set<string>> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("questions")
    .select("question_text")
    .eq("institution_id", institutionId)
    .eq("status", "active");

  if (error) throw error;
  return new Set(
    (data ?? [])
      .map((row) => questionDedupeKey((row.question_text as string) ?? ""))
      .filter((key) => key !== ""),
  );
}

/** One imported row's fate, reported back for the success/skipped summary. */
export type ImportOutcomeRow = { line: number; reason: string };

export type ImportResult = {
  imported: number;
  skipped: ImportOutcomeRow[];
};

/**
 * Write a batch of already-resolved question payloads for ONE tenant
 * (prompt 34). Each row goes through the SAME `createQuestion` path the author
 * form uses — so normalisation, structural rules, the subject/topic/category
 * visibility re-check, and the trusted tenant/author ids are applied per row
 * with no duplicated logic. The caller (a server action) supplies `input`s
 * whose subject/topic/category ids it resolved from the tenant's OWN
 * catalogue; nothing here trusts a client-supplied id or institution.
 *
 * A row that fails validation, does not resolve under this tenant, or
 * duplicates a question already imported in THIS run is skipped and reported
 * rather than aborting the whole batch — the preview already gave the user the
 * chance to fix rows, and a partial import beats a lost one.
 */
export async function importQuestions(
  institutionId: string,
  userId: string,
  rows: { line: number; input: QuestionInput }[],
  existingKeys: Set<string>,
): Promise<ImportResult> {
  const seen = new Set(existingKeys);
  let imported = 0;
  const skipped: ImportOutcomeRow[] = [];

  for (const row of rows) {
    const clean = normalizeQuestionInput(row.input);
    const key = questionDedupeKey(clean.questionText);

    if (key && seen.has(key)) {
      skipped.push({ line: row.line, reason: "A question with this text already exists." });
      continue;
    }

    const result = await createQuestion(institutionId, userId, row.input);
    if (result.ok) {
      imported += 1;
      if (key) seen.add(key);
      continue;
    }

    const messages = Object.values(result.errors).filter(Boolean);
    skipped.push({
      line: row.line,
      reason: messages[0] ?? "This row could not be saved.",
    });
  }

  return { imported, skipped };
}

/**
 * Archive the CURRENT content as a version snapshot before a meaning-changing
 * edit (prompt 16, AGENTS.md §6). Versions are 1-based per question and the
 * table is append-only by grant, so a concurrent conflicting edit surfaces as
 * a unique-violation (thrown — never silently swallowed) rather than
 * overwriting history. Metadata-only edits skip this entirely: they cannot
 * change what a student answered or how it was scored.
 */
async function archiveQuestionVersion(
  institutionId: string,
  current: QuestionRecord,
  editedBy: string,
): Promise<void> {
  const supabase = createAdminClient();

  const { data: latest, error: latestError } = await supabase
    .from("question_versions")
    .select("version")
    .eq("question_id", current.id)
    .eq("institution_id", institutionId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestError) throw latestError;

  const nextVersion =
    (typeof latest?.version === "number" ? latest.version : 0) + 1;

  const { error: insertError } = await supabase.from("question_versions").insert({
    question_id: current.id,
    institution_id: institutionId,
    version: nextVersion,
    question_type: current.questionType,
    difficulty: current.difficulty,
    subject_id: current.subjectId,
    topic_id: current.topicId,
    exam_category_id: current.categoryId,
    question_text: current.questionText,
    options: current.options,
    correct_option_index: current.correctOptionIndex,
    explanation: current.explanation || null,
    marks: current.marks,
    learning_objective: current.learningObjective || null,
    provenance: current.provenance,
    source_label: current.sourceLabel || null,
    source_year: current.sourceYear ? Number.parseInt(current.sourceYear, 10) : null,
    license_notes: current.licenseNotes || null,
    authored_by: current.createdBy,
    edited_by: editedBy,
  });

  if (insertError) throw insertError;
}

/**
 * Update an institution-owned question. The row is re-read under the caller's
 * tenant first, and the write carries the same `.eq("institution_id", …)`
 * filter, so a foreign or vanished id updates nothing. When the edit changes
 * the question's MEANING (text, options, answer key, marks, type) the
 * pre-edit content is archived as a version snapshot first, so nothing a
 * student may already have answered is silently overwritten (prompt 16).
 * `editedBy` must be the trusted session user id — never a client value.
 */
export async function updateQuestion(
  institutionId: string,
  id: string,
  input: QuestionInput,
  editedBy: string,
): Promise<QuestionWriteResult> {
  const clean = normalizeQuestionInput(input);

  const current = await getQuestion(institutionId, id);
  if (!current) return { ok: false, errors: {} };

  const linkErrors = await linkErrorsFor(institutionId, clean);
  if (Object.keys(linkErrors).length > 0) return { ok: false, errors: linkErrors };

  if (questionMeaningChanged(current, clean)) {
    await archiveQuestionVersion(institutionId, current, editedBy);
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("questions")
    .update(toPayload(clean))
    .eq("id", id)
    .eq("institution_id", institutionId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, errors: {} };
  return { ok: true, id };
}

/**
 * Archive or restore an institution-owned question — the non-destructive
 * removal (AGENTS.md §6). Nothing is deleted, so future exam snapshots and
 * results keep resolving this id. Restoring returns it to pickers and the
 * default listing.
 */
export async function setQuestionStatus(
  institutionId: string,
  id: string,
  status: QuestionStatus,
): Promise<{ ok: true } | { ok: false; reason: "notFound" }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("questions")
    .update({ status })
    .eq("id", id)
    .eq("institution_id", institutionId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return data ? { ok: true } : { ok: false, reason: "notFound" };
}

/**
 * Whether a question id exists, is ACTIVE, and belongs to this institution —
 * the picker guard the exam builder (prompt 18) will apply to selections.
 */
export async function questionIsSelectable(
  institutionId: string,
  questionId: string,
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("questions")
    .select("id")
    .eq("id", questionId)
    .eq("institution_id", institutionId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

// --- Version history (prompt 16) ------------------------------------------------

/** One archived snapshot of content a meaning-changing edit replaced. */
export type QuestionVersionRecord = {
  id: string;
  questionId: string;
  version: number;
  questionText: string;
  options: string[];
  correctOptionIndex: number;
  marks: number;
  difficulty: string;
  /** Clerk id of the author of the archived content. */
  authoredBy: string;
  /** Clerk id of the user whose edit caused this snapshot. */
  editedBy: string;
  createdAt: string;
};

const QUESTION_VERSION_SELECT =
  "id, question_id, version, question_text, options, correct_option_index, marks, difficulty, authored_by, edited_by, created_at";

type QuestionVersionRow = {
  id: string;
  question_id: string;
  version: number;
  question_text: string;
  options: unknown;
  correct_option_index: number;
  marks: number;
  difficulty: string;
  authored_by: string;
  edited_by: string;
  created_at: string;
};

/**
 * The archived edit history of one question of THIS tenant, newest snapshot
 * first. Scoped by institution_id like every other query here; consumers are
 * server components behind the question.manage role guard, so the archived
 * answer keys in these rows never reach students (AGENTS.md §6).
 */
export async function listQuestionVersions(
  institutionId: string,
  questionId: string,
): Promise<QuestionVersionRecord[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("question_versions")
    .select(QUESTION_VERSION_SELECT)
    .eq("question_id", questionId)
    .eq("institution_id", institutionId)
    .order("version", { ascending: false });

  if (error) throw error;
  return (data ?? []).map((row) => {
    const typed = row as unknown as QuestionVersionRow;
    return {
      id: typed.id,
      questionId: typed.question_id,
      version: typed.version,
      questionText: typed.question_text,
      options: toOptions(typed.options),
      correctOptionIndex: typed.correct_option_index,
      marks: typed.marks,
      difficulty: typed.difficulty,
      authoredBy: typed.authored_by,
      editedBy: typed.edited_by,
      createdAt: typed.created_at,
    };
  });
}
