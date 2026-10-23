/**
 * Institution applications — pure, dependency-free, unit-testable contract
 * (the same layering as lib/institutions.ts and lib/audit/platform.ts: no
 * Clerk, no Next, no Supabase).
 *
 * WHY THIS EXISTS
 * A "pending institution approval" is a pre-tenant request reviewed by a
 * SUPER_ADMIN before any workspace exists. It is NOT an institution with
 * status 'active'/'suspended' (those are operational tenants — see
 * lib/institutions.ts). This module owns the vocabulary and rules for the
 * application queue so the data layer, the server actions, the UI, and the
 * tests can never disagree about which statuses exist, which decisions are
 * legal, or how an untrusted query string is sanitised.
 *
 * FAIL-CLOSED BY CONSTRUCTION
 * A decision is allowed only if it appears in ALLOWED_DECISION_TRANSITIONS.
 * Unknown status/type/date-range values arriving from searchParams are dropped
 * (treated as "no filter"), never passed through as an arbitrary column value.
 * A required field is never defaulted. Personal data is minimised: this layer
 * only ever describes business-contact fields the applicant themselves submits.
 */

import {
  INSTITUTION_TYPES,
  isInstitutionType,
  institutionTypeLabel,
  normalizeContactPhone,
  type InstitutionType,
} from "./institutions.ts";

// Re-export so consumers of the application contract get the shared, coarse
// type vocabulary from one place (the same controlled list the directory uses).
export { INSTITUTION_TYPES, isInstitutionType, institutionTypeLabel };
export type { InstitutionType };

// --- Application status -----------------------------------------------------

/**
 * The review-queue lifecycle. Distinct from institutions.status.
 * - `draft`             : started by the applicant, NOT yet submitted. Never
 *                         enters the review queue (the queue lists submitted
 *                         rows only) and cannot be decided by a reviewer.
 * - `pending_review`    : submitted, awaiting a decision (the submit default).
 * - `needs_information` : a super admin asked the applicant for more detail;
 *                         the applicant may respond, which re-queues it.
 * - `on_hold`           : review PAUSED by a super admin with a recorded
 *                         reason. Not terminal — the reviewer can still
 *                         request information, approve, or reject from here.
 * - `approved`          : terminal — accepted, a tenant record was created.
 * - `rejected`          : terminal — declined, with a recorded reason.
 * (0016 defined the four review states; 0019 adds `draft` and `on_hold`.)
 */
export const APPLICATION_STATUSES = [
  "draft",
  "pending_review",
  "needs_information",
  "on_hold",
  "approved",
  "rejected",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export function isApplicationStatus(
  value: unknown,
): value is ApplicationStatus {
  return (
    typeof value === "string" &&
    (APPLICATION_STATUSES as readonly string[]).includes(value)
  );
}

/** Normalise an unknown value to a status or `null` (never a default guess). */
export function normalizeApplicationStatus(
  value: unknown,
): ApplicationStatus | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase();
  return isApplicationStatus(candidate) ? candidate : null;
}

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  draft: "Draft",
  pending_review: "Pending review",
  needs_information: "Needs information",
  on_hold: "On hold",
  approved: "Approved",
  rejected: "Rejected",
};

export const APPLICATION_STATUS_TONES: Record<
  ApplicationStatus,
  "neutral" | "warning" | "info" | "success" | "danger"
> = {
  draft: "neutral",
  pending_review: "warning",
  needs_information: "info",
  on_hold: "neutral",
  approved: "success",
  rejected: "danger",
};

/** The non-terminal states — an application that is started but not decided. */
export const OPEN_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  "draft",
  "pending_review",
  "needs_information",
  "on_hold",
];

export function isOpenApplication(status: ApplicationStatus): boolean {
  return OPEN_APPLICATION_STATUSES.includes(status);
}

/**
 * The statuses a reviewer may see and filter in the queue. Drafts are
 * deliberately absent: an unfinished application is private to its applicant
 * until they submit it, so the queue list and its counts exclude them (the
 * data layer filters with `.neq('status','draft')`).
 */
