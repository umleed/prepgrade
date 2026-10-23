/**
 * Institution lifecycle & directory contract — pure, dependency-free, and
 * unit-testable (the same layering as classes.ts / students.ts /
 * audit/platform.ts: no Clerk, no Next, no Supabase).
 *
 * WHY THIS EXISTS (prompt 32)
 * The platform-admin institution directory lets a SUPER_ADMIN search, inspect,
 * and change an institution's OPERATIONAL STATUS for support. "Authentication
 * is not authorization" (AGENTS.md §5) extends here: a status change is only
 * ever allowed if it is one of a small set of APPROVED transitions, and that
 * rule lives in exactly one place — this module — so the server action, the
 * data layer, the UI, and the tests can never drift into disagreeing about
 * which moves are legal.
 *
 * ARCHIVE, NEVER DELETE (AGENTS.md §6)
 * Institutions own exams, attempts, and results (prompts 15–24). A tenant that
 * leaves can never be destroyed without corrupting historical reporting, so
 * the lifecycle ends at `archived` (retired but queryable), and `suspended` is
 * a reversible pause. There is deliberately no "delete" status and no
 * transition that removes data.
 *
 * HONEST, MINIMAL FIELDS (AGENTS.md §7)
 * `institution_type` is a coarse, non-personal descriptor. It is optional and
 * has no default: an institution created before prompt 32 has no recorded type
 * and must render as "Not set" rather than be guessed. The location/contact
 * profile fields (migration 0015) exist for the platform registration flow and
 * are validated by `validateInstitutionRegistration` below; institutions
 * created before 0015 carry none of them and render "Not set", never a guess.
 */

// --- Operational status ------------------------------------------------------

/**
 * Platform-controlled operational status of a tenant.
 * - `active`    : normal — the institution operates as usual.
 * - `suspended` : temporarily disabled for support/compliance; reversible.
 * - `archived`  : retired; kept for history, not for new activity.
 */
export const INSTITUTION_STATUSES = [
  "active",
  "suspended",
  "archived",
] as const;

export type InstitutionStatus = (typeof INSTITUTION_STATUSES)[number];

/** Runtime guard for a status string arriving from any untrusted source. */
export function isInstitutionStatus(
  value: unknown,
): value is InstitutionStatus {
  return (
    typeof value === "string" &&
    (INSTITUTION_STATUSES as readonly string[]).includes(value)
  );
}

/** Normalise an unknown value to a status or `null` (never a default guess). */
export function normalizeInstitutionStatus(
  value: unknown,
): InstitutionStatus | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase();
  return isInstitutionStatus(candidate) ? candidate : null;
}

export const INSTITUTION_STATUS_LABELS: Record<InstitutionStatus, string> = {
  active: "Active",
  suspended: "Suspended",
  archived: "Archived",
};

/** One-line explanation of each status, for detail-page copy.
 *  HONEST ABOUT SCOPE (prompt 32): these statuses are a recorded, audit-logged
 *  operational flag for platform support. They do NOT yet gate sign-in,
 *  membership, exam delivery, grading, or results — authorization resolves
 *  from the trusted principal (see lib/auth/context.ts) and never reads
 *  institutions.status. Enforcement is a separate, later capability; the copy
 *  must not imply that suspending or archiving blocks access. */
export const INSTITUTION_STATUS_HINTS: Record<InstitutionStatus, string> = {
  active: "Operating normally on the platform.",
  suspended:
    "Flagged as suspended by the platform team for support follow-up. This records operational status and is audit-logged; access enforcement for suspended institutions is not yet wired up. Data is preserved and it can be reactivated.",
  archived:
    "Flagged as retired. Kept for historical reporting; it is not deleted and can be restored to active. Access enforcement for retired institutions is not yet wired up.",
};

/**
 * Badge tone per status, so the directory and detail views colour the same
 * way without each call site re-deciding. Kept as plain strings (not a
 * component import) so this module stays dependency-free.
 */
export const INSTITUTION_STATUS_TONES: Record<
  InstitutionStatus,
  "success" | "warning" | "neutral"
> = {
  active: "success",
  suspended: "warning",
  archived: "neutral",
};

