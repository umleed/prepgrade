/**
 * Teacher contract and validation — pure, dependency-free, unit-testable.
 *
 * The exact same rules run in the browser (instant feedback) and on the server
 * (authoritative). Client validation is convenience only; the server ALWAYS
 * re-validates and re-checks tenancy (AGENTS.md §5, §7). No new packages.
 *
 * PRIVILEGE-ESCALATION GUARD (prompt 12 requirement)
 * A teacher payload carries NO role field at all: the role a membership/metadata
 * grant writes is the constant returned by `teacherGrantRole()`, hard-coded to
 * TEACHER. `resolveGrantableTeacherRole()` exists so any role-shaped string that
 * does arrive (a tampered payload, a bad fixture) resolves to `null` unless it
 * means "teacher" — SUPER_ADMIN and INSTITUTION_ADMIN can never be granted
 * through this flow, fail closed (see lib/auth/registration.ts for why
 * privileged roles are never inferred from client data).
 *
 * Personal data is minimised (AGENTS.md §7): name, work email (the invitation
 * and account-linking key), an institution-unique employee code, class scope,
 * and a status — nothing beyond what member management needs.
 */

/**
 * Lifecycle status of a roster entry.
 * - `invited`  : on the roster; no login access granted yet (pending).
 * - `active`   : linked account with teacher access granted.
 * - `inactive` : access deactivated — reversible, history preserved.
 */
export const TEACHER_STATUSES = ["invited", "active", "inactive"] as const;
export type TeacherStatus = (typeof TEACHER_STATUSES)[number];

/** Plain-language labels for the filter dropdown and status chips. */
export const TEACHER_STATUS_LABELS: Record<TeacherStatus, string> = {
  invited: "Invited",
  active: "Active",
  inactive: "Inactive",
};

/** One-line explanation of what each status means, for profile copy. */
export const TEACHER_STATUS_HINTS: Record<TeacherStatus, string> = {
  invited: "Invited — waiting for the teacher to create their account.",
  active: "Active — signed-in access to the assigned classes is granted.",
  inactive: "Inactive — access is deactivated; records are kept.",
};

export type TeacherInput = {
  fullName: string;
  /** Work email — used for the invitation and for linking their account. */
  email: string;
  employeeCode: string;
  /** Class ids this teacher may work with; ownership is verified server-side. */
  classIds: string[];
};

export type TeacherField = keyof TeacherInput;

export type TeacherErrors = Partial<Record<TeacherField, string>>;

export const TEACHER_INPUT_EMPTY: TeacherInput = {
  fullName: "",
  email: "",
  employeeCode: "",
  classIds: [],
};

// Codes are institution-scoped identifiers — the same alphabet the student code
// allows, so both rosters behave consistently (see lib/students.ts).
const EMPLOYEE_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 _./-]*$/;

// Same conservative shape the demo-request validator uses: something@something.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate a teacher payload → field → message map. An empty map means valid.
 * Lengths mirror the database CHECK constraints so the browser and the schema
 * agree, and a value that slips past the client still fails on write.
 */
export function validateTeacher(input: TeacherInput): TeacherErrors {
  const errors: TeacherErrors = {};

  const fullName = input.fullName.trim();
  if (!fullName) {
    errors.fullName = "Enter the teacher's full name.";
  } else if (fullName.length > 120) {
    errors.fullName = "Keep the name under 120 characters.";
  }

  const email = input.email.trim();
  if (!email) {
    errors.email = "Enter the teacher's email address — invitations are sent there.";
  } else if (email.length > 160) {
    errors.email = "Keep the email under 160 characters.";
  } else if (!EMAIL_RE.test(email)) {
    errors.email = "Enter a valid email address.";
  }

  const employeeCode = input.employeeCode.trim();
  if (!employeeCode) {
    errors.employeeCode = "Enter an employee code (e.g. staff or payroll number).";
  } else if (employeeCode.length > 40) {
    errors.employeeCode = "Keep the code under 40 characters.";
  } else if (!EMPLOYEE_CODE_RE.test(employeeCode)) {
    errors.employeeCode =
      "Use letters, numbers, spaces, or - . / _ and start with a letter or number.";
  }

  // `classIds` is optional; each id's tenant ownership is verified server-side
  // (a cross-tenant class id is rejected in lib/data/teachers.ts, never here).
  if (!Array.isArray(input.classIds)) {
    errors.classIds = "Choose classes from your institution.";
  } else if (input.classIds.length > 50) {
    errors.classIds = "Assign at most 50 classes at a time.";
  }

  return errors;
}

