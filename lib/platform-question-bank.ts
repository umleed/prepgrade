/**
 * Platform question-bank directory contract — pure, dependency-free, and
 * unit-testable (the same layering as platform-assessments.ts).
 *
 * WHY THIS EXISTS
 * The super-admin "Question Bank" section is a READ-ONLY, cross-tenant view
 * of the questions institutions have authored. Its rules — which filters a
 * searchParam may set, how untrusted values are clamped, and how content
 * columns are treated — live here so the data layer, the page, and `npm test`
 * cannot drift.
 *
 * CONTENT RIGHTS & PRIVACY (AGENTS.md §6, §7)
 * Questions are teacher- or institution-owned assessment content; the answer
 * key is the most sensitive field on the platform. This area therefore lists
 * CONTENT METADATA (subject, difficulty, provenance, status, counts) and does
 * NOT select `question_text`, `options`, `correct_option_index`, or
 * `explanation`. Nothing here mutates a tenant's bank — authoring, archiving,
 * and review all happen inside the owning institution.
 */

import {
  QUESTION_DIFFICULTIES,
  QUESTION_PROVENANCES,
  QUESTION_STATUSES,
  isQuestionDifficulty,
  isQuestionProvenance,
  type QuestionDifficulty,
  type QuestionProvenance,
  type QuestionStatus,
} from "./questions.ts";

export {
  QUESTION_DIFFICULTIES,
  QUESTION_PROVENANCES,
  QUESTION_STATUSES,
  isQuestionDifficulty,
  isQuestionProvenance,
};
export type { QuestionDifficulty, QuestionProvenance, QuestionStatus };

// --- Untrusted searchParams → bounded query -----------------------------------

