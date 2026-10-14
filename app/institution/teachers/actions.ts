"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";
import {
  ProvisioningUnavailableError,
  findUserByEmail,
  grantTeacherRole,
  revokeTeacherRole,
  sendTeacherInvitationEmail,
} from "@/lib/auth/provisioning";
import { validateTeacher, type TeacherErrors, type TeacherInput } from "@/lib/teachers";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  createTeacher,
  getTeacher,
  linkTeacherAccount,
  replaceTeacherClassAssignments,
  setTeacherMembershipStatus,
  setTeacherStatus,
  updateTeacher,
} from "@/lib/data/teachers";

/**
 * Result a teacher mutation returns to the client form. `errors` are per-field
 * messages; `message` is a form-level note (record vanished, or the invite
 * email could not be sent). Nothing here trusts the browser: every action
 * re-resolves the tenant from the session and re-validates before touching
 * data, and the only role any action can grant is TEACHER (hard-coded in
 * lib/auth/provisioning.ts — no action accepts a role parameter).
 */
export type TeacherActionResult =
  | { ok: true; id?: string; notice?: string }
  | { ok: false; errors: TeacherErrors; message?: string };

/** Re-run validation for a mutation and return field errors, or `null` if valid. */
function fieldErrorsFor(input: TeacherInput): TeacherErrors | null {
  const errors = validateTeacher(input);
  return Object.keys(errors).length > 0 ? errors : null;
}

/** True when the failure means the Clerk/Supabase secrets are not configured. */
function isUnconfigured(error: unknown): boolean {
  return (
    error instanceof ProvisioningUnavailableError ||
    error instanceof DataSourceUnavailableError
  );
}

function revalidateTeacherPaths(id?: string) {
  revalidatePath("/institution/teachers");
  if (id) revalidatePath(`/institution/teachers/${id}`);
}

/**
 * Invite / add a teacher for the signed-in admin's own institution.
 *
 * Trusted server-side flow (prompt 12):
 * 1. Validate + insert the roster row (status `invited`) under the caller's
 *    tenant — the tenant id comes from the session, never the payload.
 * 2. If a Clerk account already uses that email: grant the TEACHER role in
 *    `privateMetadata` (Backend API, secret key) and link the DB rows.
 * 3. Otherwise: send Clerk's invitation email so the teacher can create an
 *    account; access is granted later via `activateTeacherAction`.
 *
 * If step 2/3 cannot run (secrets unconfigured, Clerk rejected the invite),
 * the roster row stays and the result carries an honest notice — we never
 * pretend an email was sent when it was not.
 */
export async function createTeacherAction(
  input: TeacherInput,
): Promise<TeacherActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/teachers",
  });
  const institutionId = principal.institutionId as string;

  const errors = fieldErrorsFor(input);
  if (errors) return { ok: false, errors };

  const result = await createTeacher(institutionId, input);
  if (!result.ok) return { ok: false, errors: result.errors };

  const id = result.id;
  let notice: string | undefined;

  try {
    const email = input.email.trim().toLowerCase();
    const account = await findUserByEmail(email);
    if (account) {
      await grantTeacherRole(account.userId, institutionId);
      await linkTeacherAccount(institutionId, id, account.userId, email, input.fullName.trim());
      notice = "An account already exists for this email — teacher access was granted.";
    } else {
      const sent = await sendTeacherInvitationEmail(email);
      notice = sent
        ? "Invitation email sent. Access is granted once the invitation is accepted — use Activate access on the profile."
        : "This email was already invited or registered. Once the account exists, use Activate access on the profile.";
    }
  } catch (error) {
    // Provisioning is best-effort here: the roster row is the source of truth
    // that the admin asked for, so a Clerk failure (missing keys, API error,
    // or a refused grant) is reported honestly instead of rolling back or
    // crashing. `activateTeacherAction` is the explicit retry path.
    const reason = isUnconfigured(error)
      ? "Clerk server keys are not configured on the server"
      : "the invitation could not be sent right now";
    notice = `The teacher was added to the roster, but ${reason}. Use Activate access on the profile to retry.`;
  }

  revalidateTeacherPaths(id);
  return { ok: true, id, notice };
}

/**
 * Update permitted profile details (name, employee code) and class scope.
 * Email and status are NOT editable here — email is the linking key, status
 * changes go through the explicit access actions below.
 */