export const APPLICATION_QUEUE_STATUSES: readonly ApplicationStatus[] = [
  "pending_review",
  "needs_information",
  "on_hold",
  "approved",
  "rejected",
];

// --- Reviewer decisions -----------------------------------------------------

/**
 * The actions a SUPER_ADMIN can take on an application. `approve` and `reject`
 * are terminal; `request_information` moves an open application to
 * needs_information. Each maps to exactly one target status.
 */
export const APPLICATION_DECISIONS = [
  "approve",
  "reject",
  "request_information",
  "put_on_hold",
] as const;

export type ApplicationDecision = (typeof APPLICATION_DECISIONS)[number];

export function isApplicationDecision(
  value: unknown,
): value is ApplicationDecision {
  return (
    typeof value === "string" &&
    (APPLICATION_DECISIONS as readonly string[]).includes(value)
  );
}

/** The status a decision moves an application into. */
export const DECISION_TARGET_STATUS: Record<
  ApplicationDecision,
  ApplicationStatus
> = {
  approve: "approved",
  reject: "rejected",
  request_information: "needs_information",
  put_on_hold: "on_hold",
};

/**
 * The ONLY legal decisions from a given status. Fail-closed:
 *   - from any SUBMITTED open state (pending_review / needs_information /
 *     on_hold) a reviewer may approve / reject / request info / put on hold,
 *   - `draft` offers nothing: an unsubmitted application never reaches a
 *     reviewer, and the queue hides it — so a decision on it is refused,
 *   - `approved` and `rejected` are terminal (no decisions offered or allowed),
 *   - requesting information again from needs_information is permitted (an
 *     updated note), and a held application can be resumed through any of the
 *     three exits — hold pauses a review, it never ends one.
 * The UI renders exactly these actions, so it can never offer a move the
 * server would refuse.
 */
export const ALLOWED_DECISION_TRANSITIONS: Record<
  ApplicationStatus,
  readonly ApplicationDecision[]
> = {
  draft: [],
  pending_review: ["request_information", "put_on_hold", "reject", "approve"],
  needs_information: ["request_information", "put_on_hold", "reject", "approve"],
  on_hold: ["request_information", "reject", "approve"],
  approved: [],
  rejected: [],
};

export function canApplyDecision(
  from: ApplicationStatus,
  decision: ApplicationDecision,
): boolean {
  return ALLOWED_DECISION_TRANSITIONS[from].includes(decision);
}

/** Decisions available from a status, in a stable display order. */
export function availableDecisions(
  from: ApplicationStatus,
): readonly ApplicationDecision[] {
  return ALLOWED_DECISION_TRANSITIONS[from];
}

/**
 * Whether a decision needs a written reason the applicant will see. Rejection,
 * a request-for-information, and putting a review on hold all do; approval
 * does not.
 */
export function decisionRequiresNote(decision: ApplicationDecision): boolean {
  return (
    decision === "reject" ||
    decision === "request_information" ||
    decision === "put_on_hold"
  );
}

export const APPLICATION_DECISION_LABELS: Record<ApplicationDecision, string> = {
  approve: "Approve institution",
  reject: "Reject application",
  request_information: "Request information",
  put_on_hold: "Put on hold",
};

// --- Applicant access provisioning (post-approval) --------------------------
//
// Approval creates the tenant; PROVISIONING attaches the applicant to it as the
// first INSTITUTION_ADMIN and writes the trusted Clerk `privateMetadata` the
// auth stack reads (lib/auth/context.ts → principal.ts). Supabase and Clerk
// cannot share one atomic transaction, so the outcome is recorded as a durable,
// recoverable state: a partial failure (e.g. the Clerk write fails after the DB
// membership lands) is marked `needs_retry` and re-run by an authorised
// SUPER_ADMIN without duplicating the tenant or the membership. `provisioning_
// status` is only meaningful once the application is `approved`.

export const PROVISIONING_STATUSES = [
  "not_required",
  "provisioned",
  "needs_retry",
] as const;

export type ProvisioningStatus = (typeof PROVISIONING_STATUSES)[number];

