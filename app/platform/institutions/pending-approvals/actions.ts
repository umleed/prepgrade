"use server";

import { revalidatePath } from "next/cache";
import { inspectAccess } from "@/lib/auth/guards";
import { recordPlatformAudit } from "@/lib/data/audit";
import {
  decideInstitutionApplication,
  retryApplicationProvisioning,
} from "@/lib/data/institution-applications";
import {
  APPLICATION_STATUS_LABELS,
  PROVISIONING_ERROR_LABELS,
  decisionRequiresNote,
  isApplicationDecision,
  validateApplicationNote,
  type ApplicationDecision,
  type ApplicationStatus,
  type ProvisioningStatus,
} from "@/lib/institution-applications";
import type { PlatformAuditAction } from "@/lib/audit/platform";

/**
 * Result returned to the review-drawer client. `message` is a short, safe,
 * user-facing note (never a stack trace or raw reason code). Nothing here
 * trusts the browser: the action re-checks SUPER_ADMIN and re-validates the
 * decision + note server-side before touching data (AGENTS.md §5).
 */
export type ApplicationDecisionResult =
  | {
      ok: true;
      status: ApplicationStatus;
      /** Post-approval workspace-access state. 'not_required' unless the
       *  decision was an approval. The drawer must NOT present an approved
       *  application as usable while this is 'needs_retry'. */
      provisioning: ProvisioningStatus;
      warning?: string;
    }
  | { ok: false; message: string };

/** Result of the retry-provisioning action (the secure recovery path). */
export type ProvisioningActionResult =
  | { ok: true; provisioning: ProvisioningStatus }
  | { ok: false; message: string };

const DECISION_AUDIT_ACTION: Record<ApplicationDecision, PlatformAuditAction> = {
  approve: "institution_application.approved",
  reject: "institution_application.rejected",
  request_information: "institution_application.info_requested",
  put_on_hold: "institution_application.placed_on_hold",
};

/**
 * Record a reviewer decision on one application — the sensitive write in the
 * pending-approvals area.
 *
 * Enforcement order (mirrors the institution status-change action):
 *   1. Reject a malformed decision/target before any privileged work.
 *   2. Re-check SUPER_ADMIN from the trusted session; a non-super-admin attempt
 *      is audited as DENIED and answered without confirming the application
 *      exists.
 *   3. Validate a required note (rejection reason / information request).
 *   4. Apply through the data layer, which enforces the approved-transition
 *      policy and compare-and-swap concurrency; approval creates the tenant
 *      (no membership, no email) only for the CAS winner.
 *   5. Audit the outcome (success / failed / conflict), then revalidate.
 *
 * PRIVACY: the audit detail carries only the status transition (and, for a
 * rejection, the reason's length — never its text), never the applicant's name,
 * email, or phone (lib/audit/platform.ts privacy contract).
 */
