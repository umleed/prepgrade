/**
 * Student performance view rules — pure, dependency-free, unit-testable.
 *
 * WHAT THIS AREA IS FOR (prompt 29)
 * A student-facing read of the SAME graded facts the staff analytics use
 * (`lib/analytics.ts`), reframed for the learner themself. Every number here is
 * a descriptive recount of what the student already did — an average of their
 * released results, an accuracy per topic, a direction across recent tests.
 * Nothing predicts a future score, labels the student "at risk", or generates
 * AI recommendations (prompt 29 forbids that; AGENTS.md §4 keeps advanced
 * mastery out of MVP). The strong/weakest-area callouts are literal rankings
 * of measured accuracy, phrased supportively, never a diagnosis.
 *
 * MISSING DATA IS NOT ZERO, AND A SMALL SAMPLE IS CALLED OUT (AGENTS.md §7)
 * A metric with no rows behind it is `null`, never a fabricated `0`. On top of
 * the staff honesty rule, a student view must not overstate a thin sample: a
 * 100% topic accuracy from two questions reads very differently from one built
 * on forty, so every area metric carries its question count and a
 * `sampleConfidence` band, and strong/weakest labelling only fires when enough
 * questions and enough spread exist. Below that the view says so plainly
 * instead of inventing a conclusion.
 *
 * ONE SOURCE FOR THE DISPLAY RULES
 * The thresholds and supportive copy live here once so the page, the cards, and
 * any test agree on what "low sample" means and how a trend is described.
 */

import {
  DEFAULT_PASS_MARK,
  computeTopicPerformance,
  type AnalyticsResultRow,
  type TopicPerformance,
} from "./analytics.ts";

// --- Sample-size confidence bands --------------------------------------------

/** How much recorded performance stands behind a metric. */
export type SampleConfidence = "none" | "insufficient" | "low" | "adequate";

/**
 * Answered questions at/below this for an area are too few to draw any
 * strong/weakest conclusion from — shown as data, never as a label.
 */
export const QUESTIONS_INSUFFICIENT = 2;
/** Below this an area's accuracy is reported but flagged as a small sample. */
export const QUESTIONS_LOW_SAMPLE = 5;
/** A strong vs. weakest contrast needs at least this many questions per area. */
export const MIN_QUESTIONS_PER_AREA_FOR_COMPARISON = QUESTIONS_LOW_SAMPLE;
/** Fewer released results than this is not enough history to call a trend. */
export const MIN_RESULTS_FOR_TREND = 3;

/**
 * Band a question count into a confidence level. `0` (or a non-finite/negative
 * count) is `none` — there is genuinely no data, not a zero score. The bands
 * are a display convention for caution, not a statistical guarantee.
 */
export function sampleConfidence(questionCount: number): SampleConfidence {
  if (!Number.isFinite(questionCount) || questionCount <= 0) return "none";
  if (questionCount <= QUESTIONS_INSUFFICIENT) return "insufficient";
  if (questionCount < QUESTIONS_LOW_SAMPLE) return "low";
  return "adequate";
}

const SAMPLE_CONFIDENCE_LABELS: Record<SampleConfidence, string> = {
  none: "No data yet",
  insufficient: "Not enough data",
  low: "Limited data",
  adequate: "Based on more practice",
};

export function sampleConfidenceLabel(confidence: SampleConfidence): string {
  return SAMPLE_CONFIDENCE_LABELS[confidence];
}

/** Whether a metric is on too thin a sample to be presented as a firm signal. */
export function isLowSample(questionCount: number): boolean {
  const confidence = sampleConfidence(questionCount);
  return confidence === "insufficient" || confidence === "low";
}

// --- Overall summary ---------------------------------------------------------

