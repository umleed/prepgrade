/**
 * Platform assessments (exams) directory contract — pure, dependency-free,
 * and unit-testable (the same layering as platform-users.ts: no Next, no
 * Supabase).
 *
 * WHY THIS EXISTS
 * The super-admin "Assessments" section is a READ-ONLY, cross-tenant view of
 * the exams institutions have created. Its rules — which status values a
 * filter may target, how untrusted searchParams are clamped, how aggregate
 * count rows collapse, and what may be computed from result percentages —
 * live here so the data layer, the pages, and `npm test` cannot drift.
 *
 * READ-ONLY BY DECISION
 * Exam lifecycle (publish/close/archive) belongs to the owning institution
 * (AGENTS.md §5: teachers manage exams within their tenant). A platform-wide
 * table is an inspection surface, not a control panel — so there is no
 * transition policy here at all; the tenant-owned policy in lib/exams.ts is
 * never applied from this area.
 */

import {
  EXAM_STATUSES,
  isExamStatus,
  type ExamStatus,
} from "./exams.ts";

export { EXAM_STATUSES, isExamStatus };
export type { ExamStatus };

// --- Untrusted searchParams → bounded query -----------------------------------
// Same contract as resolveUserDirectoryQuery / resolveInstitutionDirectoryQuery.

export const ASSESSMENT_DIRECTORY_PAGE_SIZE = 20;