export function isProvisioningStatus(
  value: unknown,
): value is ProvisioningStatus {
  return (
    typeof value === "string" &&
    (PROVISIONING_STATUSES as readonly string[]).includes(value)
  );
}

/** Anything unrecognised (or absent) degrades to `not_required` — the safe,
 *  "access not granted" reading; a corrupt value never implies access. */
export function normalizeProvisioningStatus(
  value: unknown,
): ProvisioningStatus {
  return isProvisioningStatus(value) ? value : "not_required";
}

export const PROVISIONING_STATUS_LABELS: Record<ProvisioningStatus, string> = {
  not_required: "Not provisioned",
  provisioned: "Workspace access ready",
  needs_retry: "Provisioning needs attention",
};

export const PROVISIONING_STATUS_TONES: Record<
  ProvisioningStatus,
  "neutral" | "success" | "warning"
> = {
  not_required: "neutral",
  provisioned: "success",
  needs_retry: "warning",
};

/**
 * Controlled, non-sensitive reason tokens for a failed / partial provisioning.
 * Stored so an operator can see WHICH step to retry; never free text or
 * personal data (AGENTS.md §7). Each maps to a distinct recovery action.
 */
export const PROVISIONING_ERROR_CODES = [
  "applicant_missing",
  "tenant_missing",
  "role_conflict",
  "membership_write_failed",
  "clerk_metadata_failed",
] as const;

export type ProvisioningErrorCode =
  (typeof PROVISIONING_ERROR_CODES)[number];

