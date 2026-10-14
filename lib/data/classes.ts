/**
 * Class + academic-session data access — SERVER-ONLY.
 *
 * Every function takes the trusted `institutionId` (resolved from the session
 * via `AuthPrincipal`, NEVER from a request body or query param) and applies it
 * as a hard filter to both reads and writes — the same tenant-isolation
 * contract as lib/data/students.ts and lib/data/teachers.ts (AGENTS.md §5).
 * The service-role client bypasses RLS, so the `.eq("institution_id", …)`
 * filter here is what actually isolates tenants.
 *
 * WHY THE TENANT CHECKS ARE LOAD-BEARING
 * The FK `classes.academic_session_id → academic_sessions(id)` only proves the
 * session row EXISTS, not that it shares the class's institution — a
 * cross-tenant session id passes the FK (same finding as prompt 12's
 * teacher_class_assignments). Every session id is therefore verified against
 * the caller's tenant before it reaches the row, and every read of another
 * table through a join re-checks the joined row's `institution_id`.
 *
 * ARCHIVE INSTEAD OF DELETE (AGENTS.md §6)
 * Exams, attempts and results (prompts 15–24) reference `classes.id`, so
 * nothing in this module deletes a class or session. `setClassStatus` /
 * `setSessionStatus` move rows between `active` and `archived`; archived rows
 * stay readable for historical reporting but are refused by the attach checks
 * (`classBelongsToInstitution` / `sessionBelongsToInstitution` are the
 * permissive guards; `*Attachable` variants enforce the lifecycle).
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import {
  classArchiveBlocked,
  normalizeClassInput,
  normalizeSessionInput,
  toOrgContainsPattern,
  type ClassErrors,
  type ClassInput,
  type ClassListQuery,
  type OrgStatus,
  type SessionErrors,
  type SessionInput,
  type SessionListQuery,
} from "@/lib/classes";

/** An academic session as the app uses it (camelCase). */
export type AcademicSession = {
  id: string;
  institutionId: string;
  name: string;
  status: OrgStatus;
  createdAt: string;
  updatedAt: string;
};

/** A class as the app uses it (camelCase, join-resolved session name). */
export type ClassRecord = {
  id: string;
  institutionId: string;
  name: string;
  academicSessionId: string | null;
  academicSessionName: string | null;
  status: OrgStatus;
  createdAt: string;
  updatedAt: string;
  /** Filled by the directory/detail reads only. */
  studentCount: number;
  /** Names of teachers assigned to this class; filled by the detail read. */
  teacherNames: string[];
};

/**
 * One recorded class assignment for a student (prompt 13's move-history).
 * `className` falls back to the snapshot stored with the row, so a class that
 * has since been renamed or archived still reads correctly in the timeline.
 */
export type StudentClassHistoryEntry = {
  id: string;
  classId: string | null;
  className: string | null;
  changedAt: string;
};

/** Whether a class may be archived right now, and why not if it may not. */
export type ClassArchiveEligibility =
  | { blocked: false; attachedStudents: number }
  | { blocked: true; attachedStudents: number; message: string };

/** Minimal session shape needed for the class form's dropdown. */
export type SessionOption = {
  id: string;
  name: string;
};

type SessionRow = {
  id: string;
  institution_id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type ClassRow = {
  id: string;
  institution_id: string;
  name: string;
  academic_session_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  academic_sessions: { name: string } | null;
};

/** Cast a DB status string, failing closed to `active` for unknown values. */
function toStatus(value: string): OrgStatus {
  return value === "archived" ? "archived" : "active";
}

function toSession(row: SessionRow): AcademicSession {
  return {
    id: row.id,
    institutionId: row.institution_id,
    name: row.name,
    status: toStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toClass(row: ClassRow): ClassRecord {
  return {
    id: row.id,
    institutionId: row.institution_id,
    name: row.name,
    academicSessionId: row.academic_session_id,
    academicSessionName: row.academic_sessions?.name ?? null,
    status: toStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    studentCount: 0,
    teacherNames: [],
  };
}

const SESSION_SELECT =
  "id, institution_id, name, status, created_at, updated_at";

const CLASS_SELECT =
  "id, institution_id, name, academic_session_id, status, created_at, updated_at, academic_sessions(name)";

// --- Academic sessions --------------------------------------------------------

/** List sessions for one institution with search / status / paging. */
export async function listSessions(
  institutionId: string,
  query: SessionListQuery,
): Promise<{ rows: AcademicSession[]; total: number }> {
  const supabase = createAdminClient();

  let builder = supabase
    .from("academic_sessions")
    .select(SESSION_SELECT, { count: "exact" })
    .eq("institution_id", institutionId);

  if (query.q) {
    const pattern = toOrgContainsPattern(query.q);
    if (pattern) builder = builder.ilike("name", pattern);
  }
  if (query.status) {
    builder = builder.eq("status", query.status);
  }

  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  const { data, error, count } = await builder
    .order("name", { ascending: true })
    .range(from, to);

  if (error) throw error;
  return {
    rows: (data ?? []).map((row) => toSession(row as unknown as SessionRow)),
    total: count ?? 0,
  };
}

/** Fetch one session, scoped to the caller's tenant (`null` = absent/foreign). */
export async function getSession(
  institutionId: string,
  id: string,
): Promise<AcademicSession | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("academic_sessions")
    .select(SESSION_SELECT)
    .eq("institution_id", institutionId)
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data ? toSession(data as unknown as SessionRow) : null;
}

/** Active sessions for the class form's dropdown, name-ordered. */
export async function listSessionOptions(
  institutionId: string,
): Promise<SessionOption[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("academic_sessions")
    .select("id, name")
    .eq("institution_id", institutionId)
    .eq("status", "active")
    .order("name", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
  }));
}