/** Trimmed, normalised form used before persisting. */
export function normalizeTeacherInput(input: TeacherInput): TeacherInput {
  return {
    fullName: input.fullName.trim(),
    email: input.email.trim().toLowerCase(),
    employeeCode: input.employeeCode.trim(),
    classIds: [...new Set(input.classIds.map((id) => id.trim()).filter((id) => id.length > 0))],
  };
}

// --- Privilege-escalation guard ---------------------------------------------

/**
 * The ONLY role a teacher-management grant may ever write. A constant, not
 * input-derived — call sites have no way to pass anything else.
 */
export function teacherGrantRole(): "TEACHER" {
  return "TEACHER";
}

/**
 * Resolve a role-shaped string to the grantable teacher role. Returns
 * `"TEACHER"` only for values that mean teacher (any casing/spacing); returns
 * `null` for everything else — including "SUPER_ADMIN", "INSTITUTION_ADMIN",
 * "admin", and non-strings — so a tampered payload can never escalate through
 * a code path that trusts this helper. Fail closed.
 */
export function resolveGrantableTeacherRole(value: unknown): "TEACHER" | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return candidate === "teacher" ? "TEACHER" : null;
}

// --- List query resolution (search / filter / pagination) -------------------

export const TEACHER_PAGE_SIZE = 20;

/**
 * Filters + pagination for the directory. `status` is `null` = "all statuses";
 * the empty `classId`/`q` mean "no filter". Values arrive from searchParams,
 * which is untrusted input, so everything is clamped to a safe shape here.
 */
export type TeacherListQuery = {
  q: string;
  classId: string;
  status: TeacherStatus | null;
  page: number;
  pageSize: number;
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Turn raw searchParams into a safe, bounded list query. Page is clamped to
 * >= 1; unknown status values collapse to "all"; the search term and class id
 * are trimmed. This keeps hostile or stale URLs from producing bad queries.
 */
export function resolveTeacherListQuery(searchParams: {
  q?: string | string[];
  class?: string | string[];
  status?: string | string[];
  page?: string | string[];
}): TeacherListQuery {
  const rawPage = Number.parseInt(firstValue(searchParams.page), 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const rawStatus = firstValue(searchParams.status);
  const status = TEACHER_STATUSES.includes(rawStatus as TeacherStatus)
    ? (rawStatus as TeacherStatus)
    : null;

  return {
    q: firstValue(searchParams.q).trim().slice(0, 120),
    classId: firstValue(searchParams.class).trim(),
    status,
    page,
    pageSize: TEACHER_PAGE_SIZE,
  };
}

/** Build a directory URL for a page, preserving the current filters. */
export function teacherPageHref(
  base: string,
  query: TeacherListQuery,
  page: number,
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.classId) params.set("class", query.classId);
  if (query.status) params.set("status", query.status);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Total pages for a count, always >= 1 so pagination math is safe. */
export function teacherTotalPages(total: number, pageSize: number): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

/**
 * Escape a free-text search term for a PostgREST `ilike` `or` filter: strip the
 * characters that would break the filter syntax (`*`, `,`, `%`, `(`, `)`), then
 * wrap the remainder as a contains-pattern. Returns "" for an empty/only-noise
 * term so callers skip the filter rather than send a broken one. Same contract
 * as `toLikePattern` in lib/students.ts (kept local so both modules stay
 * dependency-free and independently testable).
 */
export function toTeacherLikePattern(term: string): string {
  const cleaned = term.replace(/[*,%()]/g, "").trim();
  return cleaned.length > 0 ? `*${cleaned}*` : "";
}