export const QUESTION_DIRECTORY_PAGE_SIZE = 20;
const SEARCH_MAX_LENGTH = 120;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidInstitutionUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export type QuestionDirectoryQuery = {
  q: string;
  status: QuestionStatus | null;
  difficulty: QuestionDifficulty | null;
  provenance: QuestionProvenance | null;
  institutionId: string | null;
  page: number;
  pageSize: number;
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** Normalise an unknown value to a member of a catalog, or null (never a
 *  default guess). */
function normalizeEnum<T extends string>(
  value: string | string[] | undefined,
  catalog: readonly T[],
): T | null {
  const raw = firstValue(value).toLowerCase();
  return (catalog as readonly string[]).includes(raw) ? (raw as T) : null;
}

export function resolveQuestionDirectoryQuery(searchParams: {
  q?: string | string[];
  status?: string | string[];
  difficulty?: string | string[];
  provenance?: string | string[];
  institution?: string | string[];
  page?: string | string[];
}): QuestionDirectoryQuery {
  const parsed = Number.parseInt(firstValue(searchParams.page), 10);
  const rawInstitution = firstValue(searchParams.institution);
  return {
    q: firstValue(searchParams.q).trim().slice(0, SEARCH_MAX_LENGTH),
    status: normalizeEnum(searchParams.status, QUESTION_STATUSES),
    difficulty: normalizeEnum(searchParams.difficulty, QUESTION_DIFFICULTIES),
    provenance: normalizeEnum(searchParams.provenance, QUESTION_PROVENANCES),
    institutionId: UUID_PATTERN.test(rawInstitution) ? rawInstitution : null,
    page: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
    pageSize: QUESTION_DIRECTORY_PAGE_SIZE,
  };
}

/** True when any narrowing filter is active (drives the empty-state wording). */
export function questionQueryHasFilters(
  query: QuestionDirectoryQuery,
): boolean {
  return (
    query.q.length > 0 ||
    query.status !== null ||
    query.difficulty !== null ||
    query.provenance !== null ||
    query.institutionId !== null
  );
}

/**
 * Build a directory URL, preserving the active filters. Empty values are
 * omitted so the unfiltered first page is a clean path.
 */
export function questionDirectoryHref(
  base: string,
  query: QuestionDirectoryQuery,
  overrides: Partial<QuestionDirectoryQuery>,
): string {
  const next: QuestionDirectoryQuery = { ...query, ...overrides };
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.status) params.set("status", next.status);
  if (next.difficulty) params.set("difficulty", next.difficulty);
  if (next.provenance) params.set("provenance", next.provenance);
  if (next.institutionId) params.set("institution", next.institutionId);
  if (next.page > 1) params.set("page", String(next.page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Search-pattern sanitiser — the same contract as the other directories
 * (strip `*`, `,`, `%`, `(`, `)`). Applied to `source_label` only: the free
 * text of a question is content we never query on from the platform area.
 */
export function toQuestionContainsPattern(term: string): string {
  const cleaned = term.replace(/[*,%()]/g, "").trim();
  return cleaned.length > 0 ? `%${cleaned}%` : "";
}

// --- Normalising PostgREST question rows (pure, defensive) ---------------------

export type RawQuestionRow = {
  id: string;
  institution_id: string;
  subject_id: string | null;
  difficulty: string;
  provenance: string;
  status: string;
  source_label: string | null;
  source_year: number | null;
  marks: number | null;
  created_at: string;
  institution: { name?: string } | { name?: string }[] | null;
  subject: { name?: string } | { name?: string }[] | null;
};

export type PlatformQuestionRow = {
  id: string;
  institutionId: string;
  institutionName: string | null;
  subjectName: string | null;
  difficulty: QuestionDifficulty | null;
  provenance: QuestionProvenance | null;
  status: QuestionStatus | null;
  sourceLabel: string | null;
  sourceYear: number | null;
  marks: number | null;
  createdAt: string;
};

function embedName(
  embed: RawQuestionRow["institution"] | RawQuestionRow["subject"],
): string | null {
  if (!embed) return null;
  const row = Array.isArray(embed) ? embed[0] : embed;
  const name = row?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/**
 * Normalise raw rows. Any column outside its catalog degrades to null (the
 * CHECK constraints make that impossible in practice, but a value we cannot
 * name is never rendered as a trusted one).
 */
export function normalizeQuestionRows(
  rows: readonly RawQuestionRow[],
): PlatformQuestionRow[] {
  return rows.map((row) => ({
    id: row.id,
    institutionId: row.institution_id,
    institutionName: embedName(row.institution),
    subjectName: embedName(row.subject),
    difficulty: isQuestionDifficulty(row.difficulty) ? row.difficulty : null,
    provenance: isQuestionProvenance(row.provenance) ? row.provenance : null,
    status: (QUESTION_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as QuestionStatus)
      : null,
    sourceLabel: typeof row.source_label === "string" ? row.source_label : null,
    sourceYear:
      typeof row.source_year === "number" ? row.source_year : null,
    marks: typeof row.marks === "number" ? row.marks : null,
    createdAt: row.created_at,
  }));
}

/** Provenance display labels (mirrors lib/questions.ts, kept local for the
 *  platform copy). */
export const QUESTION_PROVENANCE_LABELS: Record<QuestionProvenance, string> = {
  teacher_created: "Teacher-created",
  licensed: "Licensed",
};

export const QUESTION_STATUS_LABELS: Record<QuestionStatus, string> = {
  active: "Active",
  archived: "Archived",
};

// --- Summary buckets (pure collapse of grouped counts) --------------------------

/**
 * Turn difficulty breakdown rows into a fixed-order, fully-keyed summary so
 * the UI never shows a partial picture: every catalog difficulty is present
 * (0 when absent) and the total is their sum. A null input (failed read)
 * yields null — "unavailable", never an empty-but-complete-looking summary.
 */
export function buildDifficultySummary(
  counts: Map<string, number> | null,
): { byDifficulty: Record<QuestionDifficulty, number>; total: number } | null {
  if (counts === null) return null;
  const byDifficulty = {} as Record<QuestionDifficulty, number>;
  let total = 0;
  for (const difficulty of QUESTION_DIFFICULTIES) {
    const value = counts.get(difficulty) ?? 0;
    byDifficulty[difficulty] = value;
    total += value;
  }
  return { byDifficulty, total };
}