// --- Approved status transitions --------------------------------------------

/**
 * The ONLY legal moves between statuses. Fail-closed by construction: a
 * transition is allowed only if it appears here. Notable rules —
 *   - no self-transition (changing to the current status is a no-op the UI
 *     should not offer, and the server refuses),
 *   - `archived` may only return to `active` (restore), never straight to
 *     `suspended`, so a reinstated tenant always starts from a clean state,
 *   - there is no path to a "deleted" value because none exists.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<
  InstitutionStatus,
  readonly InstitutionStatus[]
> = {
  active: ["suspended", "archived"],
  suspended: ["active", "archived"],
  archived: ["active"],
};

/** Whether moving `from` → `to` is an approved transition. */
export function canTransitionInstitutionStatus(
  from: InstitutionStatus,
  to: InstitutionStatus,
): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Labels for the transitions available from a given status, in lifecycle
 * order. The detail page renders exactly these as its action buttons, so the
 * UI can never offer a move the server would refuse.
 */
export function availableStatusTransitions(
  from: InstitutionStatus,
): Array<{ to: InstitutionStatus; label: string }> {
  return ALLOWED_STATUS_TRANSITIONS[from].map((to) => ({
    to,
    label: INSTITUTION_STATUS_LABELS[to],
  }));
}

// --- Institution type (coarse, optional, non-personal) ----------------------

/**
 * Controlled vocabulary for the directory's "type" column. Mirrors the
 * account_type intents already used at registration (schools, tutorial
 * centres, CBT centres). Nullable in the schema: an unset type is shown as
 * "Not set", never coerced into one of these.
 */
export const INSTITUTION_TYPES = [
  "school",
  "tutorial_centre",
  "cbt_centre",
] as const;

export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

export function isInstitutionType(value: unknown): value is InstitutionType {
  return (
    typeof value === "string" &&
    (INSTITUTION_TYPES as readonly string[]).includes(value)
  );
}

export const INSTITUTION_TYPE_LABELS: Record<InstitutionType, string> = {
  school: "School",
  tutorial_centre: "Tutorial centre",
  cbt_centre: "CBT centre",
};

/** Label for a stored type, or a truthful "Not set" for null/unknown. */
export function institutionTypeLabel(
  value: string | null | undefined,
): string {
  return isInstitutionType(value) ? INSTITUTION_TYPE_LABELS[value] : "Not set";
}

// --- Directory query resolution (untrusted searchParams) --------------------
// Same contract as resolvePlatformAuditQuery: searchParams are attacker-
// controllable, so every value is clamped, validated, or dropped here before
// it reaches the data layer.

export const INSTITUTION_DIRECTORY_PAGE_SIZE = 20;

