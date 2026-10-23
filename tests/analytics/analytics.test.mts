/**
 * Class / subject / topic analytics tests — prompt 27 (pure contract layer).
 *
 * These cover the descriptive rules the analytics screen computes from the
 * grading engine's stored facts (AGENTS.md §6): the class summary (average,
 * highest/lowest, completion), the score and grade distributions, the topic and
 * subject roll-ups, and the strongest/weakest-topic highlights. The honesty
 * rule is the headline: a metric with no rows behind it is `null`, never a
 * fabricated zero, so an untested class never reads as a failed one (AGENTS.md
 * §7). The Supabase data layer (lib/data/analytics.ts) is NOT exercised here —
 * there is no live DB in `npm test`; its tenant + ownership filters are enforced
 * by the `.eq("institution_id", …)` query filters over the 0014 tables.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildGradeDistribution,
  buildScoreDistribution,
  computeClassSummary,
  computeSubjectPerformance,
  computeTopicPerformance,
  formatMetricPercent,
  formatShare,
  gradeForPercentage,
  topicHighlights,
  type AnalyticsResultRow,
} from "../../lib/analytics.ts";

/** Build a minimal result row; only the fields a given test cares about vary. */
function row(overrides: Partial<AnalyticsResultRow> & { percentage: number }): AnalyticsResultRow {
  return {
    studentId: overrides.studentId ?? `student-${overrides.percentage}`,
    score: overrides.score ?? 0,
    maxScore: overrides.maxScore ?? 100,
    correctCount: overrides.correctCount ?? 0,
    totalQuestions: overrides.totalQuestions ?? 0,
    topics: overrides.topics ?? [],
    subjects: overrides.subjects ?? [],
    percentage: overrides.percentage,
  };
}

describe("computeClassSummary — honest about a missing sample", () => {
  it("returns nulls (not zero) and full not-submitted when nothing is graded", () => {
    const summary = computeClassSummary([], 30);
    assert.equal(summary.graded, 0);
    assert.equal(summary.average, null);
    assert.equal(summary.highest, null);
    assert.equal(summary.lowest, null);
    assert.equal(summary.notSubmitted, 30);
    assert.equal(summary.passed, 0);
    assert.equal(summary.failed, 0);
  });

  it("computes average, extremes, and pass/fail against the default pass mark", () => {
    const rows = [row({ percentage: 90 }), row({ percentage: 60 }), row({ percentage: 40 })];
    const summary = computeClassSummary(rows, 5);
    assert.equal(summary.graded, 3);
    assert.equal(summary.average, 63.33);
    assert.equal(summary.highest, 90);
    assert.equal(summary.lowest, 40);
    assert.equal(summary.passed, 2); // 90 and 60 are >= 50
    assert.equal(summary.failed, 1); // 40 is below
    assert.equal(summary.notSubmitted, 2); // roster 5 minus 3 graded
  });

  it("treats a score exactly at the pass mark as passed", () => {
    const summary = computeClassSummary([row({ percentage: 50 })], 1, 50);
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 0);
  });

  it("honours a custom pass mark", () => {
    const rows = [row({ percentage: 64 }), row({ percentage: 55 })];
    const summary = computeClassSummary(rows, 2, 60);
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 1);
  });
});

describe("buildScoreDistribution — ten inclusive bands", () => {
  it("produces ten buckets summing to the graded count", () => {
    const buckets = buildScoreDistribution([
      row({ percentage: 0 }),
      row({ percentage: 9 }),
      row({ percentage: 10 }),
      row({ percentage: 95 }),
      row({ percentage: 100 }),
    ]);
    assert.equal(buckets.length, 10);
    const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    assert.equal(total, 5);
    assert.equal(buckets[0].count, 2); // 0 and 9
    assert.equal(buckets[1].count, 1); // 10
    assert.equal(buckets[9].count, 2); // 95 and 100 land in the last band
  });
});