export function isProvisioningErrorCode(
  value: unknown,
): value is ProvisioningErrorCode {
  return (
    typeof value === "string" &&
    (PROVISIONING_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Normalise a stored token; anything unknown (or blank) → `null`. */
export function normalizeProvisioningError(
  value: unknown,
): ProvisioningErrorCode | null {
  return isProvisioningErrorCode(value) ? value : null;
}

/** Operator-facing wording for each recovery reason. Never leaks internals. */
export const PROVISIONING_ERROR_LABELS: Record<ProvisioningErrorCode, string> = {
  applicant_missing:
    "The applicant account could not be resolved, so access was not granted.",
  tenant_missing:
    "The approved institution record is missing, so access could not be provisioned.",
  role_conflict:
    "That account already holds a different role, so its access was left unchanged.",
  membership_write_failed:
    "The institution membership could not be saved. Retry provisioning.",
  clerk_metadata_failed:
    "The trusted role could not be written to the account. Retry provisioning.",
};

/**
 * Whether an approved application has usable workspace access. True ONLY when
 * the decision is `approved` AND provisioning fully succeeded — so the UI can
 * never claim an applicant is "in" while a step is pending or failed.
 */
export function workspaceAccessReady(
  status: ApplicationStatus,
  provisioning: ProvisioningStatus,
): boolean {
  return status === "approved" && provisioning === "provisioned";
}

/**
 * Self-approval / self-provisioning guard: a SUPER_ADMIN must not approve or
 * provision the application belonging to their OWN applicant account. Blank
 * ids are never a match (an unrelated blank must not block a legitimate
 * decision; a genuinely missing applicant is caught separately during
 * provisioning).
 */
export function isSelfApplication(
  applicantUserId: string | null | undefined,
  actorUserId: string | null | undefined,
): boolean {
  if (typeof applicantUserId !== "string" || typeof actorUserId !== "string") {
    return false;
  }
  const applicant = applicantUserId.trim();
  const actor = actorUserId.trim();
  return applicant.length > 0 && actor.length > 0 && applicant === actor;
}

// --- Review note bounds -----------------------------------------------------

/** Matches the 0016 CHECK bounds on rejection_reason / info_request_note. */
export const APPLICATION_NOTE_LIMITS = {
  note: 500,
} as const;

export type ApplicationNoteResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validate a required reviewer note (rejection reason / information request).
 * Required, trimmed, bounded. Returns the cleaned value or a single message —
 * the caller only invokes this when `decisionRequiresNote` is true.
 */
export function validateApplicationNote(
  decision: ApplicationDecision,
  raw: unknown,
): ApplicationNoteResult {
  const value = typeof raw === "string" ? raw.trim() : "";
  const label =
    decision === "reject"
      ? "rejection reason"
      : decision === "put_on_hold"
        ? "hold reason"
        : "note";
  if (value.length === 0) {
    return { ok: false, error: `A ${label} is required.` };
  }
  if (value.length > APPLICATION_NOTE_LIMITS.note) {
    return {
      ok: false,
      error: `The ${label} must be ${APPLICATION_NOTE_LIMITS.note} characters or fewer.`,
    };
  }
  return { ok: true, value };
}

// --- Submission input (public applicant form) -------------------------------
// The pure input contract behind an applicant submitting an institution
// registration. Bounds mirror migration 0016's CHECK constraints and reuse the
// phone/email normalisation already proven in lib/institutions.ts, so a value
// that passes here cannot be refused by the database.

export const APPLICATION_SUBMISSION_LIMITS = {
  institutionName: 160,
  description: 500,
  country: 60,
  state: 60,
  city: 80,
  address: 200,
  contactPerson: 120,
  contactEmail: 254,
  contactPhone: 16,
} as const;

export type ApplicationSubmissionField =
  | "institutionName"
  | "institutionType"
  | "contactPerson"
  | "contactEmail"
  | "contactPhone"
  | "country"
  | "state"
  | "city"
  | "address"
  | "description";

/** The validated, normalised payload the data layer writes. */
export type CleanApplicationSubmission = {
  institutionName: string;
  institutionType: InstitutionType;
  contactPerson: string;
  /** Lower-cased for stable uniqueness / contact. */
  contactEmail: string;
  /** Normalised to optional `+` plus digits. */
  contactPhone: string;
  country: string;
  state: string;
  city: string;
  address: string;
  description: string | null;
};

export type ApplicationSubmissionResult =
  | { ok: true; value: CleanApplicationSubmission }
  | {
      ok: false;
      errors: Partial<Record<ApplicationSubmissionField, string>>;
      values: Record<ApplicationSubmissionField, string>;
    };

const CONTACT_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function rawField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate raw submission input (every value untrusted). Collects ALL field
 * errors in one pass so the form shows every problem at once.
 */
export function validateApplicationSubmission(
  raw: Record<string, unknown>,
): ApplicationSubmissionResult {
  const values: Record<ApplicationSubmissionField, string> = {
    institutionName: rawField(raw.institutionName),
    institutionType: rawField(raw.institutionType),
    contactPerson: rawField(raw.contactPerson),
    contactEmail: rawField(raw.contactEmail),
    contactPhone: rawField(raw.contactPhone),
    country: rawField(raw.country),
    state: rawField(raw.state),
    city: rawField(raw.city),
    address: rawField(raw.address),
    description: rawField(raw.description),
  };

  const errors: Partial<Record<ApplicationSubmissionField, string>> = {};
  const limits = APPLICATION_SUBMISSION_LIMITS;

  const required: Array<{
    key: ApplicationSubmissionField;
    label: string;
    max: number;
  }> = [
    { key: "institutionName", label: "Institution name", max: limits.institutionName },
    { key: "contactPerson", label: "Contact person", max: limits.contactPerson },
    { key: "country", label: "Country", max: limits.country },
    { key: "state", label: "State", max: limits.state },
    { key: "city", label: "City", max: limits.city },
    { key: "address", label: "Full address", max: limits.address },
  ];
  for (const field of required) {
    const value = values[field.key];
    if (value.length === 0) {
      errors[field.key] = `${field.label} is required.`;
    } else if (value.length > field.max) {
      errors[field.key] = `${field.label} must be ${field.max} characters or fewer.`;
    }
  }

  if (values.institutionType.length === 0) {
    errors.institutionType = "Choose the type of institution.";
  } else if (!isInstitutionType(values.institutionType)) {
    errors.institutionType = "That institution type is not supported.";
  }

  if (values.contactEmail.length === 0) {
    errors.contactEmail = "Contact email is required.";
  } else if (values.contactEmail.length > limits.contactEmail) {
    errors.contactEmail = `Contact email must be ${limits.contactEmail} characters or fewer.`;
  } else if (!CONTACT_EMAIL_PATTERN.test(values.contactEmail)) {
    errors.contactEmail = "Enter a valid email address, e.g. admin@school.edu.ng.";
  }

  if (values.contactPhone.length === 0) {
    errors.contactPhone = "Contact phone is required.";
  } else if (normalizeContactPhone(values.contactPhone) === null) {
    errors.contactPhone =
      "Enter a valid phone number with country code, e.g. +234 803 123 4567.";
  } else if (
    normalizeContactPhone(values.contactPhone)!.length > limits.contactPhone
  ) {
    errors.contactPhone = "That phone number is too long.";
  }

  if (values.description.length > limits.description) {
    errors.description = `Description must be ${limits.description} characters or fewer.`;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, values };
  }

  const institutionType = values.institutionType as InstitutionType;
  const contactPhone = normalizeContactPhone(values.contactPhone);
  if (contactPhone === null) {
    // Unreachable (validated above); keeps the return total without an assert.
    return {
      ok: false,
      errors: { contactPhone: "Enter a valid phone number." },
      values,
    };
  }

  return {
    ok: true,
    value: {
      institutionName: values.institutionName,
      institutionType,
      contactPerson: values.contactPerson,
      contactEmail: values.contactEmail.toLowerCase(),
      contactPhone,
      country: values.country,
      state: values.state,
      city: values.city,
      address: values.address,
      description: values.description.length > 0 ? values.description : null,
    },
  };
}

// --- Draft save (pre-submission) --------------------------------------------
// A draft is a partially completed application the applicant has NOT submitted.
// Rules mirror the 0019 storage contract: only the institution name is needed
// to keep the draft identifiable; every OTHER field may be absent, but a field
// that IS present must already satisfy the same bounds/formats the database
// CHECKs enforce — so a saved draft can never contain a value that submission
// (or the storage layer) would later refuse.

/** The cleaned draft payload: present fields only, empty ones as `null`. */
export type CleanApplicationDraft = {
  institutionName: string;
  institutionType: InstitutionType | null;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  description: string | null;
};

export type ApplicationDraftResult =
  | { ok: true; value: CleanApplicationDraft }
  | {
      ok: false;
      errors: Partial<Record<ApplicationSubmissionField, string>>;
      values: Record<ApplicationSubmissionField, string>;
    };

/**
 * Map a stored draft onto string form values (null → blank) so the applicant
 * dashboard can pre-fill a resumed draft or an information response. Pure and
 * shared: the server page uses it, the client form never has to know the
 * stored shape.
 */
export function applicationDraftToFormValues(
  draft: CleanApplicationDraft,
): Record<ApplicationSubmissionField, string> {
  const blank = (value: string | null): string => value ?? "";
  return {
    institutionName: draft.institutionName,
    institutionType: draft.institutionType ?? "",
    contactPerson: blank(draft.contactPerson),
    contactEmail: blank(draft.contactEmail),
    contactPhone: blank(draft.contactPhone),
    country: blank(draft.country),
    state: blank(draft.state),
    city: blank(draft.city),
    address: blank(draft.address),
    description: blank(draft.description),
  };
}

export function validateApplicationDraft(
  raw: Record<string, unknown>,
): ApplicationDraftResult {
  const values: Record<ApplicationSubmissionField, string> = {
    institutionName: rawField(raw.institutionName),
    institutionType: rawField(raw.institutionType),
    contactPerson: rawField(raw.contactPerson),
    contactEmail: rawField(raw.contactEmail),
    contactPhone: rawField(raw.contactPhone),
    country: rawField(raw.country),
    state: rawField(raw.state),
    city: rawField(raw.city),
    address: rawField(raw.address),
    description: rawField(raw.description),
  };

  const errors: Partial<Record<ApplicationSubmissionField, string>> = {};
  const limits = APPLICATION_SUBMISSION_LIMITS;

  const optionalBounded: Array<{ key: ApplicationSubmissionField; label: string; max: number }> = [
    { key: "contactPerson", label: "Contact person", max: limits.contactPerson },
    { key: "country", label: "Country", max: limits.country },
    { key: "state", label: "State", max: limits.state },
    { key: "city", label: "City", max: limits.city },
    { key: "address", label: "Full address", max: limits.address },
  ];

  // The name identifies the draft — required, bounded, same rule as submit.
  const name = values.institutionName;
  if (name.length === 0) {
    errors.institutionName = "Add at least the institution name to save a draft.";
  } else if (name.length > limits.institutionName) {
    errors.institutionName = `Institution name must be ${limits.institutionName} characters or fewer.`;
  }

  for (const field of optionalBounded) {
    const value = values[field.key];
    if (value.length > field.max) {
      errors[field.key] = `${field.label} must be ${field.max} characters or fewer.`;
    }
  }

  if (
    values.institutionType.length > 0 &&
    !isInstitutionType(values.institutionType)
  ) {
    errors.institutionType = "That institution type is not supported.";
  }

  if (values.contactEmail.length > 0) {
    if (values.contactEmail.length > limits.contactEmail) {
      errors.contactEmail = `Contact email must be ${limits.contactEmail} characters or fewer.`;
    } else if (!CONTACT_EMAIL_PATTERN.test(values.contactEmail)) {
      errors.contactEmail = "Enter a valid email address, e.g. admin@school.edu.ng.";
    }
  }

  if (values.contactPhone.length > 0) {
    const normalized = normalizeContactPhone(values.contactPhone);
    if (normalized === null) {
      errors.contactPhone =
        "Enter a valid phone number with country code, e.g. +234 803 123 4567.";
    } else if (normalized.length > limits.contactPhone) {
      errors.contactPhone = "That phone number is too long.";
    }
  }

  if (values.description.length > limits.description) {
    errors.description = `Description must be ${limits.description} characters or fewer.`;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, values };
  }

  const optional = (value: string): string | null =>
    value.length > 0 ? value : null;

  return {
    ok: true,
    value: {
      institutionName: values.institutionName,
      institutionType: isInstitutionType(values.institutionType)
        ? values.institutionType
        : null,
      contactPerson: optional(values.contactPerson),
      contactEmail:
        values.contactEmail.length > 0
          ? values.contactEmail.toLowerCase()
          : null,
      contactPhone: values.contactPhone.length > 0
        ? normalizeContactPhone(values.contactPhone)
        : null,
      country: optional(values.country),
      state: optional(values.state),
      city: optional(values.city),
      address: optional(values.address),
      description: optional(values.description),
    },
  };
}

// --- Applicant response to a needs_information request ----------------------
// The applicant answers the reviewer's request on the SAME row (the 0019
// response columns): every application field is re-validated in full (a
// response may also correct details), and the answer note is required so a
// reviewer never receives a bare "I responded" with no content.

export const APPLICATION_RESPONSE_NOTE_LIMIT = 1000;

export type ApplicationResponseField = ApplicationSubmissionField | "responseNote";

export type CleanApplicationResponse = CleanApplicationSubmission & {
  responseNote: string;
};

export type ApplicationResponseResult =
  | { ok: true; value: CleanApplicationResponse }
  | {
      ok: false;
      errors: Partial<Record<ApplicationResponseField, string>>;
      values: Record<ApplicationSubmissionField, string> & {
        responseNote: string;
      };
    };

export function validateApplicationResponse(
  raw: Record<string, unknown>,
): ApplicationResponseResult {
  const submission = validateApplicationSubmission(raw);
  const note = rawField(raw.responseNote);

  const errors: Partial<Record<ApplicationResponseField, string>> =
    submission.ok ? {} : submission.errors;
  if (note.length === 0) {
    errors.responseNote = "Write your response to the requested information.";
  } else if (note.length > APPLICATION_RESPONSE_NOTE_LIMIT) {
    errors.responseNote = `The response must be ${APPLICATION_RESPONSE_NOTE_LIMIT} characters or fewer.`;
  }

  // Values echoed back for re-filling the form: the raw strings the caller
  // sent (validation failures) or the cleaned ones (note-only failure).
  let values: Record<ApplicationSubmissionField, string>;
  if (submission.ok) {
    values = {
      institutionName: submission.value.institutionName,
      institutionType: submission.value.institutionType,
      contactPerson: submission.value.contactPerson,
      contactEmail: submission.value.contactEmail,
      contactPhone: submission.value.contactPhone,
      country: submission.value.country,
      state: submission.value.state,
      city: submission.value.city,
      address: submission.value.address,
      description: submission.value.description ?? "",
    };
  } else {
    values = submission.values;
  }

  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      errors,
      values: { ...values, responseNote: note },
    };
  }

  if (!submission.ok) {
    // Defensive: errors would be non-empty above, so this is unreachable —
    // kept so the return stays total without an assertion.
    return {
      ok: false,
      errors: submission.errors,
      values: { ...submission.values, responseNote: note },
    };
  }

  return {
    ok: true,
    value: { ...submission.value, responseNote: note },
  };
}

