"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/context";
import {
  createInstitutionApplication,
  respondToInformationRequest,
  saveApplicationDraft,
  submitDraftApplication,
} from "@/lib/data/institution-applications";
import {
  validateApplicationDraft,
  validateApplicationResponse,
  validateApplicationSubmission,
  type ApplicationResponseField,
  type ApplicationSubmissionField,
} from "@/lib/institution-applications";

/**
 * Result for the applicant-facing onboarding forms. `errors` mirror the pure
 * validator's field keys so the form can highlight each problem; `message` is
 * a short, safe note (never a raw DB reason). Nothing here trusts the browser:
 * the applicant's identity is the trusted session id, and every field is
 * re-validated server-side before a row is written (AGENTS.md §5).
 */
export type SubmitApplicationResult =
  | { ok: true }
  | {
      ok: false;
      message?: string;
      errors?: Partial<Record<ApplicationSubmissionField, string>>;
      values?: Record<ApplicationSubmissionField, string>;
    };

/** Result of saving a draft (same shape — the draft form shows field errors). */
export type DraftSaveResult = SubmitApplicationResult;

/** Result of answering a needs_information request (adds the note field). */
export type RespondApplicationResult =
  | { ok: true }
  | {
      ok: false;
      message?: string;
      errors?: Partial<Record<ApplicationResponseField, string>>;
      values?: Record<ApplicationSubmissionField, string> & {
        responseNote: string;
      };
    };

/**
 * Every applicant write starts here: the trusted session, never a client
 * claim. Returns the stable Clerk user id or a ready-made failure message so
 * each action cannot forget the check.
 */
async function requireApplicantId(
  action: string,
): Promise<{ userId: string } | { userId: null; message: string }> {
  const context = await getAuthContext();
  if (context.session !== "active" || !context.principal) {
    return {
      userId: null,
      message: `Please sign in before you ${action}.`,
    };
  }
  return { userId: context.principal.userId };
}

/**
 * Submit an institution registration application on behalf of the signed-in
 * applicant (school / CBT-centre intent). Creates or promotes a row in
 * `institution_applications` with status `pending_review` — NO institution,
 * membership, or workspace access is implied (that is the super-admin
 * approval step, done separately).
 *
 * Two shapes of `raw`:
 *   - a plain form payload  → a brand-new submission (insert),
 *   - a payload carrying `draftId` → SUBMIT the applicant's saved draft
 *     (update + status flip, CAS-guarded to the applicant's own draft row).
 *
 * Duplicate protection is enforced by the database (0016 widened by 0019:
 * one OPEN application per applicant, draft included), so a second open
 * application is refused rather than piling up rows.
 */
export async function submitInstitutionApplicationAction(
  raw: Record<string, unknown>,
): Promise<SubmitApplicationResult> {
  const applicant = await requireApplicantId("submit your application");
  if (applicant.userId === null) {
    return { ok: false, message: applicant.message };
  }

  const validated = validateApplicationSubmission(raw);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors, values: validated.values };
  }

  const draftId =
    typeof raw.draftId === "string" ? raw.draftId.trim() : "";

  if (draftId) {
    const result = await submitDraftApplication(
      draftId,
      validated.value,
      applicant.userId,
    );
    if (!result.ok) {
      if (result.reason === "notDraft") {
        return {
          ok: false,
          message:
            "This draft is no longer editable — it may already have been submitted. Reload the page to see its current status.",
        };
      }
      return {
        ok: false,
        message:
          "We couldn't submit your application right now. Please try again.",
      };
    }
    revalidatePath("/onboarding");
    return { ok: true };
  }

  const result = await createInstitutionApplication(
    validated.value,
    applicant.userId,
  );
  if (!result.ok) {
    if (result.reason === "duplicateOpen") {
      return {
        ok: false,
        message:
          "You already have an application under review. Please wait for a decision before submitting another.",
      };
    }
    return {
      ok: false,
      message: "We couldn't submit your application right now. Please try again.",
    };
  }

  revalidatePath("/onboarding");
  return { ok: true };
}

/**
 * Save the applicant's partially-completed application as a DRAFT. A draft
 * enters no review queue and grants nothing — it only gives the applicant a
 * place to finish later. Re-saving updates the applicant's own draft row;
 * saving a draft alongside an already-submitted application is refused.
 */
export async function saveApplicationDraftAction(
  raw: Record<string, unknown>,
): Promise<DraftSaveResult> {
  const applicant = await requireApplicantId("save a draft");
  if (applicant.userId === null) {
    return { ok: false, message: applicant.message };
  }

  const validated = validateApplicationDraft(raw);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors, values: validated.values };
  }

  const result = await saveApplicationDraft(validated.value, applicant.userId);
  if (!result.ok) {
    if (result.reason === "notDraftable") {
      return {
        ok: false,
        message:
          "Your application is already under review, so it can't be saved as a draft. Respond to the review team from your dashboard instead.",
      };
    }
    return {
      ok: false,
      message: "We couldn't save your draft right now. Please try again.",
    };
  }

  revalidatePath("/onboarding");
  return { ok: true };
}

/**
 * Answer a needs_information request on the applicant's own application:
 * the (possibly corrected) details plus a REQUIRED response note are written
 * to the same row, which re-enters the review queue. The reviewer's original
 * request stays visible. CAS-guarded in the data layer to the applicant's own
 * needs_information row, so a concurrent decision is never overwritten.
 */
export async function respondToInformationRequestAction(
  raw: Record<string, unknown>,
): Promise<RespondApplicationResult> {
  const applicant = await requireApplicantId("respond to the review team");
  if (applicant.userId === null) {
    return { ok: false, message: applicant.message };
  }

  const applicationId =
    typeof raw.applicationId === "string" ? raw.applicationId.trim() : "";
  if (applicationId.length === 0) {
    return { ok: false, message: "No application was specified." };
  }

  const validated = validateApplicationResponse(raw);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors, values: validated.values };
  }

  const result = await respondToInformationRequest(
    applicationId,
    validated.value,
    applicant.userId,
  );
  if (!result.ok) {
    if (result.reason === "notActionable") {
      return {
        ok: false,
        message:
          "This application is no longer awaiting your response — it may have moved on since you loaded the page. Reload to see its current status.",
      };
    }
    return {
      ok: false,
      message: "We couldn't record your response right now. Please try again.",
    };
  }

  revalidatePath("/onboarding");
  return { ok: true };
}
