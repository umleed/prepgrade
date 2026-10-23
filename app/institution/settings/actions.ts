"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";
import {
  validateInstitutionProfileUpdate,
  type InstitutionProfileField,
} from "@/lib/institutions";
import { updateInstitutionProfile } from "@/lib/data/institution-profile";
import { recordPlatformAudit } from "@/lib/data/audit";
import { INSTITUTION_SETTINGS_PATH } from "@/lib/navigation/institution-nav";

/**
 * Result the Settings › General form renders. `errors` are per-field messages
 * (kept so the form re-shows exactly what failed); `message` is a form-level
 * note (duplicate name, missing record, data source down). Nothing here trusts
 * the browser: the action re-resolves the tenant from the session, re-validates
 * every field, and writes only the caller's own row (AGENTS.md §5).
 */
export type ProfileActionResult =
  | { ok: true }
  | {
      ok: false;
      errors: Partial<Record<InstitutionProfileField, string>>;
      message?: string;
    };

const NO_FIELD_ERRORS: Partial<Record<InstitutionProfileField, string>> = {};

/**
 * Update the signed-in institution's own identity/contact profile. The tenant
 * id is taken from the trusted principal, never the payload, so a crafted
 * `institutionId` cannot edit another school's record. The pure validator is
 * the single source of the field rules shared with the client form.
 */
export async function updateInstitutionProfileAction(
  input: Record<string, string>,
): Promise<ProfileActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: INSTITUTION_SETTINGS_PATH,
  });
  const institutionId = principal.institutionId as string;

  const validated = validateInstitutionProfileUpdate(input);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors };
  }

  const result = await updateInstitutionProfile(institutionId, validated.value);
  if (!result.ok) {
    switch (result.reason) {
      case "duplicateName":
        return {
          ok: false,
          errors: { name: "Another institution already uses that name." },
        };
      case "notFound":
        return {
          ok: false,
          errors: NO_FIELD_ERRORS,
          message: "Your institution record could not be found. Please sign in again.",
        };
      case "unconfigured":
        return {
          ok: false,
          errors: NO_FIELD_ERRORS,
          message:
            "Saving is unavailable: the Supabase connection is not configured on the server.",
        };
      case "unavailable":
      default:
        return {
          ok: false,
          errors: NO_FIELD_ERRORS,
          message: "Your changes could not be saved right now. Please try again.",
        };
    }
  }

  // Administrative tenant change → audit it (prompt 33). Field NAMES only in
  // the summary — the new values (name/contact data) stay in the tenant's own
  // row and never enter the platform log (AGENTS.md §7 privacy contract).
  await recordPlatformAudit({
    actorId: principal.userId,
    actorRole: principal.role,
    action: "institution.settings_updated",
    targetType: "institution",
    targetId: institutionId,
    outcome: "success",
    detail: `Updated profile fields: ${Object.keys(validated.value).join(", ")}`,
  });

  // Refresh the settings page and the shell/dashboard, which read the real
  // institution name, so the sidebar and headings reflect the new value.
  revalidatePath(INSTITUTION_SETTINGS_PATH);
  revalidatePath("/institution");
  return { ok: true };
}