/** The headline figures for a student's own released performance. */
export type StudentPerformanceSummary = {
  /** Released results behind these numbers — the honest denominator. */
  releasedResults: number;
  /** Graded results the release policy has not shown the student yet. */
  pendingResults: number;
  /** Total questions answered across the released results. */
  totalQuestions: number;
  /** Mean percentage of the released results, null when there are none. */
  averagePercentage: number | null;
  /** Count of released results at/above the reporting pass mark. */
  passed: number;
  failed: number;
  /** The student's single best released result, when any exists. */
  bestResult: { examTitle: string; percentage: number } | null;
  /** Sample band for the overall average (driven by results, not questions). */
  confidence: SampleConfidence;
};

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Recount a student's released results into the headline summary. Rows are the
 * per-exam representative results the data layer assembled (already gated to
 * released ones), so nothing here re-derives a score or trusts a client value.
 * An empty set yields nulls and a `none` band, never a misleading 0%.
 */
export function summarizeStudentPerformance(
  rows: readonly AnalyticsResultRow[],
  pendingResults = 0,
  passMark: number = DEFAULT_PASS_MARK,
): StudentPerformanceSummary {
  const releasedResults = rows.length;
  if (releasedResults === 0) {
    return {
      releasedResults: 0,
      pendingResults: Math.max(0, pendingResults),
      totalQuestions: 0,
      averagePercentage: null,
      passed: 0,
      failed: 0,
      bestResult: null,
      confidence: "none",
    };
  }

  let sum = 0;
  let totalQuestions = 0;
  let passed = 0;
  let best: { examTitle: string; percentage: number } | null = null;
  for (const row of rows) {
    sum += row.percentage;
    totalQuestions += Math.max(0, row.totalQuestions);
    if (row.percentage >= passMark) passed += 1;
    if (best === null || row.percentage > best.percentage) {
      best = { examTitle: row.examTitle ?? "—", percentage: row.percentage };
    }
  }

  // The average's confidence tracks the number of assessments behind it, so a
  // single test is flagged as a thin sample even if it carried many questions.
  const confidence: SampleConfidence =
    releasedResults <= QUESTIONS_INSUFFICIENT
      ? "insufficient"
      : releasedResults < MIN_RESULTS_FOR_TREND
        ? "low"
        : "adequate";

  return {
    releasedResults,
    pendingResults: Math.max(0, pendingResults),
    totalQuestions,
    averagePercentage: round2(sum / releasedResults),
    passed,
    failed: releasedResults - passed,
    bestResult: best,
    confidence,
  };
}

// --- Overall trend -----------------------------------------------------------

/** The direction a student's recent released results are moving. */
export type StudentTrend = {
  /** Null when there is not enough history to describe a direction honestly. */
  direction: "improving" | "steady" | "needs_support" | null;
  releasedResults: number;
  /** Mean of the earlier half vs. the recent half, null when not comparable. */
  earlierAverage: number | null;
  recentAverage: number | null;
  /** Supportive, non-predictive copy describing what the trend shows. */
  note: string;
};

/** Percentage-point movement treated as a real shift vs. "steady" noise. */
const TREND_DELTA = 3;

/**
 * Describe a direction across the student's released results, oldest → newest.
 * This compares the average of the earlier half to the recent half — a recount
 * of recorded scores, NOT a forecast. With fewer than `MIN_RESULTS_FOR_TREND`
 * results it refuses to name a direction and says so kindly, because a "trend"
 * from one or two tests would overstate what the data proves (AGENTS.md §7).
 */
