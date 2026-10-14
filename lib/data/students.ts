/**
 * Student data access — SERVER-ONLY.
 *
 * Every function takes the trusted `institutionId` (resolved from the session
 * via `AuthPrincipal`, NEVER from a request body or query param) and applies it
 * as a hard filter to both reads and writes. That is the server half of the
 * tenant-isolation guarantee in AGENTS.md §5 — the database half (RLS) blocks
 * browser roles outright (supabase/migrations/0002_row_level_security.sql). A
 * tampered student/class id simply matches no row under the caller's tenant, so
 * cross-tenant reads and writes fail closed.
 *
 * Authorization is checked by the caller (a page or server action via
 * `guards.ts` / `requireResourceAccess`) BEFORE reaching this layer; these
 * functions assume an authorized institution admin and do the scoping.
 *
 * Class assignment changes are recorded in `student_class_history` (prompt 13)
 * so a student moving class never rewrites the class they belonged to for past
 * assessment periods. The transfer and its history row are written ATOMICALLY by
 * the `students_update_with_class_history` database function (a single implicit
 * transaction), so a failed history write can never leave a completed transfer
 * with missing history — the function returns false and the caller surfaces an
 * honest error instead.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import {
  normalizeStudentInput,
  toLikePattern,
  type StudentInput,
  type StudentErrors,
  type StudentListQuery,
  type StudentStatus,
} from "@/lib/students";

/** A student as the app uses it (camelCase, join-resolved class name). */
export type Student = {
  id: string;
  institutionId: string;
  profileId: string | null;
  studentCode: string;
  fullName: string;
  classId: string | null;
  className: string | null;
  status: StudentStatus;
  createdAt: string;
  updatedAt: string;
};

/** Minimal class shape needed for the assign dropdown and directory column. */
export type ClassOption = {
  id: string;
  name: string;
};

type StudentRow = {
  id: string;
  institution_id: string;
  profile_id: string | null;
  student_code: string;
  full_name: string;
  class_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  classes: { name: string } | null;
};

