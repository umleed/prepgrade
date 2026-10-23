"use server";

import { revalidatePath } from "next/cache";
import { inspectAccess } from "@/lib/auth/guards";
import { recordPlatformAudit } from "@/lib/data/audit";
import {
  createPlatformInstitution,
  setInstitutionStatus,
} from "@/lib/data/platform-overview";
import {
  INSTITUTION_STATUS_LABELS,
  INSTITUTION_TYPE_LABELS,
  isInstitutionStatus,
  validateInstitutionRegistration,
  type InstitutionRegistrationField,
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

// --- Institution registration ("Add Institution") --------------------------

/** Fields the form re-renders after a rejected submission. */
export type InstitutionRegistrationValues = Record<
  InstitutionRegistrationField,
  string
>;

/**
 * Progressive state for the registration form (`useActionState`). `null` is
 * the untouched form; every other variant carries exactly what the form needs
 * to re-render honestly — field errors + submitted values, a top-level
 * message, or the created institution for the success panel.
 */
export type InstitutionRegistrationState = {
  /** Per-field validation messages (same contract as the pure validator). */
  errors?: Partial<Record<InstitutionRegistrationField, string>>;
  /** The submitted values, so a rejected submission is never lost. */
  values?: InstitutionRegistrationValues;
  /** Top-level failure (authorisation, duplicate, storage error). */
  message?: string;
  /** Success: the created tenant, for the confirmation panel + links. */
  created?: { id: string; name: string };
  /** Set when the row exists but its audit record could not be written. */
  warning?: string;
} | null;

/** Read the registration fields out of FormData as raw strings. */
function registrationValues(form: FormData): InstitutionRegistrationValues {
  const text = (key: InstitutionRegistrationField): string => {
    const value = form.get(key);
    return typeof value === "string" ? value : "";
  };
  return {
    name: text("name"),
    type: text("type"),
    shortName: text("shortName"),
    description: text("description"),
    country: text("country"),
    state: text("state"),
    city: text("city"),
    address: text("address"),
    contactPerson: text("contactPerson"),
    contactEmail: text("contactEmail"),
    contactPhone: text("contactPhone"),
  };
}

/**
 * Register a new institution from the platform area — the sensitive tenant
 * creation write.
 *
 * Enforcement order (AGENTS.md §5, §7), mirroring the status-change action:
 *   1. Validate every field through the pure contract BEFORE any privileged
 *      work; a malformed submission never reaches the database or the audit
 *      log, and the operator sees all field errors at once.
 *   2. Re-check SUPER_ADMIN from the trusted session for THIS request — the
 *      page guard is convenience, this is enforcement. A denied attempt is
 *      audited (`institution.created`, outcome denied) with no target id, and
 *      the response does not confirm anything about the would-be tenant.
 *   3. Create through the data layer, which enforces duplicate prevention via
 *      the pre-check AND the 0015 unique index (race-safe). Duplicates and
 *      errors are audited as failed; nothing is half-created — the insert is
 *      a single statement, so the tenant either exists or does not.
 *   4. Audit the success (best-effort, same contract as the status action:
 *      a missing audit record is surfaced as a warning, never silent), then
 *      revalidate the directory. The form shows a success panel with links;
 *      no privileged user, membership, or email is created or sent here —
 *      those depend on workflows that do not exist yet.
 *
 * The audit detail carries only the controlled-vocabulary type — never the
 * free-text name or contact values (lib/audit/platform.ts privacy contract).
 */
export async function createInstitutionAction(
  _previous: InstitutionRegistrationState,
  form: FormData,
): Promise<InstitutionRegistrationState> {
  const values = registrationValues(form);

  // 1. Pure validation first (fail closed, all errors at once).
  const validated = validateInstitutionRegistration(values);
  if (!validated.ok) {
    return { errors: validated.errors, values: validated.values };
  }

  // 2. Authoritative SUPER_ADMIN check for THIS request.
  const decision = await inspectAccess({ roles: ["SUPER_ADMIN"] });
  if (!decision.allowed) {
    await recordPlatformAudit({
      actorId: decision.principal?.userId ?? null,
      actorRole: decision.principal?.role ?? null,
      action: "institution.created",
      targetType: "institution",
      targetId: null,
      outcome: "denied",
      detail: "attempted institution registration",
    });
    return {
      message: "You are not authorised to register institutions.",
      values,
    };
  }
  const actor = decision.principal;

  // 3. Create (duplicate-safe at both layers, see the data function).
  let result;
  try {
    result = await createPlatformInstitution(validated.value);
  } catch {
    await recordPlatformAudit({
      actorId: actor.userId,
      actorRole: actor.role,
      action: "institution.created",
      targetType: "institution",
      targetId: null,
      outcome: "failed",
      detail: "registration errored before the tenant was created",
    });
    return {
      message:
        "The institution could not be created right now. Nothing was saved — please try again.",
      values,
    };
  }

  if (!result.ok) {
    // duplicateName — the friendly pre-check or the DB constraint refused the
    // second tenant with the same normalised name. Nothing was created.
    await recordPlatformAudit({
      actorId: actor.userId,
      actorRole: actor.role,
      action: "institution.created",
      targetType: "institution",
      targetId: null,
      outcome: "failed",
      detail: "duplicate institution name refused",
    });
    return {
      message:
        "An institution with this name already exists, so no duplicate was created. Search the directory to confirm before registering again.",
      errors: { name: "That institution name is already taken." },
      values,
    };
  }

  // 4. Applied — audit the creation (best-effort; a missing audit record is
  // surfaced as a warning, matching the status-change contract), refresh the
  // directory, and hand the form a success state.
  const audited = await recordPlatformAudit({
    actorId: actor.userId,
    actorRole: actor.role,
    action: "institution.created",
    targetType: "institution",
    targetId: result.id,
    outcome: "success",
    detail: `registered as ${INSTITUTION_TYPE_LABELS[validated.value.type]}`,
  });

  revalidatePath("/platform/institutions");
  return {
    created: { id: result.id, name: validated.value.name },
    ...(audited
      ? {}
      : {
          warning:
            "The institution was created, but its audit record could not be saved. Please note the registration manually and report this to platform operations.",
        }),
  };
}
