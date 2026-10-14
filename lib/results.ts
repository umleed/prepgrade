/**
 * Result-view contract & display rules — pure, dependency-free, unit-testable.
 *
 * WHAT THIS AREA IS FOR (prompt 25)
 * The grading engine (prompt 24) already turned a locked attempt into a durable
 * `exam_results` row of DERIVED facts. This module is the thin, shared layer the
 * result VIEWS read those facts through, so a shown number and an authoritative
 * one can never drift (AGENTS.md §6). It holds three things and nothing else:
 *   1. the student-visibility gate — the SAME release rule the grading layer
 *      uses (`isResultReleased`), expressed as a display status so no surface
 *      reveals a score, percentage, or subject breakdown before the exam's
 *      release policy permits it;
 *   2. consistent formatting — one spelling of a percentage, a score, and a
 *      time-used duration shared by the student and staff views, so the two can
 *      never report the same result differently;
 *   3. a defensive reader for the stored `subject_breakdown` jsonb, built only
 *      from valid snapshot metadata (an unresolvable subject id simply drops
 *      out — it is never guessed or fabricated, AGENTS.md §7).
 *
 * NO ANSWER KEYS LIVE HERE
 * A result row carries aggregate counts and per-subject stats — never a correct
 * option, answer key, or explanation (those stay in the frozen snapshot). This
 * module never reads or re-derives a score: it only formats and gates facts the
 * grading layer already computed on the server (AGENTS.md §6).
 */

import { isResultReleased } from "./grading.ts";

// --- Student visibility (the release gate, expressed for display) ------------

/** The exam's frozen result-release policy (`exams.results_release`, 0011). */
export type ExamResultRelease = "immediate" | "after_window" | "manual";

/** Whether a graded result may be shown to its student yet. */
export type StudentResultVisibility = "released" | "not_yet_released";

export const STUDENT_RESULT_VISIBILITY_LABELS: Record<
  StudentResultVisibility,
  string
> = {
  released: "Released",
  not_yet_released: "Not yet released",
};

export type ResultReleaseInput = {
  /** The exam's frozen policy. */
  resultsRelease: ExamResultRelease;
  /** Epoch ms the result was computed on the server, or null if ungraded. */
  gradedAtMs: number | null;
  /** Epoch ms the availability window closed, or null when unscheduled. */
  windowEndsAtMs: number | null;
  /** Epoch ms an explicit release stamp was set (manual path), or null. */
  releasedAtMs: number | null;
  nowMs?: number;
};

/**
 * The one rule that decides whether a student may see a result's numbers. It
 * delegates to `isResultReleased` so the grading layer and the result views
 * share a single source and can never disagree about what "released" means:
 *   * `manual` — only once an explicit release stamp exists;
 *   * `after_window` — once the availability window has closed (an unscheduled
 *     exam falls back to released-on-grade);
 *   * `immediate` — as soon as it has been graded.
 * An ungraded result is never visible under any policy.
 */
export function studentResultVisibility(
  input: ResultReleaseInput,
): StudentResultVisibility {
  return isResultReleased({
    resultsRelease: input.resultsRelease,
    gradedAtMs: input.gradedAtMs,
    windowEndsAtMs: input.windowEndsAtMs,
    releasedAtMs: input.releasedAtMs,
    nowMs: input.nowMs,
  })
    ? "released"
    : "not_yet_released";
}

/**
 * A plain-language explanation of WHEN a not-yet-released result will appear,
 * derived from the exam's own policy — never a fabricated date. Used only for a
 * `not_yet_released` result; a released one needs no hint.
 */
export function releaseHint(resultsRelease: ExamResultRelease): string {
  switch (resultsRelease) {
    case "immediate":
      // Only reached in a pathological clock race (immediate releases on grade).
      return "Your result is being finalised and will appear shortly.";
    case "manual":
      return "Your teacher releases results manually; it will appear once they do.";
    case "after_window":
      return "Your result will appear after the exam's availability window closes.";
  }
}

// --- Consistent formatting (shared by student & staff views) -----------------

/**
 * Format a stored percentage (whole hundredths, e.g. 66.67) for display. A
 * non-finite value collapses to `—` rather than a misleading number.
 */
export function formatPercentage(percentage: number): string {
  if (!Number.isFinite(percentage)) return "—";
  // Show whole numbers without a trailing ".00", keep genuine decimals.
  const rounded = Math.round(percentage * 100) / 100;
  const text = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2);
  return `${text}%`;
}

/** "12 / 18" — marks earned over marks available, with singular "mark" aware copy. */
export function formatScore(score: number, max: number): string {
  const safeScore = Number.isFinite(score) ? score : 0;
  const safeMax = Number.isFinite(max) ? max : 0;
  return `${safeScore} / ${safeMax}`;
}

/**
 * A time-used duration from whole seconds. Sub-minute reads "45s", minutes
 * read "12m 30s", hours read "1h 05m" (seconds dropped once minutes are known).
 * A zero/negative/non-finite value reads "—" rather than a fake "0s".
 */
export function formatTimeUsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  const secs = total % 60;
  return `${minutes}m ${String(secs).padStart(2, "0")}s`;
}

// --- Subject breakdown (defensive read of the stored jsonb) ------------------

/** One subject's performance as the grading layer stored it. */
export type StoredSubjectStat = {
  subjectId: string;
  correct: number;
  total: number;
  score: number;
  maxScore: number;
};

/** A breakdown row with its subject name resolved and percentage derived. */
export type SubjectResultRow = {
  subjectId: string;
  subjectName: string;
  correct: number;
  total: number;
  score: number;
  maxScore: number;
  /** Whole hundredths; 0 when the subject carries no marks to divide by. */
  percentage: number;
};

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // numeric columns can arrive from PostgREST as strings; accept a clean one.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Parse the `subject_breakdown` jsonb into display rows. Every stored value is
 * treated as UNTRUSTED shape: a malformed entry (missing/non-string subjectId,
 * non-numeric buckets) is dropped, never coerced into a guess. `nameFor` maps a
 * subject id to a display name; an unresolved id falls back to "—" (the id came
 * from our own tenant's snapshot but its catalogue row may since have gone).
 * Results are sorted by subject name so the table order is stable.
 */
export function buildSubjectRows(
  breakdown: readonly unknown[],
  nameFor: (subjectId: string) => string | null,
): SubjectResultRow[] {
  const rows: SubjectResultRow[] = [];
  for (const entry of breakdown) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const subjectId = record.subjectId;
    if (typeof subjectId !== "string" || subjectId.length === 0) continue;

    const correct = asFiniteNumber(record.correct) ?? 0;
    const total = asFiniteNumber(record.total) ?? 0;
    const score = asFiniteNumber(record.score) ?? 0;
    const maxScore = asFiniteNumber(record.maxScore) ?? 0;

    rows.push({
      subjectId,
      subjectName: nameFor(subjectId) ?? "—",
      correct,
      total,
      score,
      maxScore,
      percentage:
        maxScore > 0 ? Math.round(((score / maxScore) * 100 + Number.EPSILON) * 100) / 100 : 0,
    });
  }
  return rows.sort((a, b) => a.subjectName.localeCompare(b.subjectName));
}

/** The distinct subject ids a breakdown references (for a batched name lookup). */
export function breakdownSubjectIds(breakdown: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const entry of breakdown) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const subjectId = (entry as Record<string, unknown>).subjectId;
    if (typeof subjectId === "string" && subjectId.length > 0) ids.add(subjectId);
  }
  return [...ids];
}
