/**
 * Platform question-bank directory — SERVER-ONLY data access for the
 * super-admin "Question Bank" section.
 *
 * Same posture as platform-overview.ts / platform-users.ts / platform-
 * assessments.ts: live queries against real tables, cross-tenant reads
 * legitimate ONLY after `requireSuperAdmin()` (nothing here enforces auth),
 * failed aggregates degrade to "unavailable" not 0.
 *
 * CONTENT RIGHTS & PRIVACY (AGENTS.md §6, §7): the SELECT lists only content
 * METADATA. `question_text`, `options`, `correct_option_index`, and
 * `explanation` are NEVER selected — the answer key and item content are the
 * most sensitive data on the platform and belong to the owning institution.
 * This is a read-only inspection surface; there are no writes here.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import { isMissingTableError, type MetricState } from "@/lib/data/platform-overview";
import type { QuestionDifficulty } from "@/lib/questions";
import {
  normalizeQuestionRows,
  toQuestionContainsPattern,
  QUESTION_DIFFICULTIES,
  type PlatformQuestionRow,
  type QuestionDirectoryQuery,
  type RawQuestionRow,
} from "@/lib/platform-question-bank";

export type PlatformQuestionListResult = {
  rows: PlatformQuestionRow[];
  total: number;
};

/** Metadata columns ONLY — no content, no options, no answer key, no
 *  explanation. Any addition here is a privacy decision, not a convenience. */
const QUESTION_SELECT =
  "id, institution_id, subject_id, difficulty, provenance, status, source_label, source_year, marks, created_at, institution:institutions(name), subject:subjects(name)";

/**
 * Paginated, filterable question directory across all tenants. Every value
 * in `query` must already have passed `resolveQuestionDirectoryQuery`; the
 * enum/UUID checks are re-applied fail-closed here so a caller that skips the
 * resolver still cannot inject an arbitrary column value.
 */
export async function listPlatformQuestions(
  query: QuestionDirectoryQuery,
): Promise<PlatformQuestionListResult> {
  const supabase = createAdminClient();
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  let builder = supabase.from("questions").select(QUESTION_SELECT, {
    count: "exact",
  });

  if (query.institutionId) {
    builder = builder.eq("institution_id", query.institutionId);
  }
  if (query.status) builder = builder.eq("status", query.status);
  if (query.difficulty) builder = builder.eq("difficulty", query.difficulty);
  if (query.provenance) builder = builder.eq("provenance", query.provenance);
  // Search touches source_label (non-sensitive provenance text) only.
  const pattern = toQuestionContainsPattern(query.q);
  if (pattern) builder = builder.ilike("source_label", pattern);

  const { data, error, count } = await builder
    .order("created_at", { ascending: false })
    .range(from, to);
  if (error) throw error;

  return {
    total: count ?? 0,
    rows: normalizeQuestionRows((data ?? []) as unknown as RawQuestionRow[]),
  };
}

/**
 * Difficulty breakdown of the live bank, narrowed by the same filters as the
 * directory (minus pagination) so the summary tiles describe what is on
 * screen. A missing `questions` table degrades to `missing_table`; any other
 * failure to `error` — never a confident zero.
 *
 * Implemented with per-difficulty filtered head counts (proven query shape,
 * no `.group()` dependency): 3 counts for the current catalog.
 */
export async function getQuestionDifficultyBreakdown(
  query: QuestionDirectoryQuery,
): Promise<MetricState<Map<string, number>>> {
  const supabase = createAdminClient();
  const counts = new Map<string, number>();

  for (const difficulty of QUESTION_DIFFICULTIES as readonly QuestionDifficulty[]) {
    let builder = supabase
      .from("questions")
      .select("*", { count: "exact", head: true })
      .eq("status", "active")
      .eq("difficulty", difficulty);
    if (query.institutionId) {
      builder = builder.eq("institution_id", query.institutionId);
    }
    const { count, error } = await builder;
    if (error) {
      return {
        state: "unavailable",
        reason: isMissingTableError(error) ? "missing_table" : "error",
      };
    }
    counts.set(difficulty, count ?? 0);
  }

  return { state: "available", value: counts };
}

/**
 * Head counts for the summary tiles: live questions, archived questions,
 * and the append-only edit history (question_versions, 0009). Each figure
 * degrades independently and honestly ("unavailable", never a confident 0).
 * When a tenant filter is active, all three narrow to that tenant.
 */
export async function getQuestionBankTotals(
  institutionId: string | null,
): Promise<{
  active: MetricState<number>;
  archived: MetricState<number>;
  versions: MetricState<number>;
}> {
  const supabase = createAdminClient();

  /** Exact head count of `table`, narrowed to one tenant when a filter is
   *  active, and optionally to a `status`. A null tenant means the
   *  platform-wide count. Any failure degrades to an unavailable state. */
  const headCount = async (
    table: string,
    status?: string,
  ): Promise<MetricState<number>> => {
    let builder = supabase
      .from(table)
      .select("*", { count: "exact", head: true });
    if (status) builder = builder.eq("status", status);
    if (institutionId) builder = builder.eq("institution_id", institutionId);
    const { count, error } = await builder;
    if (error) {
      return {
        state: "unavailable",
        reason: isMissingTableError(error) ? "missing_table" : "error",
      };
    }
    return { state: "available", value: count ?? 0 };
  };

  const [active, archived, versions] = await Promise.all([
    headCount("questions", "active"),
    headCount("questions", "archived"),
    // Append-only edit history (0009) — an honest "edits preserved" figure.
    headCount("question_versions"),
  ]);

  return { active, archived, versions };
}
