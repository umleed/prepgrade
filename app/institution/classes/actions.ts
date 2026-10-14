"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";
import {
  classArchiveBlocked,
  classRestoreNameConflictMessage,
  validateClass,
  validateSession,
  type ClassErrors,
  type ClassInput,
  type OrgStatus,
  type SessionErrors,
  type SessionInput,
} from "@/lib/classes";
import {
  createClass,
  createSession,
  setClassStatus,
  setSessionStatus,
  updateClass,
  updateSession,
} from "@/lib/data/classes";

/**
 * Result a class mutation returns to the client form. `errors` are per-field
 * messages; `message` is a form-level note (record vanished, or the archive
 * guard refused). Nothing here trusts the browser: every action re-resolves the
 * tenant from the session and re-validates before touching data, and the tenant
 * id is never read from the payload (AGENTS.md §5).
 */
export type ClassActionResult =
  | { ok: true; id?: string }
  | { ok: false; errors: ClassErrors; message?: string };

/** Result a session mutation returns to the client form. */
export type SessionActionResult =
  | { ok: true; id?: string }
  | { ok: false; errors: SessionErrors; message?: string };

/** Re-run class validation and return field errors, or `null` if valid. */
function classErrorsFor(input: ClassInput): ClassErrors | null {
  const errors = validateClass(input);
  return Object.keys(errors).length > 0 ? errors : null;
}

/** Re-run session validation and return field errors, or `null` if valid. */
function sessionErrorsFor(input: SessionInput): SessionErrors | null {
  const errors = validateSession(input);
  return Object.keys(errors).length > 0 ? errors : null;
}

function revalidateClassPaths(id?: string) {
  revalidatePath("/institution/classes");
  if (id) revalidatePath(`/institution/classes/${id}`);
}

function revalidateSessionPaths(id?: string) {
  revalidatePath("/institution/classes/sessions");
  if (id) revalidatePath(`/institution/classes/sessions/${id}`);
}

// --- Classes ------------------------------------------------------------------

/**
 * Create a class for the signed-in admin's own institution. The tenant id comes
 * from the trusted principal, never the payload, so a crafted id cannot plant a
 * class in another school. The session link is validated tenant-side in the
 * data layer (a cross-tenant or archived session id is refused there).
 */
export async function createClassAction(
  input: ClassInput,
): Promise<ClassActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes",
  });
  const institutionId = principal.institutionId as string;

  const errors = classErrorsFor(input);
  if (errors) return { ok: false, errors };

  const result = await createClass(institutionId, input);
  if (!result.ok) return { ok: false, errors: result.errors };

  revalidateClassPaths(result.id);
  return { ok: true, id: result.id };
}

/** Update a class's name/session, scoped to the caller's tenant. */
export async function updateClassAction(
  id: string,
  input: ClassInput,
): Promise<ClassActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes",
  });
  const institutionId = principal.institutionId as string;

  const errors = classErrorsFor(input);
  if (errors) return { ok: false, errors };

  const result = await updateClass(institutionId, id, input);
  if (!result.ok) {
    // Empty field errors means the id did not resolve under this tenant —
    // report it without confirming whether it exists elsewhere.
    if (Object.keys(result.errors).length === 0) {
      return { ok: false, errors: {}, message: "This class could not be found." };
    }
    return { ok: false, errors: result.errors };
  }

  revalidateClassPaths(id);
  return { ok: true, id };
}

/**
 * Archive or restore a class — the non-destructive removal (AGENTS.md §6). The
 * data layer refuses to archive while ACTIVE students are still attached; that
 * refusal is surfaced as a message so the confirmation dialog can explain the
 * move-first requirement instead of silently failing.
 */
export async function setClassStatusAction(
  id: string,
  status: OrgStatus,
): Promise<ClassActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes",
  });
  const institutionId = principal.institutionId as string;

  const result = await setClassStatus(institutionId, id, status);
  if (!result.ok) {
    if (result.reason === "studentsAttached") {
      // Reuse the pure policy message so the UI can never drift from the rule.
      return {
        ok: false,
        errors: {},
        message:
          classArchiveBlocked({ attachedStudents: result.attached })?.message ??
          "Move the students still in this class to another class first.",
      };
    }
    if (result.reason === "nameConflict") {
      return {
        ok: false,
        errors: {},
        message: classRestoreNameConflictMessage(result.className),
      };
    }
    return { ok: false, errors: {}, message: "This class could not be found." };
  }

  revalidateClassPaths(id);
  return { ok: true, id };
}

// --- Academic sessions --------------------------------------------------------

/** Create an academic session for the signed-in admin's own institution. */
export async function createSessionAction(
  input: SessionInput,
): Promise<SessionActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes/sessions",
  });
  const institutionId = principal.institutionId as string;

  const errors = sessionErrorsFor(input);
  if (errors) return { ok: false, errors };

  const result = await createSession(institutionId, input);
  if (!result.ok) return { ok: false, errors: result.errors };

  revalidateSessionPaths(result.id);
  return { ok: true, id: result.id };
}

/** Rename a session, scoped to the caller's tenant. */
export async function updateSessionAction(
  id: string,
  input: SessionInput,
): Promise<SessionActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes/sessions",
  });
  const institutionId = principal.institutionId as string;

  const errors = sessionErrorsFor(input);
  if (errors) return { ok: false, errors };

  const result = await updateSession(institutionId, id, input);
  if (!result.ok) {
    if (Object.keys(result.errors).length === 0) {
      return { ok: false, errors: {}, message: "This session could not be found." };
    }
    return { ok: false, errors: result.errors };
  }

  revalidateSessionPaths(id);
  return { ok: true, id };
}

/**
 * Archive or restore a session. The data layer refuses to archive while classes
 * are still attached to it, so a retired year never strands a live class; the
 * refusal is surfaced as a message rather than a silent no-op.
 */
export async function setSessionStatusAction(
  id: string,
  status: OrgStatus,
): Promise<SessionActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes/sessions",
  });
  const institutionId = principal.institutionId as string;

  const result = await setSessionStatus(institutionId, id, status);
  if (!result.ok) {
    if (result.reason === "classesAttached") {
      return {
        ok: false,
        errors: {},
        message: `Archive or move the ${result.attached} active class${
          result.attached === 1 ? "" : "es"
        } in this session first.`,
      };
    }
    return { ok: false, errors: {}, message: "This session could not be found." };
  }

  revalidateSessionPaths(id);
  return { ok: true, id };
}