/** Cap free-text length so a huge param can't reach the query planner. */
const SEARCH_MAX_LENGTH = 120;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An exam id from the URL must be a UUID before it reaches any query. */
export function isValidExamId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export type AssessmentDirectoryQuery = {
  q: string;
  status: ExamStatus | null;
  institutionId: string | null;
  page: number;
  pageSize: number;
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** Normalise an unknown value to an exam status or `null` (never a guess). */
export function normalizeExamStatusFilter(
  value: string | string[] | undefined,
): ExamStatus | null {
  const raw = firstValue(value).toLowerCase();
  return isExamStatus(raw) ? raw : null;
}

/** Turn raw searchParams into a safe, bounded directory query. */
export function resolveAssessmentDirectoryQuery(searchParams: {
  q?: string | string[];
  status?: string | string[];
  institution?: string | string[];
  page?: string | string[];
}): AssessmentDirectoryQuery {
  const parsed = Number.parseInt(firstValue(searchParams.page), 10);
  return {
    q: firstValue(searchParams.q).trim().slice(0, SEARCH_MAX_LENGTH),
    status: normalizeExamStatusFilter(searchParams.status),
    institutionId: isValidExamIdInstitution(searchParams.institution),
    page: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
    pageSize: ASSESSMENT_DIRECTORY_PAGE_SIZE,
  };
}

/** Institution filter values must be UUIDs; anything else drops to null. */
function isValidExamIdInstitution(value: string | string[] | undefined): string | null {
  const raw = firstValue(value);
  return UUID_PATTERN.test(raw) ? raw : null;
}

/**
 * Build a directory URL for a page, preserving the active filters. Empty
 * values are omitted so the unfiltered first page is a clean path.
 */
export function assessmentDirectoryHref(
  base: string,
  query: AssessmentDirectoryQuery,
  overrides: Partial<Pick<AssessmentDirectoryQuery, "status" | "page">>,
): string {
  const next: AssessmentDirectoryQuery = { ...query, ...overrides };
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.status) params.set("status", next.status);
  if (next.institutionId) params.set("institution", next.institutionId);
  if (next.page > 1) params.set("page", String(next.page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Escape a free-text search term for a PostgREST `ilike` filter — the same
 * sanitiser contract as toInstitutionContainsPattern (strip `*`, `,`, `%`,
 * `(`, `)` which break filter syntax). Empty-after-cleaning → "" so the
 * caller skips the filter rather than sending a broken one.
 */
export function toAssessmentContainsPattern(term: string): string {
  const cleaned = term.replace(/[*,%()]/g, "").trim();
  return cleaned.length > 0 ? `%${cleaned}%` : "";
}

// --- Aggregate helpers (pure collapse of count-group rows) ----------------------

/** One `{ key, n }` row from a grouped head count (see the data layer's
 *  `.group()` reads). `n` arrives as a string from PostgREST. */
export type CountGroupRow = { key: string; n: string | number };

/**
 * Collapse grouped count rows into a map. Rows with a missing key are
 * ignored; repeated keys SUM (never overwrite) so a partially-failed group
 * read cannot silently drop rows.
 */
export function collapseCountGroups(
  rows: readonly CountGroupRow[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.key !== "string" || row.key === "") continue;
    const value = typeof row.n === "number" ? row.n : Number.parseInt(row.n, 10);
    if (!Number.isFinite(value)) continue;
    out.set(row.key, (out.get(row.key) ?? 0) + value);
  }
  return out;
}

/**
 * Mean percentage over result percentages, rounded to whole tenths
 * (e.g. 66.7). Returns null for an empty input — NEVER a fake 0: "no
 * results yet" and "average 0%" must stay distinguishable in the UI.
 */
export function meanPercentage(values: readonly number[]): number | null {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return null;
  const sum = usable.reduce((acc, value) => acc + value, 0);
  return Math.round((sum / usable.length) * 10) / 10;
}

// --- Normalising PostgREST exam rows (pure, defensive) ---------------------------

export type RawExamListRow = {
  id: string;
  title: string;
  status: string;
  institution_id: string;
  subject_id: string | null;
  duration_minutes: number | null;
  starts_at: string | null;
  ends_at: string | null;
  published_at: string | null;
  published_to: number | null;
  created_at: string;
  institution: { name?: string } | { name?: string }[] | null;
  subject: { name?: string } | { name?: string }[] | null;
};

export type PlatformAssessmentRow = {
  id: string;
  title: string;
  /** A stored status outside the catalog degrades to null — the row renders
   *  "Unknown" rather than guessing a lifecycle state. */
  status: ExamStatus | null;
  institutionId: string;
  institutionName: string | null;
  subjectName: string | null;
  durationMinutes: number | null;
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
  publishedTo: number | null;
  createdAt: string;
  /** Live question count, or null when the aggregate read failed. */
  questionCount: number | null;
  /** Live attempt count (any state), or null when the read failed. */
  attemptCount: number | null;
};

/** Embeds arrive as object, one-element array, or null depending on
 *  FK nullability — normalise to `string | null` without guessing. */
function embedName(
  embed: RawExamListRow["institution"] | RawExamListRow["subject"],
): string | null {
  if (!embed) return null;
  const row = Array.isArray(embed) ? embed[0] : embed;
  const name = row?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** Normalise raw exam rows (plus the aggregate maps) into directory rows.
 *  A row whose status is outside the catalog keeps `status: null`; the
 *  `knownStatuses` option lets the status-tab counts filter them out. */
export function normalizeExamRows(
  rows: readonly RawExamListRow[],
  counts: {
    questions: Map<string, number>;
    attempts: Map<string, number>;
    /** When an aggregate read failed entirely, pass null so every row shows
     *  "unavailable" for that column instead of a fabricated 0. */
    questionsAvailable: boolean;
    attemptsAvailable: boolean;
  },
): PlatformAssessmentRow[] {
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: isExamStatus(row.status) ? row.status : null,
    institutionId: row.institution_id,
    institutionName: embedName(row.institution),
    subjectName: embedName(row.subject),
    durationMinutes:
      typeof row.duration_minutes === "number" ? row.duration_minutes : null,
    startsAt: row.starts_at ?? null,
    endsAt: row.ends_at ?? null,
    publishedAt: row.published_at ?? null,
    publishedTo:
      typeof row.published_to === "number" ? row.published_to : null,
    createdAt: row.created_at,
    questionCount: counts.questionsAvailable
      ? (counts.questions.get(row.id) ?? 0)
      : null,
    attemptCount: counts.attemptsAvailable
      ? (counts.attempts.get(row.id) ?? 0)
      : null,
  }));
}

/**
 * The release chip on the detail page, from real columns only:
 * `published_to` (0012) is the count of students the exam was released to,
 * set at publish time. No published_at → "not published". Never a guess.
 */
export function assessmentReleaseLabel(
  publishedAt: string | null,
  publishedTo: number | null,
): string {
  if (!publishedAt) return "Not published";
  const audience =
    publishedTo === null || publishedTo === undefined
      ? "released"
      : `released to ${publishedTo.toLocaleString()} student${publishedTo === 1 ? "" : "s"}`;
  return audience;
}
