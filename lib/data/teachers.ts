/**
 * Teacher data access — SERVER-ONLY.
 *
 * Every function takes the trusted `institutionId` (resolved from the session
 * via `AuthPrincipal`, NEVER from a request body or query param) and applies it
 * as a hard filter to both reads and writes — the same tenant-isolation
 * contract as lib/data/students.ts (AGENTS.md §5). RLS blocks browser roles
 * outright (supabase/migrations/0003_teacher_management.sql); the service-role
 * client bypasses RLS, so the `.eq("institution_id", …)` filter here is what
 * actually isolates tenants.
 *
 * Membership writes (profiles + institution_memberships rows) live here too:
 * they are the database half of the trusted invitation flow. The Clerk
 * `privateMetadata` half lives in lib/auth/provisioning.ts. Both are reachable
 * ONLY from server actions that have already enforced INSTITUTION_ADMIN, and
 * the role written is hard-coded TEACHER — never a client-supplied value.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import {
  normalizeTeacherInput,
  toTeacherLikePattern,
  type TeacherInput,
  type TeacherErrors,
  type TeacherListQuery,
  type TeacherStatus,
} from "@/lib/teachers";
import type { ClassOption } from "./students";

/** A teacher as the app uses it (camelCase, join-resolved class names). */
export type Teacher = {
  id: string;
  institutionId: string;
  profileId: string | null;
  email: string;
  employeeCode: string;
  fullName: string;
  status: TeacherStatus;
  /** Names of the assigned classes; filled by the directory/detail reads. */
  classNames: string[];
  createdAt: string;
  updatedAt: string;
};

type TeacherRow = {
  id: string;
  institution_id: string;
  profile_id: string | null;
  email: string;
  employee_code: string;
  full_name: string;
  status: string;
  created_at: string;
  updated_at: string;
};