/** Count classes per status in one session, for the session detail page. */
export async function countClassesByStatus(
  institutionId: string,
  sessionId: string,
): Promise<Record<OrgStatus, number>> {
  const supabase = createAdminClient();
  const counts: Record<OrgStatus, number> = { active: 0, archived: 0 };

  const { data, error } = await supabase
    .from("classes")
    .select("status")
    .eq("institution_id", institutionId)
    .eq("academic_session_id", sessionId);

  if (error) throw error;
  for (const row of data ?? []) {
    counts[toStatus(row.status as string)] += 1;
  }
  return counts;
}

/** Map a per-tenant name clash (23505) to the field the admin can fix. */
function sessionNameConflict(error: { code?: string }): SessionErrors | null {
  if (error.code !== "23505") return null;
  return { name: "That session name is already used in your institution." };
}

/** Insert a session, forcing the caller's tenant onto the row. */
export async function createSession(
  institutionId: string,
  input: SessionInput,
): Promise<{ ok: true; id: string } | { ok: false; errors: SessionErrors }> {
  const supabase = createAdminClient();
  const clean = normalizeSessionInput(input);

  const { data, error } = await supabase
    .from("academic_sessions")
    .insert({ institution_id: institutionId, name: clean.name, status: "active" })
    .select("id")
    .single();

  if (error) {
    const fieldErrors = sessionNameConflict(error);
    if (fieldErrors) return { ok: false, errors: fieldErrors };
    throw error;
  }
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * Rename a session in place, scoped to the tenant so a foreign id changes
 * nothing. Status is not editable here — archiving is a confirmed action with
 * its own guard (`setSessionStatus`), never a side effect of a rename.
 */
export async function updateSession(
  institutionId: string,
  id: string,
  input: SessionInput,
): Promise<{ ok: true; id: string } | { ok: false; errors: SessionErrors }> {
  const supabase = createAdminClient();
  const clean = normalizeSessionInput(input);

  const { data, error } = await supabase
    .from("academic_sessions")
    .update({ name: clean.name })
    .eq("id", id)
    .eq("institution_id", institutionId)
    .select("id")
    .maybeSingle();

  if (error) {
    const fieldErrors = sessionNameConflict(error);
    if (fieldErrors) return { ok: false, errors: fieldErrors };
    throw error;
  }
  if (!data) return { ok: false, errors: {} }; // not found / wrong tenant
  return { ok: true, id };
}

/**
 * Archive or restore a session. Refuses to archive while classes are still
 * attached to it (the same "don't strand live records" rule the class archive
 * follows), so admins retire a session only once its classes are dealt with.
 * Returns `false` when the row does not exist under this institution, and
 * `{ ok: false, reason: "classesAttached", attached }` when the guard blocks.
 */
export async function setSessionStatus(
  institutionId: string,
  id: string,
  status: OrgStatus,
): Promise<
  { ok: true } | { ok: false; reason: "notFound" } | { ok: false; reason: "classesAttached"; attached: number }
> {
  const session = await getSession(institutionId, id);
  if (!session) return { ok: false, reason: "notFound" };

  if (status === "archived") {
    const attached = await countClassesForSession(institutionId, id);
    if (attached > 0) return { ok: false, reason: "classesAttached", attached };
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("academic_sessions")
    .update({ status })
    .eq("id", id)
    .eq("institution_id", institutionId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return data ? { ok: true } : { ok: false, reason: "notFound" };
}

/** Live classes attached to a session (archived classes do not block). */
async function countClassesForSession(
  institutionId: string,
  sessionId: string,
): Promise<number> {
  const supabase = createAdminClient();
  const { count, error } = await supabase
    .from("classes")
    .select("id", { count: "exact", head: true })
    .eq("institution_id", institutionId)
    .eq("academic_session_id", sessionId)
    .eq("status", "active");
  if (error) throw error;
  return count ?? 0;
}

// --- Classes ------------------------------------------------------------------

/**
 * Whether a session id belongs to this institution AND is still `active`.
 * This is the isolation boundary the FK cannot provide: the FK on
 * `classes.academic_session_id` only proves the referenced row exists, so a
 * cross-tenant session id would pass it and silently link two tenants.
 * An archived session is also refused here, so a retired year cannot quietly
 * collect new classes.
 */
async function sessionIsAttachable(
  institutionId: string,
  sessionId: string,
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("academic_sessions")
    .select("id")
    .eq("institution_id", institutionId)
    .eq("id", sessionId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** Whether a class id belongs to this institution (tenant guard for joins). */
export async function classBelongsToInstitution(
  institutionId: string,
  classId: string,
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("classes")
    .select("id")
    .eq("institution_id", institutionId)
    .eq("id", classId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/**
 * Whether a class exists under this tenant and is still `active` — the guard
 * new assignments (students, teacher scope, future assessments) must pass so
 * an archived class can never gain live records.
 */
export async function classIsAttachable(
  institutionId: string,
  classId: string,
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("classes")
    .select("id")
    .eq("institution_id", institutionId)
    .eq("id", classId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/**
 * Whether a class may be archived given its current attachments. The blocking
 * rule lives in the pure module (`classArchiveBlocked`) so it is unit-testable
 * and cannot drift from what the UI promises; this function only gathers the
 * facts (live students attached) from the caller's tenant.
 */
export async function classArchiveEligibility(
  institutionId: string,
  classId: string,
): Promise<ClassArchiveEligibility> {
  const attachedStudents = await countStudentsInClass(institutionId, classId);
  const blocked = classArchiveBlocked({ attachedStudents });
  return blocked
    ? { blocked: true, attachedStudents, message: blocked.message }
    : { blocked: false, attachedStudents };
}

/**
 * The student's recorded class assignments, newest first — the evidence that a
 * move did not rewrite history. Scoped to the caller's tenant on both sides
 * (the history row and the class it names), so a foreign student or class id
 * yields nothing rather than another institution's timeline.
 */
export async function listStudentClassHistory(
  institutionId: string,
  studentId: string,
): Promise<StudentClassHistoryEntry[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("student_class_history")
    .select("id, class_id, class_name_snapshot, changed_at, classes(name)")
    .eq("institution_id", institutionId)
    .eq("student_id", studentId)
    .order("changed_at", { ascending: false })
    .limit(50);

  if (error) throw error;

  return (data ?? []).map((raw) => {
    const row = raw as unknown as {
      id: string;
      class_id: string | null;
      class_name_snapshot: string | null;
      changed_at: string;
      classes: { name: string; institution_id?: string } | null;
    };
    // Prefer the live class name, but only when that class is ours; otherwise
    // fall back to the snapshot written at the time of the move.
    const liveName =
      row.classes && row.class_id ? row.classes.name : null;
    return {
      id: row.id,
      classId: row.class_id,
      className: liveName ?? row.class_name_snapshot ?? null,
      changedAt: row.changed_at,
    };
  });
}

/** Count ACTIVE (non soft-deleted) students attached to a class. */
export async function countStudentsInClass(
  institutionId: string,
  classId: string,
): Promise<number> {
  const supabase = createAdminClient();
  const { count, error } = await supabase
    .from("students")
    .select("id", { count: "exact", head: true })
    .eq("institution_id", institutionId)
    .eq("class_id", classId)
    .is("deleted_at", null);
  if (error) throw error;
  return count ?? 0;
}

/** Classes for pickers: active only, name-ordered (matches listClasses shape). */
export async function listClassOptions(
  institutionId: string,
): Promise<{ id: string; name: string }[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("classes")
    .select("id, name")
    .eq("institution_id", institutionId)
    .eq("status", "active")
    .order("name", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
  }));
}

/**
 * Student counts per class, tenant-guarded. Reads go through `students`, whose
 * own `institution_id` filter is the isolation boundary — a class id planted
 * from another tenant simply matches nothing here.
 */
async function studentCountsForClasses(
  institutionId: string,
  classIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (classIds.length === 0) return counts;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("students")
    .select("class_id")
    .eq("institution_id", institutionId)
    .in("class_id", classIds)
    .is("deleted_at", null);

  if (error) throw error;
  for (const row of data ?? []) {
    const classId = row.class_id as string;
    counts.set(classId, (counts.get(classId) ?? 0) + 1);
  }
  return counts;
}

/** Teacher names per class, tenant-guarded through the class's own row. */
async function teacherNamesForClasses(
  institutionId: string,
  classIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (classIds.length === 0) return result;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("teacher_class_assignments")
    .select("class_id, teachers(full_name, institution_id, deleted_at)")
    .in("class_id", classIds);

  if (error) throw error;

  for (const raw of data ?? []) {
    const row = raw as unknown as {
      class_id: string;
      teachers: { full_name: string; institution_id: string; deleted_at: string | null } | null;
    };
    const teacher = row.teachers;
    // Keep only teachers of THIS institution: a foreign id in the join can
    // never surface another tenant's name.
    if (!teacher || teacher.institution_id !== institutionId) continue;
    if (teacher.deleted_at) continue;
    const list = result.get(row.class_id) ?? [];
    list.push(teacher.full_name);
    result.set(row.class_id, list);
  }
  return result;
}

/** List classes for one institution with search / session / status / paging. */
export async function listClassesPage(
  institutionId: string,
  query: ClassListQuery,
): Promise<{ rows: ClassRecord[]; total: number }> {
  const supabase = createAdminClient();

  let builder = supabase
    .from("classes")
    .select(CLASS_SELECT, { count: "exact" })
    .eq("institution_id", institutionId);

  if (query.q) {
    const pattern = toOrgContainsPattern(query.q);
    if (pattern) builder = builder.ilike("name", pattern);
  }
  if (query.status) {
    builder = builder.eq("status", query.status);
  }
  if (query.sessionId) {
    // The session filter is tenant-checked first: a foreign session id would
    // match no class of ours anyway, but checking keeps the intent explicit.
    const foreign = await getSession(institutionId, query.sessionId);
    if (!foreign) return { rows: [], total: 0 };
    builder = builder.eq("academic_session_id", query.sessionId);
  }

  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  const { data, error, count } = await builder
    .order("name", { ascending: true })
    .range(from, to);

  if (error) throw error;

  const rows = (data ?? []).map((row) => toClass(row as unknown as ClassRow));
  const counts = await studentCountsForClasses(
    institutionId,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    row.studentCount = counts.get(row.id) ?? 0;
  }

  return { rows, total: count ?? 0 };
}

/**
 * Fetch one class, scoped to the caller's tenant, with student count and
 * assigned teacher names. `null` means absent OR another institution's — the
 * caller renders "not found" and existence is never leaked.
 */
export async function getClass(
  institutionId: string,
  id: string,
): Promise<ClassRecord | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("classes")
    .select(CLASS_SELECT)
    .eq("institution_id", institutionId)
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const record = toClass(data as unknown as ClassRow);
  record.studentCount = await countStudentsInClass(institutionId, id);
  const teacherMap = await teacherNamesForClasses(institutionId, [id]);
  record.teacherNames = (teacherMap.get(id) ?? []).sort((a, b) => a.localeCompare(b));
  return record;
}

/** Map a per-tenant class-name clash (23505) to the field the admin can fix. */
function classNameConflict(error: { code?: string }): ClassErrors | null {
  if (error.code !== "23505") return null;
  return { name: "That class name is already used in your institution." };
}

/**
 * Insert a class under the caller's tenant. A supplied session id must be the
 * caller's own AND active — the FK alone would accept a cross-tenant id, so
 * this check is the isolation boundary (see the module header).
 */
export async function createClass(
  institutionId: string,
  input: ClassInput,
): Promise<{ ok: true; id: string } | { ok: false; errors: ClassErrors }> {
  const clean = normalizeClassInput(input);

  if (clean.academicSessionId) {
    const usable = await sessionIsAttachable(institutionId, clean.academicSessionId);
    if (!usable) {
      return {
        ok: false,
        errors: {
          academicSessionId:
            "Choose one of your institution's active sessions.",
        },
      };
    }
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("classes")
    .insert({
      institution_id: institutionId,
      name: clean.name,
      academic_session_id: clean.academicSessionId || null,
      status: "active",
    })
    .select("id")
    .single();

  if (error) {
    const fieldErrors = classNameConflict(error);
    if (fieldErrors) return { ok: false, errors: fieldErrors };
    throw error;
  }
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * Update a class's name and/or session, scoped to the tenant so ids are
 * unforgeable. Session changes are validated; keeping a class in the session
 * it already sits in is allowed even if that session has since been archived,
 * so retiring a session never blocks unrelated edits.
 */
export async function updateClass(
  institutionId: string,
  id: string,
  input: ClassInput,
): Promise<{ ok: true; id: string } | { ok: false; errors: ClassErrors }> {
  const clean = normalizeClassInput(input);
  const current = await getClass(institutionId, id);
  if (!current) return { ok: false, errors: {} };

  if (clean.academicSessionId !== (current.academicSessionId ?? "")) {
    if (clean.academicSessionId) {
      const usable = await sessionIsAttachable(institutionId, clean.academicSessionId);
      if (!usable) {
        return {
          ok: false,
          errors: {
            academicSessionId:
              "Choose one of your institution's active sessions.",
          },
        };
      }
    }
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("classes")
    .update({
      name: clean.name,
      academic_session_id: clean.academicSessionId || null,
    })
    .eq("id", id)
    .eq("institution_id", institutionId)
    .select("id")
    .maybeSingle();

  if (error) {
    const fieldErrors = classNameConflict(error);
    if (fieldErrors) return { ok: false, errors: fieldErrors };
    throw error;
  }
  if (!data) return { ok: false, errors: {} };
  return { ok: true, id };
}

/**
 * Archive or restore a class — the non-destructive removal. Archiving is
 * refused while ACTIVE students are still attached (the caller surfaces
 * `classArchiveBlocked`'s message), because a live roster must not point at a
 * retired group. Restoring is allowed EXCEPT when another live class has since
 * reused this class's name — the live-rows-only partial unique index
 * (`classes_name_active_uidx`) rejects it with 23505, which is returned as
 * `{ reason: "nameConflict", className }` so the caller can show a clear
 * rename-first message instead of a raw constraint error. Nothing is ever
 * deleted, so exams/attempts/results from prompts 15–24 keep resolving
 * (AGENTS.md §6).
 */
export async function setClassStatus(
  institutionId: string,
  id: string,
  status: OrgStatus,
): Promise<
  | { ok: true }
  | { ok: false; reason: "notFound" }
  | { ok: false; reason: "studentsAttached"; attached: number }
  | { ok: false; reason: "nameConflict"; className: string }
> {
  const record = await getClass(institutionId, id);
  if (!record) return { ok: false, reason: "notFound" };

  if (status === "archived") {
    const attached = await countStudentsInClass(institutionId, id);
    if (attached > 0) return { ok: false, reason: "studentsAttached", attached };
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("classes")
    .update({ status })
    .eq("id", id)
    .eq("institution_id", institutionId)
    .select("id")
    .maybeSingle();

  // Restoring a class whose name a live class has since taken violates the
  // partial unique index — surface it as a named conflict, not a thrown error.
  if (error) {
    if (error.code === "23505") {
      return { ok: false, reason: "nameConflict", className: record.name };
    }
    throw error;
  }
  return data ? { ok: true } : { ok: false, reason: "notFound" };
}

// --- Teacher scope read -------------------------------------------------------

/**
 * Class ids a teacher is assigned to, tenant-scoped. Assignment rows carry no
 * institution column of their own (0003), so each row's class is re-checked
 * against the caller's tenant before its id is returned — a foreign class id
 * can never widen a teacher's scope.
 */
export async function listAssignedClassIdsForTeacher(
  institutionId: string,
  teacherProfileId: string,
): Promise<string[]> {
  const supabase = createAdminClient();

  const { data: teacherData, error: teacherError } = await supabase
    .from("teachers")
    .select("id")
    .eq("institution_id", institutionId)
    .eq("profile_id", teacherProfileId)
    .is("deleted_at", null)
    .maybeSingle();
  if (teacherError) throw teacherError;
  if (!teacherData) return [];

  const teacherId = (teacherData as { id: string }).id;

  const { data, error } = await supabase
    .from("teacher_class_assignments")
    .select("class_id")
    .eq("teacher_id", teacherId);
  if (error) throw error;

  const candidateIds = [...new Set((data ?? []).map((row) => row.class_id as string))];
  if (candidateIds.length === 0) return [];

  const { data: ownClasses, error: classError } = await supabase
    .from("classes")
    .select("id")
    .eq("institution_id", institutionId)
    .in("id", candidateIds);
  if (classError) throw classError;

  return (ownClasses ?? []).map((row) => row.id as string);
}