/** Statuses a directory filter may target; `null` means "no filter". */
export type InstitutionDirectoryQuery = {
  q: string;
  status: InstitutionStatus | null;
  page: number;
  pageSize: number;
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** Cap free-text length so a huge param can't reach the query planner. */
const SEARCH_MAX_LENGTH = 120;

/**
 * Turn raw searchParams into a safe, bounded directory query. An unknown or
 * absent `status` becomes `null` (no filter) rather than an arbitrary column
 * value; a non-positive / non-numeric page clamps to 1.
 */
export function resolveInstitutionDirectoryQuery(searchParams: {
  q?: string | string[];
  status?: string | string[];
  page?: string | string[];
}): InstitutionDirectoryQuery {
  const rawQuery = firstValue(searchParams.q).trim().slice(0, SEARCH_MAX_LENGTH);
  const parsed = Number.parseInt(firstValue(searchParams.page), 10);
  return {
    q: rawQuery,
    status: normalizeInstitutionStatus(firstValue(searchParams.status)),
    page: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
    pageSize: INSTITUTION_DIRECTORY_PAGE_SIZE,
  };
}

/**
 * Build a directory URL for a page, preserving the active search + status
 * filter. Empty values are omitted so page 1 with no filters is a clean path.
 */
export function institutionDirectoryHref(
  base: string,
  query: InstitutionDirectoryQuery,
  page: number,
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status) params.set("status", query.status);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Escape a free-text search term for a PostgREST single-column `ilike`
 * filter: strip the characters that would break the filter syntax (`*`, `,`,
 * `%`, `(`, `)`), then wrap the remainder in SQL wildcards as a
 * contains-pattern. Returns "" for an empty/only-noise term so the caller
 * skips the filter rather than sends a broken one. Same contract as
 * classes.ts::toOrgContainsPattern; kept local so each module stays
 * independently testable and dependency-free.
 */
export function toInstitutionContainsPattern(term: string): string {
  const cleaned = term.replace(/[*,%()]/g, "").trim();
  return cleaned.length > 0 ? `%${cleaned}%` : "";
}

// --- Institution detail tabs (prompt 32 detail dashboard) -------------------
// The detail view is organised into sections, but ONLY ones backed by a real,
// implemented data source. There is deliberately no `assessments`, `results`,
// or `subscription` tab: the exam/attempt/result tables (prompts 17–24) and any
// billing system do not exist yet, so offering a tab for them would force us to
// render fabricated figures (AGENTS.md §7 — no fake data). Assessments are
// still surfaced honestly as an "unavailable" metric on the overview.

/** Tabs that map to a genuinely implemented capability for one institution. */
export const INSTITUTION_DETAIL_TABS = [
  "overview",
  "users",
  "settings",
  "activity",
] as const;

export type InstitutionDetailTab = (typeof INSTITUTION_DETAIL_TABS)[number];

export const INSTITUTION_DETAIL_TAB_LABELS: Record<InstitutionDetailTab, string> = {
  overview: "Overview",
  users: "Users",
  settings: "Settings",
  activity: "Activity Logs",
};

/** The tab shown when none (or an unknown one) is requested. */
export const DEFAULT_INSTITUTION_DETAIL_TAB: InstitutionDetailTab = "overview";

export function isInstitutionDetailTab(
  value: unknown,
): value is InstitutionDetailTab {
  return (
    typeof value === "string" &&
    (INSTITUTION_DETAIL_TABS as readonly string[]).includes(value)
  );
}

/**
 * Resolve the requested tab from untrusted searchParams. An unknown or absent
 * `tab` falls back to the overview rather than rendering an arbitrary section
 * (fail-closed), and repeated params read the first value.
 */
export function resolveInstitutionDetailTab(searchParams: {
  tab?: string | string[];
}): InstitutionDetailTab {
  const raw = firstValue(searchParams.tab).trim().toLowerCase();
  return isInstitutionDetailTab(raw) ? raw : DEFAULT_INSTITUTION_DETAIL_TAB;
}

/**
 * Build a detail URL for a tab. The default (overview) tab keeps the path clean
 * so the common case is a bare `/platform/institutions/<id>` link.
 */
export function institutionDetailTabHref(
  base: string,
  tab: InstitutionDetailTab,
): string {
  return tab === DEFAULT_INSTITUTION_DETAIL_TAB
    ? base
    : `${base}?tab=${tab}`;
}

// --- Platform registration (prompt 32 follow-up: "Add Institution") ---------
// The pure input contract behind the SUPER_ADMIN "register a new institution"
// flow. The bounds below mirror migration 0015's CHECK constraints exactly, so
// a value that passes here cannot be refused by the database, and one that
// skips this layer still cannot be stored out of range. Validation is
// fail-closed: a required field is never defaulted, an unrecognised type is
// refused rather than guessed, and unknown input values are trimmed, bounded,
// or reported — never silently coerced.

/** Field-length bounds, mirrored from migrations 0001 (name) and 0015. */
export const INSTITUTION_REGISTRATION_LIMITS = {
  name: 160,
  shortName: 40,
  description: 500,
  country: 60,
  state: 60,
  city: 80,
  address: 200,
  contactPerson: 120,
  contactEmail: 254,
  contactPhone: 16,
} as const;

/** Form fields the registration flow accepts; keys match the form inputs. */
export type InstitutionRegistrationField =
  | "name"
  | "type"
  | "shortName"
  | "description"
  | "country"
  | "state"
  | "city"
  | "address"
  | "contactPerson"
  | "contactEmail"
  | "contactPhone";

/** The validated, normalised payload the data layer writes (snake_case
 *  columns are mapped at the insert site, not here). */
export type CleanInstitutionRegistration = {
  name: string;
  type: InstitutionType;
  shortName: string | null;
  description: string | null;
  country: string;
  state: string;
  city: string;
  address: string;
  contactPerson: string;
  /** Lower-cased for stable uniqueness; delivery is NOT part of this flow. */
  contactEmail: string;
  /** Normalised to optional `+` plus digits (see normalizeContactPhone). */
  contactPhone: string;
};

export type InstitutionRegistrationResult =
  | { ok: true; value: CleanInstitutionRegistration }
  | {
      ok: false;
      errors: Partial<Record<InstitutionRegistrationField, string>>;
      /** The submitted values, trimmed, so the form can re-render them. */
      values: Record<InstitutionRegistrationField, string>;
    };

/**
 * Uniqueness key for an institution name — lower-cased and trimmed, the exact
 * expression behind migration 0015's unique index
 * (`lower(btrim(name))`). The server-side pre-check and the database
 * constraint agree through this one function, so the friendly "already
 * exists" error and the hard 23505 refusal catch the same duplicates.
 * (Internal whitespace is NOT collapsed on either side — documented limit.)
 */
export function normalizeInstitutionNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Light email shape check; deliberately not an RFC parser. */
const CONTACT_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Normalise a phone to optional `+` plus 8–15 digits (E.164-shaped, which is
 * what Nigerian numbers with their country code look like). Spaces, dashes,
 * dots, and parentheses are stripped before the pattern test, so "(0803) 123-
 * 4567" and "+234 803 123 4567" both pass; letters or a bare "123" fail.
 * Returns null when the result is not a plausible phone number.
 */
export function normalizeContactPhone(value: string): string | null {
  const stripped = value.replace(/[\s().-]/g, "");
  return /^\+?[0-9]{8,15}$/.test(stripped) ? stripped : null;
}

/** Read a form/raw value as a trimmed string (non-strings become ""). */
function rawField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate raw registration input (from a FormData-backed server action —
 * every value is untrusted). Collects ALL field errors in one pass so the
 * form shows every problem at once instead of one per submission.
 */
export function validateInstitutionRegistration(
  raw: Record<string, unknown>,
): InstitutionRegistrationResult {
  const values: Record<InstitutionRegistrationField, string> = {
    name: rawField(raw.name),
    type: rawField(raw.type),
    shortName: rawField(raw.shortName),
    description: rawField(raw.description),
    country: rawField(raw.country),
    state: rawField(raw.state),
    city: rawField(raw.city),
    address: rawField(raw.address),
    contactPerson: rawField(raw.contactPerson),
    contactEmail: rawField(raw.contactEmail),
    contactPhone: rawField(raw.contactPhone),
  };

  const errors: Partial<Record<InstitutionRegistrationField, string>> = {};
  const limits = INSTITUTION_REGISTRATION_LIMITS;

  // Required bounded text fields. `label` is the user-facing field name and
  // `key` doubles as the form field and its limit entry.
  const required: Array<{
    key: InstitutionRegistrationField;
    label: string;
    max: number;
  }> = [
    { key: "name", label: "Institution name", max: limits.name },
    { key: "country", label: "Country", max: limits.country },
    { key: "state", label: "State", max: limits.state },
    { key: "city", label: "City", max: limits.city },
    { key: "address", label: "Full address", max: limits.address },
    { key: "contactPerson", label: "Contact person", max: limits.contactPerson },
  ];
  for (const field of required) {
    const value = values[field.key];
    if (value.length === 0) {
      errors[field.key] = `${field.label} is required.`;
    } else if (value.length > field.max) {
      errors[field.key] = `${field.label} must be ${field.max} characters or fewer.`;
    }
  }

  // Institution type: the controlled vocabulary from 0008, required here so a
  // platform-registered tenant always has a recorded type (unlike legacy rows,
  // which may still render "Not set").
  if (values.type.length === 0) {
    errors.type = "Choose an institution type.";
  } else if (!isInstitutionType(values.type)) {
    errors.type = "That institution type is not supported.";
  }

  // Optional bounded text fields — blank stays null, never an empty string.
  const optional: Array<{
    key: InstitutionRegistrationField;
    label: string;
    max: number;
  }> = [
    { key: "shortName", label: "Short name", max: limits.shortName },
    { key: "description", label: "Description", max: limits.description },
  ];
  for (const field of optional) {
    const value = values[field.key];
    if (value.length > field.max) {
      errors[field.key] = `${field.label} must be ${field.max} characters or fewer.`;
    }
  }

  // Contact email: required, light format check. No email is sent by this
  // flow — the address records WHO to invite once admin provisioning lands.
  if (values.contactEmail.length === 0) {
    errors.contactEmail = "Contact email is required.";
  } else if (values.contactEmail.length > limits.contactEmail) {
    errors.contactEmail = `Contact email must be ${limits.contactEmail} characters or fewer.`;
  } else if (!CONTACT_EMAIL_PATTERN.test(values.contactEmail)) {
    errors.contactEmail = "Enter a valid email address, e.g. admin@school.edu.ng.";
  }

  // Contact phone: required, normalised server-side.
  if (values.contactPhone.length === 0) {
    errors.contactPhone = "Contact phone is required.";
  } else if (normalizeContactPhone(values.contactPhone) === null) {
    errors.contactPhone =
      "Enter a valid phone number with country code, e.g. +234 803 123 4567.";
  } else if (normalizeContactPhone(values.contactPhone)!.length > limits.contactPhone) {
    errors.contactPhone = "That phone number is too long.";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, values };
  }

  // Every field above has passed, so the casts below are safe by check.
  const type = values.type as InstitutionType;
  const contactPhone = normalizeContactPhone(values.contactPhone);
  if (contactPhone === null) {
    // Unreachable (validated above) but keeps the return total without an assert.
    return { ok: false, errors: { contactPhone: "Enter a valid phone number." }, values };
  }

  return {
    ok: true,
    value: {
      name: values.name,
      type,
      shortName: values.shortName.length > 0 ? values.shortName : null,
      description: values.description.length > 0 ? values.description : null,
      country: values.country,
      state: values.state,
      city: values.city,
      address: values.address,
      contactPerson: values.contactPerson,
      contactEmail: values.contactEmail.toLowerCase(),
      contactPhone,
    },
  };
}

