/**
 * Platform users directory contract — pure, dependency-free, and
 * unit-testable (the same layering as institutions.ts / audit/platform.ts:
 * no Clerk, no Next, no Supabase).
 *
 * WHY THIS EXISTS
 * The super-admin "Users" section answers one operational question: who is on
 * the platform, in which tenant, in which role. Its acceptance criteria are
 * all rules about UNTRUSTED input (searchParams) and about rows that come
 * back from PostgREST embeds in shapes that vary with FK nullability. Those
 * rules live here, in one place, so the data layer, the page, and `npm test`
 * can never drift into disagreeing about them.
 *
 * HONEST SCOPES (AGENTS.md §7 — no fabricated attribution)
 * Each tab reads from exactly ONE real source, and no tab borrows another's
 * numbers:
 *   accounts  — `institution_memberships` (the trusted tenant↔role↔user join).
 *               NOTE: SUPER_ADMIN is platform-scoped and carries no tenant
 *               membership row (by design), so a role=SUPER_ADMIN filter on
 *               this scope is an honest empty result, never a guess.
 *   unassigned — `profiles` with no membership at all (signed up, not yet
 *               placed in a tenant). The "no memberships" fact comes from a
 *               server-side assigned-id set difference, not from a column.
 *   students / teachers — the institution roster tables (`students`,
 *               `teachers`; soft-deleted rows are excluded like every tenant
 *               roster read does).
 *
 * PRIVACY (AGENTS.md §7)
 * The directory carries name/email/code/role/tenant — the minimal operational
 * projection. Nothing beyond those columns is ever selected.
 */

import { USER_ROLES, type UserRole } from "./auth/roles.ts";

// --- Directory scopes ---------------------------------------------------------

export const USER_DIRECTORY_SCOPES = [
  "accounts",
  "unassigned",
  "students",
  "teachers",
] as const;

export type UserDirectoryScope = (typeof USER_DIRECTORY_SCOPES)[number];

export const USER_DIRECTORY_SCOPE_LABELS: Record<UserDirectoryScope, string> = {
  accounts: "Tenant accounts",
  unassigned: "Unassigned accounts",
  students: "Student roster",
  teachers: "Teacher roster",
};

/** Runtime guard for a scope string arriving from untrusted searchParams. */
export function isUserDirectoryScope(
  value: unknown,
): value is UserDirectoryScope {
  return (
    typeof value === "string" &&
    (USER_DIRECTORY_SCOPES as readonly string[]).includes(value)
  );
}

// --- Untrusted searchParams → bounded query -----------------------------------
// Same contract as resolveInstitutionDirectoryQuery: every value is clamped,
// validated, or dropped before it reaches the data layer.

export const USER_DIRECTORY_PAGE_SIZE = 20;

/** Cap free-text length so a huge param can't reach the query planner. */
const SEARCH_MAX_LENGTH = 120;

/**
 * A valid tenant id is a UUID — anything else is dropped to `null` (no
 * filter) rather than passed into a query as an arbitrary column value.
 * (Institution ids come from the DB's gen_random_uuid and are always UUIDs.)
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidInstitutionId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export type UserDirectoryQuery = {
  scope: UserDirectoryScope;
  q: string;
  /** Membership role filter — only meaningful on the `accounts` scope. */
  role: UserRole | null;
  /** Tenant filter — meaningful on accounts/students/teachers, never on
   *  `unassigned` (by definition those accounts have no tenant). */
  institutionId: string | null;
  page: number;
  pageSize: number;
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** Normalise an unknown value to a role or `null` (never a default guess). */
export function normalizeUserRole(value: unknown): UserRole | null {
  if (typeof value !== "string") return null;
  const upper = value.toUpperCase();
  return (USER_ROLES as readonly string[]).includes(upper)
    ? (upper as UserRole)
    : null;
}

/**
 * Turn raw searchParams into a safe, bounded directory query. Unknown scope
 * falls back to `accounts`; junk role/institution values drop to `null`
 * (no filter); a non-positive/non-numeric page clamps to 1; the institution
 * filter is cleared on the `unassigned` scope because it could never match.
 */
