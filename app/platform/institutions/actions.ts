"use server";

import { revalidatePath } from "next/cache";
import { inspectAccess } from "@/lib/auth/guards";
import { recordPlatformAudit } from "@/lib/data/audit";
import { setInstitutionStatus } from "@/lib/data/platform-overview";
import {
  INSTITUTION_STATUS_LABELS,
  isInstitutionStatus,
  type InstitutionStatus,
} from "@/lib/institutions";

/**
 * Result returned to the institution-detail client form. `message` is a short,
 * safe, user-facing note (never a stack trace or internal reason code leak);
 * nothing here trusts the browser — the action re-checks SUPER_ADMIN and
 * re-validates the transition server-side before touching data.
 */
export type InstitutionStatusActionResult =
  | { ok: true; status: InstitutionStatus; warning?: string }
  | { ok: false; message: string };

/**
 * Change an institution's operational status — the single sensitive write in
 * the platform institution area (prompt 32).
 *
 * Enforcement order (AGENTS.md §5, §7):
 *   1. Reject a malformed target status before any privileged work.
 *   2. Re-check SUPER_ADMIN from the trusted session (never a client claim).
 *      A non-super-admin attempt is audited as a DENIED status change.
 *   3. The data layer reads the CURRENT status server-side and applies the
 *      approved-transition policy; an illegal move is refused and audited as
 *      FAILED. Only a legal, applied change writes and audits SUCCESS.
 *
 * The audit detail carries only the from→to transition and the institution id
 * — no names, no personal data (lib/audit/platform.ts privacy contract).
 */
export async function setInstitutionStatusAction(
  institutionId: string,
  nextStatus: unknown,
): Promise<InstitutionStatusActionResult> {
  const fail = (message: string): InstitutionStatusActionResult => ({
    ok: false,
    message,
  });

  // 1. The requested status must be one we recognise.
  if (
    typeof institutionId !== "string" ||
    institutionId.trim().length === 0
  ) {
    return fail("No institution was specified.");
  }
  if (!isInstitutionStatus(nextStatus)) {
    return fail("That is not a valid status.");
  }
  const next: InstitutionStatus = nextStatus;

  // 2. Authoritative SUPER_ADMIN check for THIS request.
  const decision = await inspectAccess({ roles: ["SUPER_ADMIN"] });
  if (!decision.allowed) {
    await recordPlatformAudit({
      actorId: decision.principal?.userId ?? null,
      actorRole: decision.principal?.role ?? null,
      action: "institution.status_changed",
      targetType: "institution",
      targetId: institutionId,
      outcome: "denied",
      detail: `attempted status change to ${INSTITUTION_STATUS_LABELS[next]}`,
    });
    // Do not confirm whether the institution exists; the caller is not
    // authorised to act on any tenant.
    return fail("You are not authorised to change institution status.");
  }
  const actor = decision.principal;

  // 3. Apply the approved transition (current status read server-side).
  let result;
  try {
    result = await setInstitutionStatus(institutionId, next);
  } catch {
    await recordPlatformAudit({
      actorId: actor.userId,
      actorRole: actor.role,
      action: "institution.status_changed",
      targetType: "institution",
      targetId: institutionId,
      outcome: "failed",
      detail: `status change to ${INSTITUTION_STATUS_LABELS[next]} errored`,
    });
    return fail("The status could not be changed right now. Please try again.");
  }

  if (!result.ok) {
    if (result.reason === "invalidTransition") {
      await recordPlatformAudit({
        actorId: actor.userId,
        actorRole: actor.role,
        action: "institution.status_changed",
        targetType: "institution",
        targetId: institutionId,
        outcome: "failed",
        detail: `disallowed transition to ${INSTITUTION_STATUS_LABELS[next]}`,
      });
      return fail("That status change is not an allowed transition.");
    }
    if (result.reason === "noChange") {
      return fail("The institution is already in that status.");
    }
    if (result.reason === "conflict") {
      // The status moved under us between read and write (another operator or
      // a stale submission). We did NOT change it; record the refused attempt
      // and tell the operator to reload rather than guessing a new target.
      await recordPlatformAudit({
        actorId: actor.userId,
        actorRole: actor.role,
        action: "institution.status_changed",
        targetType: "institution",
        targetId: institutionId,
        outcome: "failed",
        detail: `transition to ${INSTITUTION_STATUS_LABELS[next]} skipped — status changed concurrently`,
      });
      return fail(
        "The status was changed by someone else just now. Reload to see the current status before trying again.",
      );
    }
    // notFound — report without confirming existence elsewhere.
    return fail("This institution could not be found.");
  }

  // 4. Applied successfully — audit the exact transition, then refresh views.
  //
  // AUDIT IS BEST-EFFORT, NOT ATOMIC: the status write and this audit insert
  // are separate service-role operations, so a successful change can in
  // principle fail to record. recordPlatformAudit never throws; we capture its
  // result and, on failure, surface a warning to the operator (and keep the
  // console error it already logs) so an unaudited change is observable rather
  // than silently accepted. True atomicity needs a DB transaction/RPC — see
  // the completion notes (a decision requiring approval).
  const audited = await recordPlatformAudit({
    actorId: actor.userId,
    actorRole: actor.role,
    action: "institution.status_changed",
    targetType: "institution",
    targetId: institutionId,
    outcome: "success",
    detail: `${INSTITUTION_STATUS_LABELS[result.from]} → ${INSTITUTION_STATUS_LABELS[result.to]}`,
  });

  revalidatePath("/platform/institutions");
  revalidatePath(`/platform/institutions/${institutionId}`);
  return {
    ok: true,
    status: result.to,
    ...(audited
      ? {}
      : {
          warning:
            "The status was changed, but its audit record could not be saved. Please note the change manually and report this to platform operations.",
        }),
  };
}
