/**
 * Student contract and validation — pure, dependency-free, unit-testable.
 *
 * The exact same rules run in the browser (instant feedback) and on the server
 * (authoritative). Client validation is convenience only; the server ALWAYS
 * re-validates and re-checks tenancy (AGENTS.md §5, §7). No new packages.
 *
 * Personal data is deliberately minimised (AGENTS.md §7): a student record is a
 * name, an institution-unique code, an optional class, and a status — nothing
 * beyond what the assessment workflow needs. Fees, guardians, attendance, and
 * other school-ERP fields are out of scope by design.
 */

/** Lifecycle status of a roster entry. `inactive` = access deactivated, not deleted. */
export const STUDENT_STATUSES = ["active", "inactive"] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

/** Plain-language labels for the filter dropdown and status chips. */
export const STUDENT_STATUS_LABELS: Record<StudentStatus, string> = {
  active: "Active",
  inactive: "Inactive",
};

export type StudentInput = {
  fullName: string;
  studentCode: string;
  /** Selected class id, or "" when unassigned. */
  classId: string;
  status: string;
};

export type StudentField = keyof StudentInput;

export type StudentErrors = Partial<Record<StudentField, string>>;

export const STUDENT_INPUT_EMPTY: StudentInput = {
  fullName: "",
  studentCode: "",
  classId: "",
  status: "active",
};

// Codes are institution-scoped identifiers: start with an alphanumeric, then
// letters/digits/space and a few common separators. Rejects leading/trailing
// space and any markup, so nothing unexpected reaches the roster view.
const STUDENT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 _./-]*$/;

/**
 * Validate a student payload → field → message map. An empty map means valid.
 * Lengths mirror the database CHECK constraints so the browser and the schema
 * agree, and a value that slips past the client still fails on write.
 */
export function validateStudent(input: StudentInput): StudentErrors {
  const errors: StudentErrors = {};

  const fullName = input.fullName.trim();
  if (!fullName) {
    errors.fullName = "Enter the student's full name.";
  } else if (fullName.length > 120) {
    errors.fullName = "Keep the name under 120 characters.";
  }

  const studentCode = input.studentCode.trim();
  if (!studentCode) {
    errors.studentCode = "Enter a student code (e.g. admission or index number).";
  } else if (studentCode.length > 40) {
    errors.studentCode = "Keep the code under 40 characters.";
  } else if (!STUDENT_CODE_RE.test(studentCode)) {
    errors.studentCode =
      "Use letters, numbers, spaces, or - . / _ and start with a letter or number.";
  }

  if (!STUDENT_STATUSES.includes(input.status as StudentStatus)) {
    errors.status = "Choose a valid status.";
  }

  // `classId` is optional; if present its ownership is verified server-side
  // against the caller's institution (a cross-tenant class id is rejected in
  // lib/data/students.ts, never here).
  return errors;
}

/** Trimmed, normalised form used before persisting. */
export function normalizeStudentInput(input: StudentInput): StudentInput {
  return {
    fullName: input.fullName.trim(),
    studentCode: input.studentCode.trim(),
    classId: input.classId.trim(),
    status: input.status,
  };
}

// --- List query resolution (search / filter / pagination) -------------------

export const STUDENT_PAGE_SIZE = 20;

/**
 * Filters + pagination for the directory. `status` is `null` = "all statuses";
 * the empty `classId`/`q` mean "no filter". Values arrive from searchParams,
 * which is untrusted input, so everything is clamped to a safe shape here.
 */
export type StudentListQuery = {
  q: string;
  classId: string;
  status: StudentStatus | null;
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
export function resolveStudentListQuery(searchParams: {
  q?: string | string[];
  class?: string | string[];
  status?: string | string[];
  page?: string | string[];
}): StudentListQuery {
  const rawPage = Number.parseInt(firstValue(searchParams.page), 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const rawStatus = firstValue(searchParams.status);
  const status = STUDENT_STATUSES.includes(rawStatus as StudentStatus)
    ? (rawStatus as StudentStatus)
    : null;

  return {
    q: firstValue(searchParams.q).trim().slice(0, 120),
    classId: firstValue(searchParams.class).trim(),
    status,
    page,
    pageSize: STUDENT_PAGE_SIZE,
  };
}

/** Build a directory URL for a page, preserving the current filters. */
export function studentPageHref(
  base: string,
  query: StudentListQuery,
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
export function studentTotalPages(total: number, pageSize: number): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

/**
 * Escape a free-text search term for a PostgREST `ilike` `or` filter: strip the
 * characters that would break the filter syntax (`*`, `,`, `%`, `(`, `)`), then
 * wrap the remainder as a contains-pattern. Returns "" for an empty/only-noise
 * term so callers skip the filter rather than send a broken one. Pure, so the
 * directory's search behaviour is unit-testable without a database.
 */
export function toLikePattern(term: string): string {
  const cleaned = term.replace(/[*,%()]/g, "").trim();
  return cleaned.length > 0 ? `*${cleaned}*` : "";
}