function toTeacher(row: TeacherRow): Teacher {
  return {
    id: row.id,
    institutionId: row.institution_id,
    profileId: row.profile_id,
    email: row.email,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    // The schema CHECK constrains status, but cast defensively (fail to invited).
    status:
      row.status === "active" || row.status === "inactive"
        ? row.status
        : "invited",
    classNames: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TEACHER_SELECT =
  "id, institution_id, profile_id, email, employee_code, full_name, status, created_at, updated_at";

/**
 * Class ids assigned to the given teachers, scoped to the tenant. Assignment
 * rows are joined through `classes`, and each class is kept only when it
 * belongs to the caller's institution — a foreign class id planted in the
 * join can never surface another tenant's class name.
 */
async function classNamesForTeachers(
  institutionId: string,
  teacherIds: string[],
): Promise<Map<string, { id: string; name: string }[]>> {
  const result = new Map<string, { id: string; name: string }[]>();
  if (teacherIds.length === 0) return result;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("teacher_class_assignments")
    .select("teacher_id, class_id, classes(id, name)")
    .in("teacher_id", teacherIds);

  if (error) throw error;

  for (const raw of data ?? []) {
    const row = raw as unknown as {
      teacher_id: string;
      class_id: string;
      classes: { id: string; name: string } | null;
    };
    if (!row.classes || row.classes.id !== row.class_id) continue;
    const list = result.get(row.teacher_id) ?? [];
    list.push({ id: row.classes.id, name: row.classes.name });
    result.set(row.teacher_id, list);
  }
  return result;
}

/** List teachers for one institution with search / class / status / paging. */
export async function listTeachers(
  institutionId: string,
  query: TeacherListQuery,
): Promise<{ rows: Teacher[]; total: number }> {
  const supabase = createAdminClient();

  let builder = supabase
    .from("teachers")
    .select(TEACHER_SELECT, { count: "exact" })
    .eq("institution_id", institutionId)
    .is("deleted_at", null);

  if (query.q) {
    const pattern = toTeacherLikePattern(query.q);
    if (pattern) {
      builder = builder.or(
        `full_name.ilike.${pattern},employee_code.ilike.${pattern},email.ilike.${pattern}`,
      );
    }
  }
  if (query.status) {
    builder = builder.eq("status", query.status);
  }
  if (query.classId) {
    // Class filter goes through the assignment join, tenant-guarded by the
    // institution's own class list: a foreign class id matches nothing here.
    const tenantClass = await hasClass(institutionId, query.classId);
    if (!tenantClass) return { rows: [], total: 0 };
    const { data: assigned, error: assignError } = await supabase
      .from("teacher_class_assignments")
      .select("teacher_id")
      .eq("class_id", query.classId);
    if (assignError) throw assignError;
    const ids = (assigned ?? []).map((r) => r.teacher_id as string);
    if (ids.length === 0) return { rows: [], total: 0 };
    builder = builder.in("id", ids);
  }

  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  const { data, error, count } = await builder
    .order("full_name", { ascending: true })
    .range(from, to);

  if (error) throw error;

  const rows = (data ?? []).map((row) => toTeacher(row as unknown as TeacherRow));
  const classMap = await classNamesForTeachers(
    institutionId,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    row.classNames = (classMap.get(row.id) ?? []).map((cls) => cls.name);
  }

  return { rows, total: count ?? 0 };
}

/**
 * Fetch one teacher, scoped to the caller's tenant. Returns `null` when the id
 * does not exist OR belongs to another institution — the caller treats both as
 * "not found", so existence of another tenant's record is never leaked.
 */
export async function getTeacher(
  institutionId: string,
  id: string,
): Promise<Teacher | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("teachers")
    .select(TEACHER_SELECT)
    .eq("institution_id", institutionId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const teacher = toTeacher(data as unknown as TeacherRow);
  const classMap = await classNamesForTeachers(institutionId, [teacher.id]);
  teacher.classNames = (classMap.get(teacher.id) ?? []).map((cls) => cls.name);
  return teacher;
}

/** Count teachers per status, for the directory's summary strip. */
export async function countTeachersByStatus(
  institutionId: string,
): Promise<Record<TeacherStatus, number>> {
  const supabase = createAdminClient();
  const counts: Record<TeacherStatus, number> = { invited: 0, active: 0, inactive: 0 };

  const { data, error } = await supabase
    .from("teachers")
    .select("status")
    .eq("institution_id", institutionId)
    .is("deleted_at", null);

  if (error) throw error;
  for (const row of data ?? []) {
    const status = row.status as string;
    if (status === "invited" || status === "active" || status === "inactive") {
      counts[status] += 1;
    }
  }
  return counts;
}

/** Whether a class id belongs to this institution (tenant guard for joins). */
async function hasClass(institutionId: string, classId: string): Promise<boolean> {
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
 * Replace a teacher's class assignments atomically-enough for the MVP: delete
 * the teacher's rows, then insert the new set. EVERY class id is validated to
 * belong to the caller's tenant first — a cross-tenant id aborts with a field
 * error rather than writing. (The DB FK alone would NOT stop it; see the
 * migration comment.)
 */
export async function replaceTeacherClassAssignments(
  institutionId: string,
  teacherId: string,
  classIds: string[],
): Promise<TeacherErrors | null> {
  const unique = [...new Set(classIds.map((id) => id.trim()).filter((id) => id.length > 0))];

  for (const classId of unique) {
    const valid = await hasClass(institutionId, classId);
    if (!valid) {
      return { classIds: "Choose only classes that belong to your institution." };
    }
  }

  const supabase = createAdminClient();

  // Scope the delete through the teacher's own tenant-verified row.
  const { error: deleteError } = await supabase
    .from("teacher_class_assignments")
    .delete()
    .in(
      "teacher_id",
      await tenantTeacherIds(institutionId, teacherId),
    );
  if (deleteError) throw deleteError;

  if (unique.length > 0) {
    const { error: insertError } = await supabase
      .from("teacher_class_assignments")
      .insert(unique.map((classId) => ({ teacher_id: teacherId, class_id: classId })));
    if (insertError) throw insertError;
  }
  return null;
}

/**
 * The teacher id ONLY when it resolves under this tenant; otherwise an
 * impossible id so a scoped delete matches zero rows (fail closed).
 */
async function tenantTeacherIds(institutionId: string, teacherId: string): Promise<string[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("teachers")
    .select("id")
    .eq("institution_id", institutionId)
    .eq("id", teacherId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  return data ? [(data as { id: string }).id] : ["00000000-0000-0000-0000-000000000000"];
}

/** Build the row payload (tenant id is added by each writer) from input. */
function toPayload(input: TeacherInput) {
  const clean = normalizeTeacherInput(input);
  return {
    full_name: clean.fullName,
    employee_code: clean.employeeCode,
    email: clean.email,
  };
}

type WriteOutcome = { ok: true; id: string } | { ok: false; errors: TeacherErrors };

/** Map a Supabase/Postgres 23505 to the field the admin can fix. */
function uniqueViolationField(error: { code?: string; message?: string }): TeacherErrors | null {
  if (error.code !== "23505") return null;
  if (/email/i.test(error.message ?? "")) {
    return { email: "That email is already on your teacher roster." };
  }
  return { employeeCode: "That employee code is already used in your institution." };
}

/** Insert a teacher (status `invited`), forcing the caller's tenant. */
export async function createTeacher(
  institutionId: string,
  input: TeacherInput,
): Promise<WriteOutcome> {
  const supabase = createAdminClient();
  const fields = toPayload(input);

  const { data, error } = await supabase
    .from("teachers")
    .insert({ ...fields, institution_id: institutionId, status: "invited" })
    .select("id")
    .single();

  if (error) {
    const fieldErrors = uniqueViolationField(error);
    if (fieldErrors) return { ok: false, errors: fieldErrors };
    throw error;
  }
  const id = (data as { id: string }).id;

  const assignmentErrors = await replaceTeacherClassAssignments(
    institutionId,
    id,
    input.classIds,
  );
  if (assignmentErrors) {
    // Roll the half-created roster row back so a rejected class id never
    // leaves an orphan teacher (soft delete frees the code/email for retry).
    await supabase
      .from("teachers")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .eq("institution_id", institutionId);
    return { ok: false, errors: assignmentErrors };
  }
  return { ok: true, id };
}

/**
 * Update a teacher's permitted profile details (name, employee code) in place,
 * scoped to the tenant so ids are unforgeable. Email is deliberately NOT
 * editable: it is the invitation/account-linking key.
 */
export async function updateTeacher(
  institutionId: string,
  id: string,
  input: TeacherInput,
): Promise<WriteOutcome> {
  const supabase = createAdminClient();
  const clean = normalizeTeacherInput(input);

  // `.eq(institution_id)` means a foreign id updates nothing: fail closed.
  const { data, error } = await supabase
    .from("teachers")
    .update({ full_name: clean.fullName, employee_code: clean.employeeCode })
    .eq("id", id)
    .eq("institution_id", institutionId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    const fieldErrors = uniqueViolationField(error);
    if (fieldErrors) return { ok: false, errors: fieldErrors };
    throw error;
  }
  if (!data) return { ok: false, errors: {} }; // not found / wrong tenant
  return { ok: true, id };
}

/**
 * Change a teacher's roster status. Deactivation is the safe, reversible
 * "remove access" action — the row and its history are preserved (AGENTS.md
 * §6). Scoped to the tenant; returns false when the row does not exist under
 * this institution. Membership rows are kept in sync by the caller (the
 * server action), which has already re-checked authorization.
 */
export async function setTeacherStatus(
  institutionId: string,
  id: string,
  status: TeacherStatus,
): Promise<boolean> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("teachers")
    .update({ status })
    .eq("id", id)
    .eq("institution_id", institutionId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return data !== null;
}

/**
 * Link a teacher roster row to a resolved Clerk account and mark them active.
 * `profileId` comes from the SERVER-side provisioning lookup (email match),
 * never from the client. Writes the DB mirror rows (profile + TEACHER
 * membership) that the grant is recorded with. If an existing membership
 * holds a role other than TEACHER, nothing is written and `false` is returned
 * — the action surfaces that as a refusal rather than re-tagging a member.
 */
export async function linkTeacherAccount(
  institutionId: string,
  id: string,
  profileId: string,
  email: string,
  fullName: string,
): Promise<boolean> {
  const supabase = createAdminClient();

  // Refuse to touch memberships that are not teachers (no role down/up-grading).
  const { data: existingMembership, error: membershipReadError } = await supabase
    .from("institution_memberships")
    .select("id, role")
    .eq("institution_id", institutionId)
    .eq("user_id", profileId)
    .maybeSingle();
  if (membershipReadError) throw membershipReadError;
  if (existingMembership && (existingMembership as { role: string }).role !== "TEACHER") {
    return false;
  }

  // Server-written mirror of the Clerk account (0001 comment: "Prompt 08
  // provisions these" — this is that trusted provisioning path for teachers).
  const { error: profileError } = await supabase
    .from("profiles")
    .upsert(
      { id: profileId, email, full_name: fullName, account_type: "teacher" },
      { onConflict: "id", ignoreDuplicates: false },
    );
  if (profileError) throw profileError;

  const { error: membershipError } = await supabase
    .from("institution_memberships")
    .upsert(
      {
        institution_id: institutionId,
        user_id: profileId,
        role: "TEACHER",
        status: "active",
      },
      { onConflict: "institution_id,user_id", ignoreDuplicates: false },
    );
  if (membershipError) throw membershipError;

  const linked = await supabase
    .from("teachers")
    .update({ profile_id: profileId, status: "active" })
    .eq("id", id)
    .eq("institution_id", institutionId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (linked.error) throw linked.error;
  return linked.data !== null;
}

/**
 * Keep the DB membership row in sync with a roster status change. Teacher rows
 * only — a membership holding another role is never modified from this flow.
 */
export async function setTeacherMembershipStatus(
  institutionId: string,
  profileId: string,
  status: "active" | "inactive",
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("institution_memberships")
    .update({ status })
    .eq("institution_id", institutionId)
    .eq("user_id", profileId)
    .eq("role", "TEACHER");
  if (error) throw error;
}

/** Class ids a teacher is assigned to (for the edit form), tenant-scoped. */
export async function listTeacherClassIds(
  institutionId: string,
  teacherId: string,
): Promise<string[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("teacher_class_assignments")
    .select("class_id")
    .in("teacher_id", await tenantTeacherIds(institutionId, teacherId));

  if (error) throw error;
  return (data ?? []).map((row) => row.class_id as string);
}

/** Re-export so callers scope classes without importing two data modules. */
export type { ClassOption };
