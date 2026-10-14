/**
 * Class + academic-session contract and validation — pure, dependency-free,
 * unit-testable.
 *
 * The exact same rules run in the browser (instant feedback) and on the server
 * (authoritative). Client validation is convenience only; the server ALWAYS
 * re-validates and re-checks tenancy (AGENTS.md §5, §7). No new packages.
 *
 * WHAT THIS AREA IS FOR (prompt 13)
 * Classes and academic sessions exist to ORGANISE ASSESSMENTS: a class is the
 * group an assessment is assigned to, and a session ("2025/2026") is the
 * academic year those classes belong to. This module deliberately carries no
 * timetable, attendance, fee, or ERP fields — the DB shape from prompt 08 plus
 * a name, a session link, and a lifecycle status is the whole model.
 *
 * ARCHIVE, NEVER DELETE (AGENTS.md §6)
 * Prompts 15–24 hang exams, attempts and results off `classes.id`. A class that
 * has been used cannot be destroyed without corrupting historical results, so
 * the only removal offered is `archived`: it disappears from pickers and
 * default listings but stays queryable for reporting. `classArchiveBlocked`
 * encodes that policy in one place so a future call site cannot invent a
 * delete path by accident.
 *
 * A name's tenant ownership is NEVER validated here — that needs the database
 * and the caller's trusted institution, so it lives in lib/data/classes.ts.
 */

// --- Lifecycle ---------------------------------------------------------------

/**
 * Shared lifecycle for classes and academic sessions.
 * - `active`   : usable now — appears in pickers and default listings.
 * - `archived` : retired; readable for history, unusable for new assignments.
 */
export const ORG_STATUSES = ["active", "archived"] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

/** Plain-language labels for filter dropdowns and status chips. */
export const ORG_STATUS_LABELS: Record<OrgStatus, string> = {
  active: "Active",
  archived: "Archived",
};

/** One-line explanation of each status, for profile copy. */
export const ORG_STATUS_HINTS: Record<OrgStatus, string> = {
  active: "Active — available for new assessments and class assignments.",
  archived:
    "Archived — kept for historical reporting. It cannot be assigned to new students, classes, or assessments.",
};

// --- Name validation ---------------------------------------------------------

/**
 * Class and session names are short labels shown in tables, pickers, and
 * exported result headers. The allowed alphabet mirrors the roster codes in
 * lib/students.ts: letters, digits, spaces, and the separators Nigerian class
 * and session names actually use (SS-101, 2025/2026, JAMB - WAEC).
 */
const ORG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _./&-]*$/;

/** Names are single-line labels; a newline would break tables and exports. */
const FORBIDDEN_NAME_CHARS = /[\r\n\t]/;

/** Length limits mirror the DB CHECK constraints (1–80) so client and schema agree. */
export const ORG_NAME_MAX_LENGTH = 80;

/**
 * Validate an organisation name (class or academic session). Returns an error
 * message, or `null` when the trimmed value is usable. Session and class names
 * follow one rule so both screens behave identically.
 */
export function validateOrgName(rawName: string): string | null {
  if (typeof rawName !== "string") return "Enter a name.";

  const name = rawName.trim();
  if (!name) {
    return "Enter a name (e.g. SS 101 or 2025/2026).";
  }
  if (name.length > ORG_NAME_MAX_LENGTH) {
    return `Keep the name under ${ORG_NAME_MAX_LENGTH} characters.`;
  }
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    return "Use a single-line name — no line breaks or tabs.";
  }
  if (!ORG_NAME_RE.test(name)) {
    return "Start with a letter or number, then use letters, numbers, spaces, or - . / _ &.";
  }
  return null;
}

/**
 * Whether a session name looks like an academic year span ("2025/2026",
 * "2025 - 2026"). Used only for an advisory hint — never to reject a name,
 * because tutorial centres run non-year sessions ("Batch A", "Weekend 2026").
 */
export function looksLikeSessionSpan(name: string): boolean {
  const trimmed = name.trim();
  return /^\d{4}\s*[-/]\s*\d{4}$/.test(trimmed) || /^\d{4}$/.test(trimmed);
}

// --- Class input -------------------------------------------------------------

