/**
 * Institution analytics tests — prompt 28 (pure contract layer).
 *
 * Covers the tenant-wide roll-ups the institution dashboard computes from the
 * same graded facts prompt 27 established: the monthly trend, the per-class
 * breakdown, the weakest-topic attention list, and the topic → student
 * drill-down. The honesty rule leads every group: a missing sample yields
 * `null` (rendered "—"), never a fabricated zero, and buckets exist only for
 * months/classes/topics that actually carry data (AGENTS.md §7). The Supabase
 * data layer (lib/data/institution-analytics.ts) is NOT exercised here — there
 * is no live DB in `npm test`; its tenant scoping is the `.eq("institution_id", …)`
 * filters over the 0014 tables.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMonthlyTrend,
  computeClassBreakdown,
  computeStudentTopicPerformance,
  computeTopicPerformance,
  topicAttentionList,
  type AnalyticsResultRow,
} from "../../lib/analytics.ts";

/** Build a minimal result row; only the fields a given test cares about vary. */
function row(overrides: Partial<AnalyticsResultRow> & { percentage: number }): AnalyticsResultRow {
  return {
    studentId: overrides.studentId ?? `student-${overrides.percentage}`,
    studentName: overrides.studentName,
    score: overrides.score ?? 0,
    maxScore: overrides.maxScore ?? 100,
    correctCount: overrides.correctCount ?? 0,
    totalQuestions: overrides.totalQuestions ?? 0,
    topics: overrides.topics ?? [],
    subjects: overrides.subjects ?? [],
    percentage: overrides.percentage,
    gradedAt: overrides.gradedAt,
    classId: overrides.classId,
  };
}

describe("buildMonthlyTrend — months exist only where results do", () => {
  it("returns an empty series when no row carries a grading stamp", () => {
    assert.deepEqual(buildMonthlyTrend([row({ percentage: 70 })]), []);
  });

  it("skips undated and malformed stamps instead of inventing a bucket", () => {
    const rows = [
      row({ percentage: 60, gradedAt: "2026-03-05T10:00:00Z" }),
      row({ percentage: 80 }), // no gradedAt
      row({ percentage: 90, gradedAt: "not-a-date" }), // unparseable
    ];
    const trend = buildMonthlyTrend(rows);
    assert.equal(trend.length, 1);
    assert.equal(trend[0].month, "2026-03");
  });

  it("orders months ascending and reports graded, students, and average", () => {
    const rows = [
      row({ studentId: "a", percentage: 50, gradedAt: "2026-02-01T00:00:00Z" }),
      row({ studentId: "b", percentage: 70, gradedAt: "2026-04-15T00:00:00Z" }),
      row({ studentId: "b", percentage: 90, gradedAt: "2026-04-20T00:00:00Z" }),
    ];
    const trend = buildMonthlyTrend(rows);
    assert.deepEqual(
      trend.map((point) => point.month),
      ["2026-02", "2026-04"],
    );
    assert.deepEqual(trend[0], { month: "2026-02", graded: 1, students: 1, average: 50 });
    assert.deepEqual(trend[1], { month: "2026-04", graded: 2, students: 1, average: 80 });
  });
});

describe("computeClassBreakdown — every listed class gets an honest row", () => {
  const classes = [
    { id: "c1", name: "JSS 3A", studentCount: 10 },
    { id: "c2", name: "SSS 1B", studentCount: 5 },
  ];

  it("keeps an ungraded class visible with null averages, not a zero", () => {
    const rows = [
      row({ studentId: "a", percentage: 80, classId: "c1" }),
      row({ studentId: "b", percentage: 40, classId: "c1" }),
    ];
    const breakdown = computeClassBreakdown(classes, rows);
    assert.equal(breakdown.length, 2);

    const jss = breakdown.find((entry) => entry.classId === "c1")!;
    assert.equal(jss.summary.graded, 2);
    assert.equal(jss.summary.average, 60);
    assert.equal(jss.studentsGraded, 2);
    assert.equal(jss.summary.notSubmitted, 8); // roster 10 minus 2 graded

    const sss = breakdown.find((entry) => entry.classId === "c2")!;
    assert.equal(sss.summary.graded, 0);
    assert.equal(sss.summary.average, null);
    assert.equal(sss.summary.passed, 0);
    assert.equal(sss.studentsGraded, 0);
  });

  it("rolls classless and unknown-class results into a single Unassigned bucket", () => {
    const rows = [
      row({ studentId: "a", percentage: 70, classId: null }),
      row({ studentId: "b", percentage: 55, classId: "gone" }),
      row({ studentId: "c", percentage: 60 }),
    ];
    const breakdown = computeClassBreakdown(classes, rows);
    const unassigned = breakdown.find((entry) => entry.classId === "")!;
    assert.ok(unassigned, "expected an Unassigned bucket");
    assert.equal(unassigned.className, "Unassigned");
    assert.equal(unassigned.summary.graded, 3);
    assert.equal(unassigned.summary.average, roundTo2((70 + 55 + 60) / 3));
    // No listed class had results, so each keeps a null-average row.
    assert.equal(breakdown.find((entry) => entry.classId === "c1")!.summary.graded, 0);
  });

  it("emits no Unassigned bucket when every row matches a listed class", () => {
    const breakdown = computeClassBreakdown(
      classes,
      [row({ studentId: "a", percentage: 70, classId: "c1" })],
    );
    assert.equal(breakdown.length, 2);
    assert.equal(breakdown.some((entry) => entry.classId === ""), false);
  });
});