export async function decideInstitutionApplicationAction(
  applicationId: string,
  decision: unknown,
  note: unknown,
): Promise<ApplicationDecisionResult> {
  const fail = (message: string): ApplicationDecisionResult => ({
    ok: false,
    message,
  });

  // 1. Shape checks first.
  if (typeof applicationId !== "string" || applicationId.trim().length === 0) {
    return fail("No application was specified.");
  }
  if (!isApplicationDecision(decision)) {
    return fail("That is not a valid decision.");
  }
  const action: ApplicationDecision = decision;

  // 2. Authoritative SUPER_ADMIN check for THIS request.
  const access = await inspectAccess({ roles: ["SUPER_ADMIN"] });
  if (!access.allowed) {
    await recordPlatformAudit({
      actorId: access.principal?.userId ?? null,
      actorRole: access.principal?.role ?? null,
      action: DECISION_AUDIT_ACTION[action],
      targetType: "institution_application",
      targetId: applicationId,
      outcome: "denied",
      detail: "attempted an institution-application decision",
    });
    return fail("You are not authorised to review applications.");
  }
  const actor = access.principal;

  // 3. Required note (rejection reason / information request).
  let cleanedNote: string | null = null;
  if (decisionRequiresNote(action)) {
    const validated = validateApplicationNote(action, note);
    if (!validated.ok) {
      return fail(validated.error);
    }
    cleanedNote = validated.value;
  }

  // 4. Apply (current status read + CAS enforced in the data layer).
  let result;
  try {
    result = await decideInstitutionApplication(
      applicationId,
      action,
      cleanedNote,
      actor.userId,
    );
  } catch {
    await recordPlatformAudit({
      actorId: actor.userId,
      actorRole: actor.role,
      action: DECISION_AUDIT_ACTION[action],
      targetType: "institution_application",
      targetId: applicationId,
      outcome: "failed",
      detail: "decision errored",
    });
    return fail("The decision could not be recorded right now. Please try again.");
  }

  if (!result.ok) {
    switch (result.reason) {
      case "notFound":
        return fail("This application could not be found.");
      case "invalidTransition":
        await recordPlatformAudit({
          actorId: actor.userId,
          actorRole: actor.role,
          action: DECISION_AUDIT_ACTION[action],
          targetType: "institution_application",
          targetId: applicationId,
          outcome: "failed",
          detail: "disallowed decision for the application's current state",
        });
        return fail("That decision is not allowed for this application's current state.");
      case "conflict":
        await recordPlatformAudit({
          actorId: actor.userId,
          actorRole: actor.role,
          action: DECISION_AUDIT_ACTION[action],
          targetType: "institution_application",
          targetId: applicationId,
          outcome: "failed",
          detail: "decision skipped — application changed concurrently",
        });
        return fail(
          "This application was changed by someone else just now. Reload to see its current state before deciding.",
        );
      case "duplicateName":
        await recordPlatformAudit({
          actorId: actor.userId,
          actorRole: actor.role,
          action: DECISION_AUDIT_ACTION[action],
          targetType: "institution_application",
          targetId: applicationId,
          outcome: "failed",
          detail: "approval refused — an institution with this name already exists",
        });
        return fail(
          "An institution with this name already exists, so it was not created. Resolve the name conflict before approving.",
        );
      case "selfApproval":
        await recordPlatformAudit({
          actorId: actor.userId,
          actorRole: actor.role,
          action: DECISION_AUDIT_ACTION[action],
          targetType: "institution_application",
          targetId: applicationId,
          outcome: "failed",
          detail: "refused — a reviewer cannot approve/provision their own application",
        });
        return fail(
          "You can't approve or provision your own institution application. Another platform administrator must review it.",
        );
      case "incompleteRecord":
        await recordPlatformAudit({
          actorId: actor.userId,
          actorRole: actor.role,
          action: DECISION_AUDIT_ACTION[action],
          targetType: "institution_application",
          targetId: applicationId,
          outcome: "failed",
          detail: "approval refused — stored application record is incomplete",
        });
        return fail(
          "This application is missing required details, so it cannot be approved. Request the missing information instead.",
        );
      default:
        return fail("The decision could not be recorded right now. Please try again.");
    }
  }

  // 5. Applied — audit the outcome (best-effort; a missing audit record is
  // surfaced as a warning, never silent), then refresh the queue + drawer.
  const detail = describeDecision(action, result.status, cleanedNote);
  const audited = await recordPlatformAudit({
    actorId: actor.userId,
    actorRole: actor.role,
    action: DECISION_AUDIT_ACTION[action],
    targetType: "institution_application",
    targetId: applicationId,
    outcome: "success",
    detail,
  });

  // 5b. Approval also grants workspace access — audit that outcome SEPARATELY
  //     so "approved" and "access ready" are distinct, auditable facts. A
  //     partial grant is recorded as a failed provisioning with a controlled
  //     reason token only (privacy), never an email/name/raw error. The
  //     operator is told the truth: an approved-but-unprovisioned application
  //     carries a warning, never a silent success.
  let provisioningWarning: string | undefined;
  if (action === "approve") {
    const provisioned = result.provisioning === "provisioned";
    await recordPlatformAudit({
      actorId: actor.userId,
      actorRole: actor.role,
      action: provisioned
        ? "institution_application.access_provisioned"
        : "institution_application.access_provision_failed",
      targetType: "institution_application",
      targetId: applicationId,
      outcome: provisioned ? "success" : "failed",
      detail: provisioned
        ? "workspace access ready (INSTITUTION_ADMIN)"
        : `provisioning incomplete${result.provisioningError ? `: ${result.provisioningError}` : ""}`,
    });
    if (!provisioned) {
      provisioningWarning = result.provisioningError
        ? `${PROVISIONING_ERROR_LABELS[result.provisioningError]} Use “Retry provisioning” once resolved.`
        : "The applicant's workspace access could not be provisioned. Use “Retry provisioning” once resolved.";
    }
  }

  revalidatePath("/platform/institutions/pending-approvals");
  return {
    ok: true,
    status: result.status,
    provisioning: result.provisioning,
    ...(provisioningWarning
      ? { warning: provisioningWarning }
      : audited
        ? {}
        : {
            warning:
              "The decision was recorded, but its audit entry could not be saved. Please note it manually and report this to platform operations.",
          }),
  };
}

