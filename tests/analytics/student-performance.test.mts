/**
 * Student performance view rules tests — prompt 29 (pure layer).
 *
 * These cover the student-facing display rules built on top of the graded facts:
 * the overall summary, the trend direction (and its refusal to name one on a
 * thin history), the sample-confidence bands, and the strong/weakest-area
 * comparison that only fires with enough questions and a genuine spread. The
 * honesty rule is the headline again: a metric with no rows behind it is null
 * (never a fabricated zero), and a small sample is flagged rather than
 * overinterpreted or labelled a weakness (AGENTS.md §7). The Supabase data
 * layer (lib/data/student-analytics.ts) is NOT exercised here — there is no live
 * DB in `npm test`; its tenant + student-pinned reads reuse the same
 * `.eq("institution_id", …)` / `.eq("student_id", …)` posture the 0014 tables
 * and the result layer already enforce.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeStudentTrend,
  isLowSample,
  sampleConfidence,
  sampleConfidenceLabel,
  studentAreaHighlights,
  summarizeStudentPerformance,
  type SampleConfidence,
} from "../../lib/student-performance.ts";
import {
  type AnalyticsResultRow,
  type TopicPerformance,
} from "../../lib/analytics.ts";

/** Build a minimal result row; only the fields a given test varies. */
function row(
  overrides: Partial<AnalyticsResultRow> & { percentage: number },
): AnalyticsResultRow {
  return {
    studentId: overrides.studentId ?? "student-1",
    score: overrides.score ?? 0,
    maxScore: overrides.maxScore ?? 100,
    correctCount: overrides.correctCount ?? 0,
    totalQuestions: overrides.totalQuestions ?? 0,
    topics: overrides.topics ?? [],
    subjects: overrides.subjects ?? [],
    percentage: overrides.percentage,
    gradedAt: overrides.gradedAt,
    examId: overrides.examId,
    examTitle: overrides.examTitle,
  };
}

/** Build a dated row for the trend tests (stamps ascend with `index`). */
function datedRow(percentage: number, index: number): AnalyticsResultRow {
  return row({
    percentage,
    gradedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  });
}

function topic(
  topicName: string,
  correct: number,
  total: number,
): TopicPerformance {
  return {
    topicId: topicName.toLowerCase(),
    topicName,
    correct,
    total,
    accuracy: total > 0 ? Math.round((correct / total) * 10000) / 100 : null,
  };
}

describe("sampleConfidence — flags thin samples, never fakes a zero", () => {
  it("bands question counts into none / insufficient / low / adequate", () => {
    assert.equal(sampleConfidence(0), "none");
    assert.equal(sampleConfidence(-3), "none");
    assert.equal(sampleConfidence(Number.NaN), "none");
    assert.equal(sampleConfidence(1), "insufficient");
    assert.equal(sampleConfidence(2), "insufficient");
    assert.equal(sampleConfidence(3), "low");
    assert.equal(sampleConfidence(4), "low");
    assert.equal(sampleConfidence(5), "adequate");
    assert.equal(sampleConfidence(40), "adequate");
  });

  it("treats insufficient and low as low-sample for display caution", () => {
    assert.equal(isLowSample(0), false); // "none" is absent data, not a low sample
    assert.equal(isLowSample(2), true);
    assert.equal(isLowSample(4), true);
    assert.equal(isLowSample(5), false);
  });

  it("has a plain label for every band", () => {
    const bands: SampleConfidence[] = [
      "none",
      "insufficient",
      "low",
      "adequate",
    ];
    for (const band of bands) {
      assert.equal(typeof sampleConfidenceLabel(band), "string");
      assert.ok(sampleConfidenceLabel(band).length > 0);
    }
  });
});