export type ClassInput = {
  name: string;
  /** Selected academic session id, or "" for no session (unassigned). */
  academicSessionId: string;
};

export type ClassField = keyof ClassInput;

export type ClassErrors = Partial<Record<ClassField, string>>;

export const CLASS_INPUT_EMPTY: ClassInput = {
  name: "",
  academicSessionId: "",
};

/**
 * Validate a class payload → field → message map. An empty map means valid.
 * `academicSessionId` presence is checked against the caller's tenant in the
 * data layer (a cross-tenant or archived session id is rejected there), never
 * here — this function has no database access and must not pretend otherwise.
 */
export function validateClass(input: ClassInput): ClassErrors {
  const errors: ClassErrors = {};

  const nameError = validateOrgName(input.name);
  if (nameError) errors.name = nameError;

  if (typeof input.academicSessionId !== "string") {
    errors.academicSessionId = "Choose one of your institution's sessions.";
  }

  return errors;
}

/** Trimmed, normalised form used before persisting. */
export function normalizeClassInput(input: ClassInput): ClassInput {
  return {
    name: input.name.trim(),
    academicSessionId:
      typeof input.academicSessionId === "string"
        ? input.academicSessionId.trim()
        : "",
  };
}

// --- Academic session input ---------------------------------------------------

export type SessionInput = {
  name: string;
};

export type SessionField = keyof SessionInput;

export type SessionErrors = Partial<Record<SessionField, string>>;

export const SESSION_INPUT_EMPTY: SessionInput = { name: "" };

/** Validate an academic-session payload. */
export function validateSession(input: SessionInput): SessionErrors {
  const errors: SessionErrors = {};
  const nameError = validateOrgName(input.name);
  if (nameError) errors.name = nameError;
  return errors;
}

/** Trimmed, normalised form used before persisting. */
export function normalizeSessionInput(input: SessionInput): SessionInput {
  return { name: input.name.trim() };
}

// --- Archive policy -----------------------------------------------------------

/** Facts about a class needed to decide whether it can be archived. */
export type ClassArchiveFacts = {
  /** Students currently assigned to this class. */
  attachedStudents: number;
};

/**
 * Why archiving a class is refused, or `null` when it may be archived.
 *
 * Students still attached to a class are the block: archiving would leave an
 * active roster pointing at a retired group, so admins must move those
 * students first (which is recorded in `student_class_history`, preserving the
 * past). Once nothing is attached, archiving is safe and reversible.
 */
export function classArchiveBlocked(
  facts: ClassArchiveFacts,
): { reason: "studentsAttached"; message: string } | null {
  if (facts.attachedStudents > 0) {
    return {
      reason: "studentsAttached",
      message: `Move the ${facts.attachedStudents} student${
        facts.attachedStudents === 1 ? "" : "s"
      } still in this class to another class first. Their history here is kept.`,
    };
  }
  return null;
}

/**
 * Whether a class may be *newly* attached to something (a student, a teacher's
 * scope, an assessment). Archived classes are readable but never attachable;
 * an unknown status fails closed.
 */
export function isClassAttachable(status: string): boolean {
  return status === "active";
}

/** Whether a session may receive NEW classes. Archived sessions stay readable. */
export function isSessionAttachable(status: string): boolean {
  return status === "active";
}

// --- List query resolution (search / filter / pagination) ---------------------

export const CLASS_PAGE_SIZE = 20;

/**
 * Filters + pagination for the class directory. `status` `null` means "all
 * statuses"; empty `sessionId`/`q` mean "no filter". Values arrive from
 * searchParams, which is untrusted input, so everything is clamped here.
 */
export type ClassListQuery = {
  q: string;
  sessionId: string;
  status: OrgStatus | null;
  page: number;
  pageSize: number;
};

