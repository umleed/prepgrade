/**
 * Platform assessments (exams) directory — SERVER-ONLY data access for the
 * super-admin "Assessments" section.
 *
 * Same posture as lib/data/platform-overview.ts / platform-users.ts: every
 * figure is a live query against a table that exists, cross-tenant reads are
 * legitimate ONLY after `requireSuperAdmin()` has passed (nothing here
 * enforces auth itself), and a failed aggregate degrades to "unavailable"
 * rather than a fabricated zero.
 *
 * PRIVACY (AGENTS.md §7): the list carries exam metadata + head counts only.
 * The detail view adds attempt/status aggregates and the mean of released
 * result percentages — never a student row, name, or individual score.
 * Question CONTENT (text, options, answer key) is tenant-owned and is not
 * selected here at all: exam structure is shown as counts, not content.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExamStatus } from "@/lib/exams";
import {
  isValidExamId,
  meanPercentage,
  normalizeExamRows,
  toAssessmentContainsPattern,
  type AssessmentDirectoryQuery,
  type PlatformAssessmentRow,
  type RawExamListRow,
} from "@/lib/platform-assessments";
import { EXAM_STATUSES } from "@/lib/platform-assessments";

export type PlatformAssessmentListResult = {
  rows: PlatformAssessmentRow[];
  total: number;
};

const EXAM_SELECT =
  "id, title, status, institution_id, subject_id, duration_minutes, starts_at, ends_at, published_at, created_at, institution:institutions(name), subject:subjects(name)";

/** Exact head count of rows in `table` filtered to the given exam ids.
 *  Returns null when the read FAILED (never confused with a real 0). */
async function countForExamIds(
  supabase: SupabaseClient,
  table: string,
  column: string,
  examIds: readonly string[],
): Promise<number | null> {
  if (examIds.length === 0) return 0;
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .in(column, [...examIds]);
  return error ? null : (count ?? 0);
}

/**
 * Paginated, searchable exam directory across all tenants. Every searchParams
 * value must already have passed `resolveAssessmentDirectoryQuery` (the pure
 * resolver), but the UUID/status checks are re-applied here fail-closed.
 */
export async function listPlatformAssessments(
  query: AssessmentDirectoryQuery,
): Promise<PlatformAssessmentListResult> {
  const supabase = createAdminClient();
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  let builder = supabase.from("exams").select(EXAM_SELECT, { count: "exact" });
  if (query.institutionId) {
    builder = builder.eq("institution_id", query.institutionId);
  }
  // Fail-closed re-check: an unknown status is dropped, never injected.
  if (query.status && EXAM_STATUSES.includes(query.status)) {
    builder = builder.eq("status", query.status);
  }
  const pattern = toAssessmentContainsPattern(query.q);
  if (pattern) builder = builder.ilike("title", pattern);

  const { data, error, count } = await builder
    .order("created_at", { ascending: false })
    .range(from, to);
  if (error) throw error;

  const rawRows = (data ?? []) as unknown as RawExamListRow[];
  const examIds = rawRows.map((row) => row.id);

  // Per-row aggregates. A failing read for one exam degrades that row's
  // column to "unavailable" (null), never to a fabricated 0.
  const [questionCounts, attemptCounts] = await Promise.all([
    perExamCounts(supabase, "exam_questions", examIds),
    perExamCounts(supabase, "exam_attempts", examIds),
  ]);

  return {
    total: count ?? 0,
    rows: normalizeExamRows(rawRows, {
      questions: questionCounts.map,
      attempts: attemptCounts.map,
      questionsAvailable: questionCounts.ok,
      attemptsAvailable: attemptCounts.ok,
    }),
  };
}

/**
 * Question/attempt counts per listed exam: one exact head count per exam id,
 * in parallel (bounded by the page size). Grouped `.count()` aggregates are
 * deliberately NOT used — the installed client types do not expose
 * `.group()`, and this area only runs proven query shapes. If ANY count
 * fails the whole column is marked unavailable so the UI renders "—",
 * never a partially-wrong set of numbers.
 */
async function perExamCounts(
  supabase: SupabaseClient,
  table: "exam_questions" | "exam_attempts",
  examIds: string[],
): Promise<{ map: Map<string, number>; ok: boolean }> {
  if (examIds.length === 0) return { map: new Map(), ok: true };
  try {
    const entries = await Promise.all(
      examIds.map(async (id) => {
        const { count, error } = await supabase
          .from(table)
          .select("*", { count: "exact", head: true })
          .eq("exam_id", id);
        if (error) throw error;
        return [id, count ?? 0] as const;
      }),
    );
    return { map: new Map(entries), ok: true };
  } catch {
    return { map: new Map(), ok: false };
  }
}

/**
 * Live per-status exam counts for the directory tabs. Any failing count
 * degrades the whole map to null — a partial breakdown is never rendered
 * as complete. (Parallel filtered head counts, the same shape as
 * getInstitutionStatusCounts; no `.group()` dependency.)
 */