/**
 * A short, privacy-safe audit summary. For a rejection it records only that a
 * reason was captured and its length — never the reason text (which the
 * application row already stores). No personal data is placed here.
 */
function describeDecision(
  action: ApplicationDecision,
  status: ApplicationStatus,
  note: string | null,
): string {
  const to = APPLICATION_STATUS_LABELS[status];
  if (action === "reject") {
    return `→ ${to} (reason captured, ${note?.trim().length ?? 0} chars)`;
  }
  if (action === "request_information") {
    return `→ ${to}`;
  }
  if (action === "put_on_hold") {
    return `→ ${to} (hold reason captured, ${note?.trim().length ?? 0} chars)`;
  }
  return `→ ${to}`;
}

/**
 * Secure recovery path: re-run applicant access provisioning for an approved
 * application whose first attempt only partially completed (e.g. the Clerk
 * write failed after the membership landed). Same trust model as the decision
 * action — the browser is trusted for NOTHING:
 *   1. Re-check SUPER_ADMIN; a denied attempt is audited and refused without
 *      confirming the application exists.
 *   2. The data layer re-reads the row, refuses a non-approved application, and
 *      enforces the self-provisioning guard (a reviewer cannot provision their
 *      OWN application).
 *   3. The operation is idempotent — a re-run never duplicates the tenant or
 *      the membership, and a fully-provisioned row short-circuits.
 *   4. The outcome is audited (provisioned / still-incomplete) and reported
 *      truthfully; a not-ready state is never presented as success.
 */
export async function retryApplicationProvisioningAction(
  applicationId: unknown,
): Promise<ProvisioningActionResult> {
  const fail = (message: string): ProvisioningActionResult => ({
    ok: false,
    message,
  });

  if (typeof applicationId !== "string" || applicationId.trim().length === 0) {
    return fail("No application was specified.");
  }

  const access = await inspectAccess({ roles: ["SUPER_ADMIN"] });
  if (!access.allowed) {
    await recordPlatformAudit({
      actorId: access.principal?.userId ?? null,
      actorRole: access.principal?.role ?? null,
      action: "institution_application.access_provision_failed",
      targetType: "institution_application",
      targetId: applicationId,
      outcome: "denied",
      detail: "attempted to retry applicant access provisioning",
    });
    return fail("You are not authorised to provision applicant access.");
  }
  const actor = access.principal;

  let result;
  try {
    result = await retryApplicationProvisioning(applicationId, actor.userId);
  } catch {
    await recordPlatformAudit({
      actorId: actor.userId,
      actorRole: actor.role,
      action: "institution_application.access_provision_failed",
      targetType: "institution_application",
      targetId: applicationId,
      outcome: "failed",
      detail: "provisioning retry errored",
    });
    return fail("Provisioning could not be retried right now. Please try again.");
  }

  if (!result.ok) {
    switch (result.reason) {
      case "notFound":
        return fail("This application could not be found.");
      case "notApproved":
        return fail(
          "Workspace access can only be provisioned for an approved application.",
        );
      default:
        // selfProvision — mirror the approval guard's refusal, then audit it.
        await recordPlatformAudit({
          actorId: actor.userId,
          actorRole: actor.role,
          action: "institution_application.access_provision_failed",
          targetType: "institution_application",
          targetId: applicationId,
          outcome: "failed",
          detail: "refused — a reviewer cannot provision access to their own application",
        });
        return fail(
          "You can't provision access to your own institution application.",
        );
    }
  }

  const provisioned = result.provisioning === "provisioned";
  await recordPlatformAudit({
    actorId: actor.userId,
    actorRole: actor.role,
    action: provisioned
      ? "institution_application.access_provisioned"
      : "institution_application.access_provision_failed",
    targetType: "institution_application",
    targetId: applicationId,
    outcome: provisioned ? "success" : "failed",
    detail: provisioned
      ? "workspace access ready (INSTITUTION_ADMIN)"
      : `provisioning retry incomplete${result.provisioningError ? `: ${result.provisioningError}` : ""}`,
  });

  revalidatePath("/platform/institutions/pending-approvals");
  return { ok: true, provisioning: result.provisioning };
}