/** Filters + pagination for the academic-session list. */
export type SessionListQuery = {
  q: string;
  status: OrgStatus | null;
  page: number;
  pageSize: number;
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** Clamp a raw page value to a safe 1-based page. */
function safePage(raw: string | string[] | undefined): number {
  const parsed = Number.parseInt(firstValue(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** Narrow a raw status value to a known status, or `null` for "all". */
function safeStatus(raw: string | string[] | undefined): OrgStatus | null {
  const value = firstValue(raw);
  return ORG_STATUSES.includes(value as OrgStatus) ? (value as OrgStatus) : null;
}

/**
 * Turn raw searchParams into a safe, bounded class-directory query. Unknown
 * statuses collapse to "all", pages below 1 (or non-numeric) clamp to 1, and
 * the search term is trimmed and length-bounded so a hostile or stale URL can
 * never produce a runaway query.
 */
export function resolveClassListQuery(searchParams: {
  q?: string | string[];
  session?: string | string[];
  status?: string | string[];
  page?: string | string[];
}): ClassListQuery {
  return {
    q: firstValue(searchParams.q).trim().slice(0, 120),
    sessionId: firstValue(searchParams.session).trim(),
    status: safeStatus(searchParams.status),
    page: safePage(searchParams.page),
    pageSize: CLASS_PAGE_SIZE,
  };
}

/** Turn raw searchParams into a safe, bounded session-list query. */
export function resolveSessionListQuery(searchParams: {
  q?: string | string[];
  status?: string | string[];
  page?: string | string[];
}): SessionListQuery {
  return {
    q: firstValue(searchParams.q).trim().slice(0, 120),
    status: safeStatus(searchParams.status),
    page: safePage(searchParams.page),
    pageSize: CLASS_PAGE_SIZE,
  };
}

/** Build a class-directory URL for a page, preserving the current filters. */
export function classPageHref(
  base: string,
  query: ClassListQuery,
  page: number,
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.sessionId) params.set("session", query.sessionId);
  if (query.status) params.set("status", query.status);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Build a session-list URL for a page, preserving the current filters. */
export function sessionPageHref(
  base: string,
  query: SessionListQuery,
  page: number,
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status) params.set("status", query.status);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Total pages for a count, always >= 1 so pagination math is safe. */
export function orgTotalPages(total: number, pageSize: number): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

/**
 * Which class a student move should record in `student_class_history`, or
 * `null` when the change deserves no history row. This is the EXECUTABLE
 * SPECIFICATION of the atomic write the database performs in
 * `students_update_with_class_history` (supabase/migrations/0004): the row
 * records the class being LEFT, never the class arrived at — the roster already
 * holds the current class, so the history table's whole purpose is preserving
 * the past. Rules:
 *   - no real change (same id, including both-null)        → null
 *   - previously unassigned (old null) and now in a class  → null (no past)
 *   - leaving a real class (to another class OR to none)   → the old class id
 *
 * The SQL function applies the identical predicate
 * (`old IS NOT NULL AND old IS DISTINCT FROM new`); this pure mirror lets the
 * behaviour be unit-tested without a database and keeps the two from drifting.
 */
export function classHistoryTarget(
  oldClassId: string | null,
  newClassId: string | null,
): string | null {
  if (oldClassId === newClassId) return null;
  return oldClassId; // null when previously unassigned → no history row
}

/**
 * Validation message for the archive/restore name clash: restoring an archived
 * class fails when a DIFFERENT live class has since reused its name (the
 * live-rows-only partial unique index `classes_name_active_uidx` rejects it with
 * 23505). Kept here so the data layer, the server action, and any test share one
 * wording; the caller passes the archived class's own name.
 */
export function classRestoreNameConflictMessage(className: string): string {
  return `Another active class already uses the name "${className}". Rename one of them before restoring this class.`;
}

/**
 * Escape a free-text search term for a PostgREST single-column `ilike` filter:
 * strip the characters that would break the filter syntax (`*`, `,`, `%`,
 * `(`, `)`), then wrap the remainder in SQL wildcards as a contains-pattern.
 * Returns "" for an empty/only-noise term so callers skip the filter rather
 * than send a broken one. Same sanitising contract as
 * lib/students.ts::toLikePattern (whose `*term*` shape is specific to the
 * multi-column `or=` clause); kept local so each module stays dependency-free
 * and independently testable.
 *
 * Class and session search only ever reads the caller's own tenant (the
 * `institution_id` filter is applied first by the data layer), so the
 * remaining LIKE wildcards are a search-scope nuance, not a data exposure.
 */
export function toOrgContainsPattern(term: string): string {
  const cleaned = term.replace(/[*,%()]/g, "").trim();
  return cleaned.length > 0 ? `%${cleaned}%` : "";
}