export function resolveUserDirectoryQuery(searchParams: {
  scope?: string | string[];
  q?: string | string[];
  role?: string | string[];
  institution?: string | string[];
  page?: string | string[];
}): UserDirectoryQuery {
  const rawScope = firstValue(searchParams.scope);
  const scope = isUserDirectoryScope(rawScope) ? rawScope : "accounts";
  const parsed = Number.parseInt(firstValue(searchParams.page), 10);
  const candidate = isValidInstitutionId(searchParams.institution)
    ? firstValue(searchParams.institution)
    : null;
  return {
    scope,
    q: firstValue(searchParams.q).trim().slice(0, SEARCH_MAX_LENGTH),
    role: normalizeUserRole(searchParams.role),
    institutionId: scope === "unassigned" ? null : candidate,
    page: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
    pageSize: USER_DIRECTORY_PAGE_SIZE,
  };
}

/**
 * Build a directory URL for a scope/page, preserving the active filters.
 * Empty values are omitted so the default view is a clean path. The `role`
 * param is only carried on the scope where it is meaningful.
 */
export function userDirectoryHref(
  base: string,
  query: UserDirectoryQuery,
  overrides: Partial<Pick<UserDirectoryQuery, "scope" | "role" | "page">>,
): string {
  const next: UserDirectoryQuery = { ...query, ...overrides };
  const params = new URLSearchParams();
  if (next.scope !== "accounts") params.set("scope", next.scope);
  if (next.q) params.set("q", next.q);
  if (next.scope === "accounts" && next.role) params.set("role", next.role);
  if (next.institutionId) params.set("institution", next.institutionId);
  if (next.page > 1) params.set("page", String(next.page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Escape a free-text search term for a PostgREST `or(...)` filter: the same
 * sanitiser contract as toInstitutionContainsPattern (strip the characters
 * that break filter syntax: `*`, `,`, `%`, `(`, `)`), wrapped in wildcards as
 * a contains-pattern. Returns "" for an empty/only-noise term so the caller
 * skips the filter rather than sending a broken one. `toOrIlike` additionally
 * builds the multi-column `or` clause; a term that sanitises to "" produces
 * null so the caller applies no search filter at all.
 */
export function toUserContainsPattern(term: string): string {
  const cleaned = term.replace(/[*,%()]/g, "").trim();
  return cleaned.length > 0 ? `%${cleaned}%` : "";
}

/** Build the `or=` clause for a multi-column ilike search. Null = no filter. */
export function toUserSearchOrClause(
  term: string,
  columns: readonly string[],
): string | null {
  const pattern = toUserContainsPattern(term);
  if (!pattern) return null;
  return columns.map((column) => `${column}.ilike.${pattern}`).join(",");
}

/**
 * The cap on helper-profile ids resolved for a name/email search on the
 * accounts scope. Over-cap matches are reported (`searchTruncated`) so the
 * UI can say the search was partial — never silently drop candidates.
 */
export const USER_SEARCH_PROFILE_CAP = 400;

// --- Normalising PostgREST embed rows (pure, defensive) -----------------------

/** An embedded single row arrives as an object, an array (many-to-one drift),
 *  or null (FK nullable / embed unresolved). */
type Embeddable = Record<string, unknown> | Record<string, unknown>[] | null;

/** Read one field out of a possibly-array embed without guessing. Missing
 *  embeds and missing keys both normalise to null ("not recorded"), never to
 *  undefined leaking into the row shape. */
function embedField(embed: Embeddable, key: string): string | null {
  if (embed === null || embed === undefined) return null;
  const row = Array.isArray(embed) ? embed[0] : embed;
  if (!row) return null;
  const value = row[key];
  return typeof value === "string" ? value : null;
}

/** One normalised directory row, whatever scope produced it. */
export type UserDirectoryRow = {
  /** Stable React key: scope + underlying row id. */
  key: string;
  /** Membership / profile / roster row id. */
  id: string;
  /** The person's name as stored; null when the source had none. */
  fullName: string | null;
  email: string | null;
  /** Roster codes (students/teachers); null on account scopes. */
  code: string | null;
  institutionId: string | null;
  institutionName: string | null;
  /** Class name for the student roster; null elsewhere/when unassigned. */
  className: string | null;
  role: UserRole | null;
  /** Source-specific status (membership/roster/profile-active); null when
   *  the source has no meaningful status. */
  status: string | null;
  /** Row creation timestamp when the source carries one (profiles). */
  createdAt: string | null;
};

/** Raw shape of an `institution_memberships` row with its embeds. */
export type RawMembershipRow = {
  id: string;
  role: string;
  status: string;
  institution_id: string | null;
  user_id: string | null;
  institution?: Embeddable;
  profile?: Embeddable;
};

/** Normalise membership rows into directory rows. Roles outside the catalog
 *  are dropped fail-closed (the CHECK makes that impossible in practice, but
 *  a stored value we cannot name is never rendered as if it were trusted). */
export function normalizeMembershipRows(
  rows: readonly RawMembershipRow[],
): UserDirectoryRow[] {
  const out: UserDirectoryRow[] = [];
  for (const row of rows) {
    const role = normalizeUserRole(row.role);
    if (role === null) continue;
    const embed = row.profile ?? null;
    out.push({
      key: `accounts:${row.id}`,
      id: row.id,
      fullName: embedField(embed, "full_name"),
      email: embedField(embed, "email") ?? embedField(embed, "primary_email"),
      code: null,
      institutionId: row.institution_id,
      institutionName: embedField(row.institution ?? null, "name"),
      className: null,
      role,
      status: row.status,
      createdAt: embedField(row.profile ?? null, "created_at"),
    });
  }
  return out;
}

/** Raw shape of a `profiles` row (unassigned scope). */
export type RawProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  is_active: boolean;
  created_at: string;
};

/** Normalise profile rows; the account status is derived from `is_active`
 *  only — "unassigned" is a scope fact, not a fake status. */
export function normalizeProfileRows(rows: readonly RawProfileRow[]): UserDirectoryRow[] {
  return rows.map((row) => ({
    key: `unassigned:${row.id}`,
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    code: null,
    institutionId: null,
    institutionName: null,
    className: null,
    role: null,
    status: row.is_active === false ? "inactive" : "active",
    createdAt: row.created_at ?? null,
  }));
}

/** Raw shape of a `students` or `teachers` row with its embeds. */
export type RawRosterRow = {
  id: string;
  institution_id: string | null;
  student_code?: string | null;
  employee_code?: string | null;
  full_name: string | null;
  email?: string | null;
  status: string | null;
  created_at?: string;
  class_id?: string | null;
  institution?: Embeddable;
  class?: Embeddable;
};

/** Normalise roster rows (students or teachers) into directory rows. */
export function normalizeRosterRows(
  rows: readonly RawRosterRow[],
  role: UserRole,
): UserDirectoryRow[] {
  return rows.map((row) => ({
    key: `${role.toLowerCase()}:${row.id}`,
    id: row.id,
    fullName: row.full_name,
    email: row.email ?? embedField(row.institution ?? null, "contact_email") ?? null,
    code: row.student_code ?? row.employee_code ?? null,
    institutionId: row.institution_id,
    institutionName: embedField(row.institution ?? null, "name"),
    className: embedField(row.class ?? null, "name"),
    role,
    status: row.status,
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  }));
}

// --- Display helpers (labels for stored values, never guesses) ----------------

/** Membership status label; unknown values render verbatim-neutral "—". */
export function membershipStatusLabel(status: string | null): string {
  if (status === "active") return "Active";
  if (status === "inactive") return "Inactive";
  return "—";
}

/** Roster status labels (students: active/inactive; teachers add invited). */
export function rosterStatusLabel(status: string | null): string {
  if (status === "active") return "Active";
  if (status === "inactive") return "Inactive";
  if (status === "invited") return "Invited";
  return "—";
}

/** Tone for a status badge, keyed off the honest values only. */
export function statusBadgeTone(
  status: string | null,
): "success" | "warning" | "neutral" {
  if (status === "active") return "success";
  if (status === "invited" || status === "inactive") return "warning";
  return "neutral";
}

/** When a name is missing (profile never written), say so — never blank. */
export function displayNameOr(row: UserDirectoryRow): string {
  const name = row.fullName?.trim();
  if (name) return name;
  return row.email?.trim() ? row.email : "Name not recorded";
}