export async function getAssessmentStatusCounts(
  institutionId: string | null,
): Promise<Record<ExamStatus, number> | null> {
  const supabase = createAdminClient();
  const counts = await Promise.all(
    EXAM_STATUSES.map(async (status) => {
      let builder = supabase
        .from("exams")
        .select("*", { count: "exact", head: true })
        .eq("status", status);
      if (institutionId) builder = builder.eq("institution_id", institutionId);
      const { count, error } = await builder;
      return error ? null : (count ?? 0);
    }),
  );
  if (counts.some((value) => value === null)) return null;
  const out = {} as Record<ExamStatus, number>;
  EXAM_STATUSES.forEach((status, index) => {
    out[status] = counts[index] as number;
  });
  return out;
}

// --- Single-exam operational detail (read-only) ---------------------------------

export type AssessmentAttemptSummary = {
  total: number;
  inProgress: number;
  submitted: number;
  expired: number;
};

export type AssessmentResultSummary = {
  total: number;
  released: number;
  /** Mean of result percentages (whole tenths), or null when there are no
   *  results / the read failed — never a fake 0. */
  meanPercentage: number | null;
};

export type PlatformAssessmentDetail = {
  id: string;
  title: string;
  description: string | null;
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
  /** Bank questions attached to the exam; null when the count failed. */
  questionCount: number | null;
  /** Snapshot rows (0011) frozen at publish; null when the count failed. */
  snapshotCount: number | null;
  attempts: AssessmentAttemptSummary | null;
  results: AssessmentResultSummary | null;
};

/**
 * Read one exam's operational detail across tenants. Returns null when no
 * such exam exists (a bad/removed id); the id is re-validated fail-closed
 * here even though the page resolved the route param first. No student,
 * answer, or answer-key column is ever selected.
 */
export async function getPlatformAssessmentDetail(
  id: string,
): Promise<PlatformAssessmentDetail | null> {
  if (!isValidExamId(id)) return null;
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("exams")
    .select(
      `id, title, description, status, institution_id, duration_minutes, starts_at, ends_at, published_at, published_to, created_at, institution:institutions(name), subject:subjects(name)`,
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as RawExamListRow & {
    description: string | null;
    published_to: number | null;
  };

  const [questionCount, snapshotCount, attemptRows, resultRows] = await Promise.all([
    countForExamIds(supabase, "exam_questions", "exam_id", [id]),
    countForExamIds(supabase, "exam_question_snapshots", "exam_id", [id]),
    supabase
      .from("exam_attempts")
      .select("id, status")
      .eq("exam_id", id)
      .range(0, 999),
    supabase
      .from("exam_results")
      .select("percentage, released_at")
      .eq("exam_id", id)
      .range(0, 999),
  ]);

  // Attempt bucketing from the (bounded) status read — the counts are exact
  // up to 1000 attempts; beyond that the summary is marked by the read cap
  // and reported as such rather than silently truncated.
  let attempts: AssessmentAttemptSummary | null = null;
  if (!attemptRows.error) {
    const statuses = (attemptRows.data ?? []).map(
      (r) => (r as { status: string }).status,
    );
    attempts = {
      total: statuses.length,
      inProgress: statuses.filter((status) => status === "in_progress").length,
      submitted: statuses.filter((status) => status === "submitted").length,
      expired: statuses.filter((status) => status === "expired").length,
    };
  }

  let results: AssessmentResultSummary | null = null;
  if (!resultRows.error) {
    const rows = (resultRows.data ?? []) as unknown as {
      percentage: number | string;
      released_at: string | null;
    }[];
    results = {
      total: rows.length,
      released: rows.filter((r) => r.released_at !== null).length,
      meanPercentage: meanPercentage(
        rows.map((r) => Number(r.percentage)),
      ),
    };
  }

  const institutionName = (() => {
    const embed = row.institution;
    const resolved = Array.isArray(embed) ? embed[0] : embed;
    return typeof resolved?.name === "string" ? resolved.name : null;
  })();
  const subjectName = (() => {
    const embed = row.subject;
    const resolved = Array.isArray(embed) ? embed[0] : embed;
    return typeof resolved?.name === "string" ? resolved.name : null;
  })();

  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    status:
      typeof row.status === "string" &&
      EXAM_STATUSES.includes(row.status as ExamStatus)
        ? (row.status as ExamStatus)
        : null,
    institutionId: row.institution_id,
    institutionName,
    subjectName,
    durationMinutes:
      typeof row.duration_minutes === "number" ? row.duration_minutes : null,
    startsAt: row.starts_at ?? null,
    endsAt: row.ends_at ?? null,
    publishedAt: row.published_at ?? null,
    publishedTo:
      typeof row.published_to === "number" ? row.published_to : null,
    createdAt: row.created_at,
    questionCount,
    snapshotCount,
    attempts,
    results,
  };
}