// --- Review queue query resolution (untrusted searchParams) -----------------

export const APPLICATION_PAGE_SIZE = 20;

/** Bounded, validated filter set for the pending-approvals queue. */
export type ApplicationQueueQuery = {
  q: string;
  status: ApplicationStatus | null;
  type: InstitutionType | null;
  /** Days back to include by submission date; `null` means "all time". */
  withinDays: number | null;
  page: number;
  pageSize: number;
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

const SEARCH_MAX_LENGTH = 120;

/** Allowed date-range presets (days). Anything else clamps to "all time". */
export const APPLICATION_DATE_RANGES = [
  { value: "7", days: 7, label: "Last 7 days" },
  { value: "30", days: 30, label: "Last 30 days" },
  { value: "90", days: 90, label: "Last 90 days" },
  { value: "all", days: null, label: "All time" },
] as const;

export type ApplicationDateRangeValue =
  (typeof APPLICATION_DATE_RANGES)[number]["value"];

function resolveWithinDays(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  const match = APPLICATION_DATE_RANGES.find((r) => r.value === trimmed);
  // Unknown / absent → "all time" (no date filter), never an arbitrary number.
  return match ? match.days : null;
}

/** Turn raw searchParams into a safe, bounded queue query. */
export function resolveApplicationQueueQuery(searchParams: {
  q?: string | string[];
  status?: string | string[];
  type?: string | string[];
  range?: string | string[];
  page?: string | string[];
}): ApplicationQueueQuery {
  const rawQuery = firstValue(searchParams.q).trim().slice(0, SEARCH_MAX_LENGTH);
  const parsed = Number.parseInt(firstValue(searchParams.page), 10);
  const rawType = firstValue(searchParams.type).trim().toLowerCase();
  return {
    q: rawQuery,
    status: normalizeApplicationStatus(firstValue(searchParams.status)),
    type: isInstitutionType(rawType) ? rawType : null,
    withinDays: resolveWithinDays(firstValue(searchParams.range)),
    page: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
    pageSize: APPLICATION_PAGE_SIZE,
  };
}

/**
 * Build a queue URL for a page, preserving active filters. Empty/default
 * values are omitted so the unfiltered first page is a clean path.
 */
export function applicationQueueHref(
  base: string,
  query: ApplicationQueueQuery,
  page: number,
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status) params.set("status", query.status);
  if (query.type) params.set("type", query.type);
  const range = APPLICATION_DATE_RANGES.find((r) => r.days === query.withinDays);
  if (range && range.value !== "all") params.set("range", range.value);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Escape a free-text term for a PostgREST `ilike` contains-pattern (mirrors
 * toInstitutionContainsPattern). Returns "" for empty/only-noise so the caller
 * skips the filter rather than sends a broken one.
 */
export function toApplicationContainsPattern(term: string): string {
  const cleaned = term.replace(/[*,%()]/g, "").trim();
  return cleaned.length > 0 ? `%${cleaned}%` : "";
}

/** A short, honest location line for the table (never a guessed value). */
export function formatApplicationLocation(parts: {
  city?: string | null;
  state?: string | null;
  country?: string | null;
}): string {
  const present = [parts.city, parts.state, parts.country]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0);
  return present.length > 0 ? present.join(", ") : "—";
}