// --- Institution self-service profile update (Settings › General) -----------
// The Institution Admin's own "General" settings edit (prompt: navigation &
// route-ownership repair). It reuses the SAME field set and length bounds as
// registration above, because they map to the same migration-0015 columns —
// there is deliberately no second copy of the limits to drift.
//
// Why the rules differ from registration: registration is a SUPER_ADMIN
// onboarding step where every identity/contact field is mandatory so a new
// tenant always has a complete directory record. Self-service editing targets
// EXISTING tenants, many of which predate 0015 (legacy rows carry `null` for
// the whole profile). Forcing an admin to fill every field just to correct the
// name would be dishonest about what the schema requires, so here ONLY `name`
// is required (it is `NOT NULL` in 0001); every other field is optional and a
// blank stays `null` rather than being coerced to an empty string. Fields that
// DO carry a database CHECK (email/phone format, per-field max length) are
// validated whenever a value is supplied, so the write can never land an
// out-of-range or malformed value the database would refuse.

/** The editable identity/contact fields — same keys as the profile columns. */
export type InstitutionProfileField = InstitutionRegistrationField;

/** The validated, normalised payload the data layer writes (blank → null). */
export type CleanInstitutionProfileUpdate = {
  name: string;
  type: InstitutionType | null;
  shortName: string | null;
  description: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
};