describe("topicAttentionList — weakest first, only where data supports it", () => {
  const rows = [
    row({
      studentId: "a",
      percentage: 50,
      topics: [
        { topicId: "t1", topicName: "Algebra", correct: 2, total: 10 },
        { topicId: "t2", topicName: "Trigonometry", correct: 8, total: 10 },
        { topicId: "t3", topicName: "Geometry", correct: 5, total: 10 },
        { topicId: "t4", topicName: "Probability", correct: 1, total: 10 },
      ],
    }),
  ];
  const topics = computeTopicPerformance(rows);

  it("sorts by measured accuracy ascending, weakest first", () => {
    const attention = topicAttentionList(topics, 3);
    assert.deepEqual(
      attention.map((topic) => topic.topicName),
      ["Probability", "Algebra", "Geometry"],
    );
  });

  it("returns an empty list when no topic carries answered questions", () => {
    assert.deepEqual(topicAttentionList([], 5), []);
    const zeroTotals = computeTopicPerformance([
      row({ studentId: "a", percentage: 0, topics: [{ topicId: "t", topicName: "T", correct: 0, total: 0 }] }),
    ]);
    assert.deepEqual(topicAttentionList(zeroTotals, 5), []);
  });

  it("breaks accuracy ties by name so the ranking is deterministic", () => {
    const tied = computeTopicPerformance([
      row({
        studentId: "a",
        percentage: 50,
        topics: [
          { topicId: "z", topicName: "Zebra", correct: 3, total: 10 },
          { topicId: "a", topicName: "Apple", correct: 3, total: 10 },
        ],
      }),
    ]);
    assert.deepEqual(
      topicAttentionList(tied, 2).map((topic) => topic.topicName),
      ["Apple", "Zebra"],
    );
  });
});

describe("computeStudentTopicPerformance — the topic → student rung", () => {
  it("sums a student's answers on one topic across exams and sorts best first", () => {
    const rows = [
      row({
        studentId: "a",
        studentName: "Ada",
        percentage: 60,
        topics: [{ topicId: "t1", topicName: "Algebra", correct: 3, total: 6 }],
      }),
      row({
        studentId: "a",
        studentName: "Ada",
        percentage: 70,
        topics: [{ topicId: "t1", topicName: "Algebra", correct: 3, total: 4 }],
      }),
      row({
        studentId: "b",
        studentName: "Ben",
        percentage: 40,
        topics: [
          { topicId: "t1", topicName: "Algebra", correct: 1, total: 10 },
          { topicId: "t2", topicName: "Other", correct: 9, total: 10 },
        ],
      }),
    ];
    const students = computeStudentTopicPerformance(rows, "t1");
    assert.equal(students.length, 2, "only rows touching t1 count");
    const ada = students.find((entry) => entry.studentId === "a")!;
    assert.equal(ada.correct, 6);
    assert.equal(ada.total, 10);
    assert.equal(ada.accuracy, 60);
    // Ada (60%) sorts above Ben (10%).
    assert.deepEqual(
      students.map((entry) => entry.studentId),
      ["a", "b"],
    );
  });

  it("returns nothing for a topic no graded row covered", () => {
    assert.deepEqual(computeStudentTopicPerformance([row({ percentage: 50 })], "t1"), []);
  });
});

/** Round to whole hundredths the same way the pure layer does. */
function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