export function computeStudentTrend(
  rows: readonly AnalyticsResultRow[],
): StudentTrend {
  const dated = rows
    .filter((row) => row.gradedAt)
    .map((row) => ({
      percentage: row.percentage,
      stamp: new Date(row.gradedAt as string).getTime(),
    }))
    .filter((entry) => Number.isFinite(entry.stamp))
    .sort((a, b) => a.stamp - b.stamp);

  const releasedResults = rows.length;

  if (dated.length < MIN_RESULTS_FOR_TREND) {
    return {
      direction: null,
      releasedResults,
      earlierAverage: null,
      recentAverage: null,
      note:
        releasedResults === 0
          ? "Your trend appears once a few results have been released."
          : "Complete and release a few more assessments to see a trend — one or two results is not enough to describe a direction.",
    };
  }

  const midpoint = Math.floor(dated.length / 2);
  const earlier = dated.slice(0, midpoint);
  const recent = dated.slice(midpoint);
  const earlierAverage = round2(
    earlier.reduce((sum, entry) => sum + entry.percentage, 0) / earlier.length,
  );
  const recentAverage = round2(
    recent.reduce((sum, entry) => sum + entry.percentage, 0) / recent.length,
  );

  let direction: StudentTrend["direction"];
  let note: string;
  if (recentAverage - earlierAverage >= TREND_DELTA) {
    direction = "improving";
    note = "Your recent results are trending upward — whatever you changed is working, so keep it going.";
  } else if (earlierAverage - recentAverage >= TREND_DELTA) {
    direction = "needs_support";
    note = "Your recent results sit below your earlier ones. This is a moment to slow down on the topics below, not a verdict on your ability.";
  } else {
    direction = "steady";
    note = "Your results have been steady across recent assessments. Steady is a solid base to build targeted practice on.";
  }

  return { direction, releasedResults, earlierAverage, recentAverage, note };
}

// --- Strongest / weakest areas (sample-gated) --------------------------------

/** A student's strongest and weakest topic, only when the data supports it. */
export type AreaHighlights = {
  strongest: TopicPerformance | null;
  weakest: TopicPerformance | null;
  /** Areas with enough recorded questions to be part of the comparison. */
  comparableAreas: number;
  /** Plain reason no contrast is shown (low sample / not enough spread). */
  reason: string | null;
};

/**
 * Pick the strongest and weakest topic by measured accuracy, but ONLY among
 * areas with at least `MIN_QUESTIONS_PER_AREA_FOR_COMPARISON` answered
 * questions, and only when at least two such areas exist to contrast. Otherwise
 * both are null with an honest reason — a student is never told they are "weak"
 * at something on the strength of a handful of answers.
 */
export function studentAreaHighlights(
  topics: readonly TopicPerformance[],
): AreaHighlights {
  const comparable = topics.filter(
    (topic) =>
      topic.accuracy !== null &&
      topic.total >= MIN_QUESTIONS_PER_AREA_FOR_COMPARISON,
  );

  if (comparable.length < 2) {
    const measuredAny = topics.some(
      (topic) => topic.accuracy !== null && topic.total > 0,
    );
    return {
      strongest: null,
      weakest: null,
      comparableAreas: comparable.length,
      reason: measuredAny
        ? "Not enough questions answered per topic yet to compare areas confidently."
        : "Topic accuracy appears once you have answered topic-tagged questions in released results.",
    };
  }

  let strongest = comparable[0];
  let weakest = comparable[0];
  for (const topic of comparable) {
    if (
      topic.accuracy! > strongest.accuracy! ||
      (topic.accuracy! === strongest.accuracy! &&
        topic.topicName.localeCompare(strongest.topicName) < 0)
    ) {
      strongest = topic;
    }
    if (
      topic.accuracy! < weakest.accuracy! ||
      (topic.accuracy! === weakest.accuracy! &&
        topic.topicName.localeCompare(weakest.topicName) < 0)
    ) {
      weakest = topic;
    }
  }

  // A genuine contrast needs a real spread, not two areas tied at one number.
  if (strongest.topicId === weakest.topicId || strongest.accuracy === weakest.accuracy) {
    return {
      strongest: null,
      weakest: null,
      comparableAreas: comparable.length,
      reason:
        "Your topics are performing about evenly right now — no clear strong or weak area to single out yet.",
    };
  }

  return { strongest, weakest, comparableAreas: comparable.length, reason: null };
}

/** Compute topic accuracy then apply the student-safe comparison gate. */
export function studentAreaHighlightsFromRows(
  rows: readonly AnalyticsResultRow[],
): AreaHighlights {
  return studentAreaHighlights(computeTopicPerformance(rows));
}