describe("summarizeStudentPerformance — honest denominators", () => {
  it("returns nulls and a none band when nothing is released", () => {
    const summary = summarizeStudentPerformance([], 3);
    assert.equal(summary.releasedResults, 0);
    assert.equal(summary.pendingResults, 3);
    assert.equal(summary.totalQuestions, 0);
    assert.equal(summary.averagePercentage, null);
    assert.equal(summary.bestResult, null);
    assert.equal(summary.confidence, "none");
  });

  it("computes average, pass/fail, totals, and best result", () => {
    const rows = [
      row({ percentage: 90, totalQuestions: 20, examTitle: "Algebra I" }),
      row({ percentage: 60, totalQuestions: 30, examTitle: "Geometry" }),
      row({ percentage: 40, totalQuestions: 10, examTitle: "Trigonometry" }),
    ];
    const summary = summarizeStudentPerformance(rows, 1);
    assert.equal(summary.releasedResults, 3);
    assert.equal(summary.pendingResults, 1);
    assert.equal(summary.totalQuestions, 60);
    assert.equal(summary.averagePercentage, 63.33);
    assert.equal(summary.passed, 2); // 90 and 60 clear the 50 pass mark
    assert.equal(summary.failed, 1); // 40 is below
    assert.deepEqual(summary.bestResult, {
      examTitle: "Algebra I",
      percentage: 90,
    });
  });

  it("marks a one-result average as an insufficient sample", () => {
    const summary = summarizeStudentPerformance([row({ percentage: 80 })]);
    assert.equal(summary.releasedResults, 1);
    assert.equal(summary.confidence, "insufficient");
  });

  it("never reports a negative pending count", () => {
    const summary = summarizeStudentPerformance([row({ percentage: 50 })], -5);
    assert.equal(summary.pendingResults, 0);
  });
});

describe("computeStudentTrend — refuses to name a direction on a thin history", () => {
  it("returns a null direction with a kind note when there are <3 dated results", () => {
    const trend = computeStudentTrend([
      datedRow(60, 0),
      datedRow(70, 1),
    ]);
    assert.equal(trend.direction, null);
    assert.equal(trend.earlierAverage, null);
    assert.equal(trend.recentAverage, null);
    assert.ok(trend.note.length > 0);
  });

  it("calls a rising half-over-half movement improving", () => {
    const trend = computeStudentTrend([
      datedRow(40, 0),
      datedRow(50, 1),
      datedRow(60, 2),
      datedRow(70, 3),
    ]);
    assert.equal(trend.direction, "improving");
    assert.equal(trend.earlierAverage, 45);
    assert.equal(trend.recentAverage, 65);
  });

  it("calls a falling movement a dip to work on, not a verdict", () => {
    const trend = computeStudentTrend([
      datedRow(70, 0),
      datedRow(60, 1),
      datedRow(50, 2),
      datedRow(40, 3),
    ]);
    assert.equal(trend.direction, "needs_support");
  });

  it("calls a movement inside the tolerance steady", () => {
    const trend = computeStudentTrend([
      datedRow(60, 0),
      datedRow(61, 1),
      datedRow(60, 2),
      datedRow(62, 3),
    ]);
    assert.equal(trend.direction, "steady");
  });
});

describe("studentAreaHighlights — only compares with enough questions and spread", () => {
  it("withholds the contrast when no area has enough questions", () => {
    const highlights = studentAreaHighlights([
      topic("Fractions", 2, 2),
      topic("Decimals", 1, 2),
    ]);
    assert.equal(highlights.strongest, null);
    assert.equal(highlights.weakest, null);
    assert.equal(highlights.comparableAreas, 0);
    assert.ok(highlights.reason !== null);
  });

  it("picks the highest and lowest accuracy among well-sampled areas", () => {
    const highlights = studentAreaHighlights([
      topic("Algebra", 9, 10), // 90%
      topic("Geometry", 3, 10), // 30%
      topic("Stats", 6, 10), // 60%
    ]);
    assert.equal(highlights.strongest?.topicName, "Algebra");
    assert.equal(highlights.weakest?.topicName, "Geometry");
    assert.equal(highlights.comparableAreas, 3);
    assert.equal(highlights.reason, null);
  });

  it("refuses to label a strong/weakest pair when every area is tied", () => {
    const highlights = studentAreaHighlights([
      topic("Algebra", 6, 10),
      topic("Geometry", 6, 10),
    ]);
    assert.equal(highlights.strongest, null);
    assert.equal(highlights.weakest, null);
    assert.ok(highlights.reason !== null);
  });

  it("excludes thin areas so a 2-question 100% cannot be crowned a strength", () => {
    const highlights = studentAreaHighlights([
      topic("Tiny sample", 2, 2), // 100% but only 2 questions
      topic("Solid A", 9, 10),
      topic("Solid B", 4, 10),
    ]);
    assert.equal(highlights.strongest?.topicName, "Solid A");
    assert.equal(highlights.weakest?.topicName, "Solid B");
    assert.equal(highlights.comparableAreas, 2);
  });
});