export async function updateTeacherAction(
  id: string,
  input: TeacherInput,
): Promise<TeacherActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/teachers",
  });
  const institutionId = principal.institutionId as string;

  const errors = fieldErrorsFor(input);
  if (errors) return { ok: false, errors };

  const result = await updateTeacher(institutionId, id, input);
  if (!result.ok) {
    // Empty field errors from the data layer means the id did not resolve under
    // this tenant — report it without confirming whether it exists elsewhere.
    if (Object.keys(result.errors).length === 0) {
      return { ok: false, errors: {}, message: "This teacher could not be found." };
    }
    return { ok: false, errors: result.errors };
  }

  const assignmentErrors = await replaceTeacherClassAssignments(
    institutionId,
    id,
    input.classIds,
  );
  if (assignmentErrors) return { ok: false, errors: assignmentErrors };

  revalidateTeacherPaths(id);
  return { ok: true, id };
}

/**
 * Grant (or re-grant) teacher access for a roster row: resolve the Clerk
 * account by the stored email SERVER-SIDE, write the trusted TEACHER role +
 * tenant into `privateMetadata`, mirror the DB membership, and flip the roster
 * status to active. Used for `invited` rows after the teacher signs up and for
 * `inactive` rows being restored.
 *
 * Refusals that never mutate anything:
 * - no account for that email yet → honest "ask them to sign up first";
 * - the account already holds a non-TEACHER role, or belongs to another
 *   institution's teacher grant → provisioning throws, the action reports it,
 *   and no status/membership write happens (prompt 12's escalation guard).
 */
export async function activateTeacherAction(
  id: string,
): Promise<TeacherActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/teachers",
  });
  const institutionId = principal.institutionId as string;

  const teacher = await getTeacher(institutionId, id);
  if (!teacher) {
    return { ok: false, errors: {}, message: "This teacher could not be found." };
  }
  if (teacher.status === "active") {
    return { ok: true, id, notice: "This teacher is already active." };
  }

  try {
    const account = await findUserByEmail(teacher.email);
    if (!account) {
      return {
        ok: false,
        errors: {},
        message:
          "No PrepGrade account exists for this email yet. Send or wait for the invitation, then activate again.",
      };
    }

    // Trusted write first: if Clerk refuses (existing non-teacher role, other
    // tenant), nothing below runs and the roster keeps its previous status.
    await grantTeacherRole(account.userId, institutionId);

    const linked = await linkTeacherAccount(
      institutionId,
      id,
      account.userId,
      teacher.email,
      teacher.fullName,
    );
    if (!linked) {
      return {
        ok: false,
        errors: {},
        message:
          "This account already holds a non-teacher membership in your institution, so its role was left unchanged.",
      };
    }
  } catch (error) {
    if (isUnconfigured(error)) {
      return {
        ok: false,
        errors: {},
        message:
          "Teacher access could not be granted because Clerk server keys are not configured on the server.",
      };
    }
    return {
      ok: false,
      errors: {},
      message:
        error instanceof Error && error.message
          ? error.message
          : "We couldn't grant teacher access. Please try again.",
    };
  }

  revalidateTeacherPaths(id);
  return { ok: true, id, notice: "Teacher access granted." };
}

/**
 * Deactivate a teacher's access — the safe, reversible removal. It flips the
 * roster status and the DB membership to inactive AND revokes the trusted
 * `privateMetadata` role so access stops under today's auth read
 * (lib/auth/context.ts). Nothing is deleted; history is preserved (AGENTS.md
 * §6). Re-granting goes through `activateTeacherAction`, never this one.
 */
export async function deactivateTeacherAction(
  id: string,
): Promise<TeacherActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/teachers",
  });
  const institutionId = principal.institutionId as string;

  const teacher = await getTeacher(institutionId, id);
  if (!teacher) {
    return { ok: false, errors: {}, message: "This teacher could not be found." };
  }

  // DB roster + membership first: access must stop even if the Clerk call
  // below fails, and re-activation re-verifies everything anyway.
  const changed = await setTeacherStatus(institutionId, id, "inactive");
  if (!changed) {
    return { ok: false, errors: {}, message: "This teacher could not be found." };
  }
  if (teacher.profileId) {
    await setTeacherMembershipStatus(institutionId, teacher.profileId, "inactive");
  }

  let notice: string | undefined;
  if (teacher.profileId) {
    try {
      await revokeTeacherRole(teacher.profileId);
    } catch (error) {
      if (!isUnconfigured(error)) throw error;
      notice =
        "Access was deactivated in PrepGrade's records, but the sign-in role could not be revoked because Clerk server keys are not configured.";
    }
  }

  revalidateTeacherPaths(id);
  return { ok: true, id, notice };
}
