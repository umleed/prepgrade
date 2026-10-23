"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";
import { trackProductAnalytics } from "@/lib/product-analytics/server";
import {
  validateStudent,
  type StudentInput,
  type StudentErrors,
  type StudentStatus,
} from "@/lib/students";
import {
  createStudent,
  updateStudent,
  setStudentStatus,
} from "@/lib/data/students";

/**
 * Result a student mutation returns to the client form. `errors` are per-field
 * messages; `message` is a form-level note (e.g. the record vanished). Nothing
 * here trusts the browser: every action re-resolves the tenant from the session
 * and re-validates before touching data.
 */
export type StudentActionResult =
  | { ok: true; id?: string }
  | { ok: false; errors: StudentErrors; message?: string };

/** Re-run validation for a mutation and return field errors, or `null` if valid. */
function fieldErrorsFor(input: StudentInput): StudentErrors | null {
  const errors = validateStudent(input);
  return Object.keys(errors).length > 0 ? errors : null;
}

/**
 * Create a student for the signed-in admin's own institution. The tenant id is
 * taken from the trusted principal, never the payload, so a crafted
 * `institutionId` cannot plant a record in another school (AGENTS.md §5).
 */
export async function createStudentAction(
  input: StudentInput,
): Promise<StudentActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/students",
  });

  const errors = fieldErrorsFor(input);
  if (errors) return { ok: false, errors };

  const result = await createStudent(principal.institutionId as string, input);
  if (!result.ok) return { ok: false, errors: result.errors };

  // Product analytics (prompt 36): the roster-addition moment, once per
  // committed row. Ids and the trusted actor role only — the student's NAME
  // never travels (AGENTS.md §7, privacy minimisation).
  await trackProductAnalytics(
    "student_added",
    { studentId: result.id, classId: input.classId || null, role: principal.role },
    { institutionId: principal.institutionId as string },
  );

  revalidatePath("/institution/students");
  revalidatePath(`/institution/students/${result.id}`);
  return { ok: true, id: result.id };
}

/** Update an existing student, scoped to the caller's tenant. */
export async function updateStudentAction(
  id: string,
  input: StudentInput,
): Promise<StudentActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/students",
  });

  const errors = fieldErrorsFor(input);
  if (errors) return { ok: false, errors };

  const result = await updateStudent(
    principal.institutionId as string,
    id,
    input,
  );
  if (!result.ok) {
    // Empty field errors from the data layer means the id did not resolve under
    // this tenant — report it without confirming whether it exists elsewhere.
    if (Object.keys(result.errors).length === 0) {
      return { ok: false, errors: {}, message: "This student could not be found." };
    }
    return { ok: false, errors: result.errors };
  }

  revalidatePath("/institution/students");
  revalidatePath(`/institution/students/${id}`);
  return { ok: true, id };
}

/**
 * Activate or deactivate a student's roster status — the safe "deactivate
 * access" flow. It never deletes: history is preserved (AGENTS.md §6). Scoped to
 * the caller's tenant so a foreign id changes nothing.
 */
export async function setStudentStatusAction(
  id: string,
  status: StudentStatus,
): Promise<StudentActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/students",
  });

  const changed = await setStudentStatus(
    principal.institutionId as string,
    id,
    status,
  );
  if (!changed) {
    return { ok: false, errors: {}, message: "This student could not be found." };
  }

  revalidatePath("/institution/students");
  revalidatePath(`/institution/students/${id}`);
  return { ok: true, id };
}