describe("gradeForPercentage / buildGradeDistribution", () => {
  it("maps a percentage to the first band its floor clears", () => {
    assert.equal(gradeForPercentage(80), "A");
    assert.equal(gradeForPercentage(75), "A");
    assert.equal(gradeForPercentage(74), "B");
    assert.equal(gradeForPercentage(0), "F");
    assert.equal(gradeForPercentage(Number.NaN), "—");
  });

  it("counts grades in band order", () => {
    const grades = buildGradeDistribution([
      row({ percentage: 90 }),
      row({ percentage: 80 }),
      row({ percentage: 10 }),
    ]);
    const a = grades.find((band) => band.grade === "A");
    const f = grades.find((band) => band.grade === "F");
    assert.equal(a?.count, 2);
    assert.equal(f?.count, 1);
  });
});

describe("computeTopicPerformance — aggregates measured accuracy", () => {
  it("sums correct/total across students into a per-topic accuracy", () => {
    const rows = [
      row({
        percentage: 70,
        topics: [
          { topicId: "t1", topicName: "Algebra", correct: 4, total: 5 },
          { topicId: "t2", topicName: "Geometry", correct: 3, total: 5 },
        ],
      }),
      row({
        percentage: 50,
        topics: [
          { topicId: "t1", topicName: "Algebra", correct: 2, total: 5 },
          { topicId: "t2", topicName: "Geometry", correct: 1, total: 5 },
        ],
      }),
    ];
    const topics = computeTopicPerformance(rows);
    const algebra = topics.find((topic) => topic.topicId === "t1");
    assert.equal(algebra?.correct, 6);
    assert.equal(algebra?.total, 10);
    assert.equal(algebra?.accuracy, 60);
  });

  it("drops a topic with no attempted questions rather than faking 0%", () => {
    const rows = [
      row({ percentage: 50, topics: [{ topicId: "t1", topicName: "Empty", correct: 0, total: 0 }] }),
    ];
    assert.equal(computeTopicPerformance(rows).length, 0);
  });
});

describe("computeSubjectPerformance — score share per subject", () => {
  it("rolls subject score/max up to a class percentage", () => {
    const rows = [
      row({ percentage: 60, subjects: [{ subjectId: "s1", subjectName: "Maths", score: 30, maxScore: 50 }] }),
      row({ percentage: 60, subjects: [{ subjectId: "s1", subjectName: "Maths", score: 30, maxScore: 50 }] }),
    ];
    const subjects = computeSubjectPerformance(rows);
    assert.equal(subjects.length, 1);
    assert.equal(subjects[0].score, 60);
    assert.equal(subjects[0].maxScore, 100);
    assert.equal(subjects[0].percentage, 60);
  });
});

describe("topicHighlights — only when a genuine spread exists", () => {
  it("returns nulls when fewer than two scored topics exist", () => {
    const single = [{ topicId: "t1", topicName: "Only", correct: 5, total: 5, accuracy: 100 }];
    assert.deepEqual(topicHighlights(single), { strongest: null, weakest: null });
  });

  it("picks the highest and lowest measured accuracy", () => {
    const topics = [
      { topicId: "t1", topicName: "Strong", correct: 9, total: 10, accuracy: 90 },
      { topicId: "t2", topicName: "Weak", correct: 2, total: 10, accuracy: 20 },
      { topicId: "t3", topicName: "Mid", correct: 5, total: 10, accuracy: 50 },
    ];
    const { strongest, weakest } = topicHighlights(topics);
    assert.equal(strongest?.topicId, "t1");
    assert.equal(weakest?.topicId, "t2");
  });
});

describe("formatting helpers", () => {
  it("renders a missing metric as an em dash, never a zero", () => {
    assert.equal(formatMetricPercent(null), "—");
    assert.equal(formatMetricPercent(66.67), "66.67%");
    assert.equal(formatMetricPercent(72), "72%");
  });

  it("guards a zero denominator in a share", () => {
    assert.equal(formatShare(0, 0), "—");
    assert.equal(formatShare(3, 4), "75%");
  });
});