export type InstitutionProfileUpdateResult =
  | { ok: true; value: CleanInstitutionProfileUpdate }
  | {
      ok: false;
      errors: Partial<Record<InstitutionProfileField, string>>;
      /** The submitted values, trimmed, so the form re-renders what was typed. */
      values: Record<InstitutionProfileField, string>;
    };

/** Bound an optional text field: blank → null, over-length → error. */
function optionalBounded(
  value: string,
  max: number,
  label: string,
  errors: Partial<Record<InstitutionProfileField, string>>,
  key: InstitutionProfileField,
): string | null {
  if (value.length === 0) return null;
  if (value.length > max) {
    errors[key] = `${label} must be ${max} characters or fewer.`;
    return null;
  }
  return value;
}

/**
 * Validate raw self-service profile input (FormData-backed — every value is
 * untrusted). Collects ALL field errors in one pass so the form shows every
 * problem at once. Fail-closed: a required field is never defaulted, an
 * unrecognised type is refused rather than guessed, and a supplied email/phone
 * is only stored once it clears the same checks the schema enforces.
 */
export function validateInstitutionProfileUpdate(
  raw: Record<string, unknown>,
): InstitutionProfileUpdateResult {
  const values: Record<InstitutionProfileField, string> = {
    name: rawField(raw.name),
    type: rawField(raw.type),
    shortName: rawField(raw.shortName),
    description: rawField(raw.description),
    country: rawField(raw.country),
    state: rawField(raw.state),
    city: rawField(raw.city),
    address: rawField(raw.address),
    contactPerson: rawField(raw.contactPerson),
    contactEmail: rawField(raw.contactEmail),
    contactPhone: rawField(raw.contactPhone),
  };

  const errors: Partial<Record<InstitutionProfileField, string>> = {};
  const limits = INSTITUTION_REGISTRATION_LIMITS;

  // Name is the one NOT NULL identity column (migration 0001) — always
  // required, always bounded.
  if (values.name.length === 0) {
    errors.name = "Institution name is required.";
  } else if (values.name.length > limits.name) {
    errors.name = `Institution name must be ${limits.name} characters or fewer.`;
  }

  // Institution type is optional here (legacy rows may have none). When a value
  // IS supplied it must be one of the controlled vocabularies — never guessed.
  let type: InstitutionType | null = null;
  if (values.type.length > 0) {
    if (isInstitutionType(values.type)) {
      type = values.type;
    } else {
      errors.type = "That institution type is not supported.";
    }
  }

  // Optional bounded text fields — blank stays null, never an empty string.
  const shortName = optionalBounded(values.shortName, limits.shortName, "Short name", errors, "shortName");
  const description = optionalBounded(values.description, limits.description, "Description", errors, "description");
  const country = optionalBounded(values.country, limits.country, "Country", errors, "country");
  const state = optionalBounded(values.state, limits.state, "State", errors, "state");
  const city = optionalBounded(values.city, limits.city, "City", errors, "city");
  const address = optionalBounded(values.address, limits.address, "Full address", errors, "address");
  const contactPerson = optionalBounded(values.contactPerson, limits.contactPerson, "Contact person", errors, "contactPerson");

  // Contact email: optional, but a supplied value must be well-formed. Stored
  // lower-cased for the same stable uniqueness as registration; no email is
  // sent by this flow.
  let contactEmail: string | null = null;
  if (values.contactEmail.length > 0) {
    if (values.contactEmail.length > limits.contactEmail) {
      errors.contactEmail = `Contact email must be ${limits.contactEmail} characters or fewer.`;
    } else if (!CONTACT_EMAIL_PATTERN.test(values.contactEmail)) {
      errors.contactEmail = "Enter a valid email address, e.g. admin@school.edu.ng.";
    } else {
      contactEmail = values.contactEmail.toLowerCase();
    }
  }

  // Contact phone: optional, but a supplied value is normalised to `+`/digits
  // and bounded exactly as the schema CHECK requires.
  let contactPhone: string | null = null;
  if (values.contactPhone.length > 0) {
    const normalized = normalizeContactPhone(values.contactPhone);
    if (normalized === null) {
      errors.contactPhone =
        "Enter a valid phone number with country code, e.g. +234 803 123 4567.";
    } else if (normalized.length > limits.contactPhone) {
      errors.contactPhone = "That phone number is too long.";
    } else {
      contactPhone = normalized;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, values };
  }

  return {
    ok: true,
    value: {
      name: values.name,
      type,
      shortName,
      description,
      country,
      state,
      city,
      address,
      contactPerson,
      contactEmail,
      contactPhone,
    },
  };
}
