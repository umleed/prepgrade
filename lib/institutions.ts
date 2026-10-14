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
 * and must render as "Not set" rather than be guessed. No contact details,
 * location, or billing fields exist in the schema, so none are modelled here.
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