function toStudent(row: StudentRow): Student {
  return {
    id: row.id,
    institutionId: row.institution_id,
    profileId: row.profile_id,
    studentCode: row.student_code,
    fullName: row.full_name,
    classId: row.class_id,
    className: row.classes?.name ?? null,
    // The schema CHECK constrains status, but cast defensively (fail to active).
    status: row.status === "inactive" ? "inactive" : "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const STUDENT_SELECT =
  "id, institution_id, profile_id, student_code, full_name, class_id, status, created_at, updated_at, classes(name)";

/** List students for one institution with search / class / status / paging. */
export async function listStudents(
  institutionId: string,
  query: StudentListQuery,
): Promise<{ rows: Student[]; total: number }> {
  const supabase = createAdminClient();

  let builder = supabase
    .from("students")
    .select(STUDENT_SELECT, { count: "exact" })
    .eq("institution_id", institutionId)
    .is("deleted_at", null);

  if (query.q) {
    const pattern = toLikePattern(query.q);
    if (pattern) {
      builder = builder.or(
        `full_name.ilike.${pattern},student_code.ilike.${pattern}`,
      );
    }
  }
  if (query.classId) {
    builder = builder.eq("class_id", query.classId);
  }
  if (query.status) {
    builder = builder.eq("status", query.status);
  }

  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  const { data, error, count } = await builder
    .order("full_name", { ascending: true })
    .range(from, to);

  if (error) throw error;
  return {
    rows: (data ?? []).map((row) => toStudent(row as unknown as StudentRow)),
    total: count ?? 0,
  };
}

/**
 * Fetch one student, scoped to the caller's tenant. Returns `null` when the id
 * does not exist OR belongs to another institution — the caller treats both as
 * "not found", so existence of another tenant's record is never leaked.
 */
export async function getStudent(
  institutionId: string,
  id: string,
): Promise<Student | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("students")
    .select(STUDENT_SELECT)
    .eq("institution_id", institutionId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw error;
  return data ? toStudent(data as unknown as StudentRow) : null;
}

/** Classes for the assign dropdown, scoped to the tenant, name-ordered. */
export async function listClasses(institutionId: string): Promise<ClassOption[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("classes")
    .select("id, name")
    .eq("institution_id", institutionId)
    .order("name", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => ({ id: row.id as string, name: row.name as string }));
}

/**
 * Resolve the signed-in account's own roster row — the identity read behind
 * the student dashboard (prompt 20). Both keys are trusted server data: the
 * tenant comes from the session principal, and `profileId` is the Clerk user
 * id of the SAME session, never a client-supplied student id. Returns `null`
 * when no live, active student row is linked to the account — the caller
 * renders an honest "not linked yet" state rather than guessing a roster row.
 */
export async function getStudentByProfileId(
  institutionId: string,
  profileId: string,
): Promise<Student | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("students")
    .select(STUDENT_SELECT)
    .eq("institution_id", institutionId)
    .eq("profile_id", profileId)
    .eq("status", "active")
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw error;
  return data ? toStudent(data as unknown as StudentRow) : null;
}

/**
 * Whether a class id belongs to this institution. A false result blocks the
 * write so an admin can never attach a student to another tenant's class.
 */
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

/** Build the row payload (tenant id is added by each writer) from input. */
function toPayload(input: StudentInput) {
  const clean = normalizeStudentInput(input);
  return {
    full_name: clean.fullName,
    student_code: clean.studentCode,
    class_id: clean.classId.length > 0 ? clean.classId : null,
    status: clean.status,
  };
}

type WriteOutcome = { ok: true; id: string } | { ok: false; errors: StudentErrors };

/** Map a Supabase/Postgres error to a field error, or `null` if not a 23505. */
function uniqueViolationField(error: { code?: string; message?: string }): StudentErrors | null {
  if (error.code !== "23505") return null;
  // The only unique constraints reachable here are the per-institution code
  // (UNIQUE + students_code_active_uidx); report it as a code clash.
  return { studentCode: "That student code is already used in your institution." };
}

/** Insert a student, forcing the caller's tenant onto the row. */
export async function createStudent(
  institutionId: string,
  input: StudentInput,
): Promise<WriteOutcome> {
  // Never trust a class id from the form: confirm it is the tenant's own first.
  if (input.classId.trim()) {
    const valid = await classBelongsToInstitution(institutionId, input.classId.trim());
    if (!valid) {
      return { ok: false, errors: { classId: "Choose one of your institution's classes." } };
    }
  }

  const supabase = createAdminClient();
  const fields = toPayload(input);

  const { data, error } = await supabase
    .from("students")
    .insert({ ...fields, institution_id: institutionId })
    .select("id")
    .single();

  if (error) {
    const fieldErrors = uniqueViolationField(error);
    if (fieldErrors) return { ok: false, errors: fieldErrors };
    throw error;
  }
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * Update a student in place, scoped to the tenant so ids are unforgeable.
 * Delegates the write to `students_update_with_class_history`, which applies the
 * roster update AND, on a real class change, appends the class being LEFT to
 * `student_class_history` — atomically, in one database transaction (prompt 13,
 * AGENTS.md §6). An unrelated edit (name or code only) records nothing. The
 * function returns false when the id does not resolve under this tenant, which
 * is reported as a plain not-found (existence elsewhere is never confirmed).
 */
export async function updateStudent(
  institutionId: string,
  id: string,
  input: StudentInput,
): Promise<WriteOutcome> {
  const clean = normalizeStudentInput(input);

  // Never trust a class id from the form: confirm it is the tenant's own first.
  // (The composite student→class FK in 0004 now also refuses a cross-tenant id
  // at the database, but checking here keeps the friendly field error.)
  if (clean.classId) {
    const valid = await classBelongsToInstitution(institutionId, clean.classId);
    if (!valid) {
      return { ok: false, errors: { classId: "Choose one of your institution's classes." } };
    }
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc(
    "students_update_with_class_history",
    {
      p_institution_id: institutionId,
      p_student_id: id,
      p_full_name: clean.fullName,
      p_student_code: clean.studentCode,
      p_class_id: clean.classId.length > 0 ? clean.classId : null,
      p_status: clean.status,
    },
  );

  if (error) {
    const fieldErrors = uniqueViolationField(error);
    if (fieldErrors) return { ok: false, errors: fieldErrors };
    throw error;
  }
  // FALSE means the row did not match this tenant (or a history write would
  // have failed); both surface as an honest failure, never a false success.
  if (data === false) return { ok: false, errors: {} };

  return { ok: true, id };
}

/**
 * Change a student's status — the safe "deactivate access" action. It flips
 * active/inactive rather than deleting, so history and any future results stay
 * intact (AGENTS.md §6 preserves records). Scoped to the tenant; returns false
 * when the row does not exist under this institution.
 */
export async function setStudentStatus(
  institutionId: string,
  id: string,
  status: StudentStatus,
): Promise<boolean> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("students")
    .update({ status })
    .eq("id", id)
    .eq("institution_id", institutionId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return data !== null;
}
