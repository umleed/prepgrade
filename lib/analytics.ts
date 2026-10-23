/**
 * Class / subject / topic analytics — pure, dependency-free, unit-testable.
 *
 * WHAT THIS AREA IS FOR (prompt 27)
 * Turns a set of already-graded result rows (the derived facts prompt 24
 * stored) into the descriptive metrics a teacher reads to understand a class:
 * the average, the highest/lowest, completion counts, the score and grade
 * distributions, per-subject performance, and per-topic accuracy. Every number
 * here is DESCRIPTIVE — a recount of what already happened. Nothing predicts a
 * student's future or labels anyone "at risk": the prompt forbids an
 * un-validated risk definition, so the strongest/weakest-topic callouts below
 * are literal rankings of measured accuracy, never a diagnosis.
 *
 * MISSING DATA IS NOT ZERO (the honesty rule, AGENTS.md §7)
 * A metric with no rows behind it is `null`, never a fabricated `0`. A class
 * that has not been graded yet has NO average — not an average of zero — and
 * the view renders "—" so a teacher cannot misread an empty sample as a failed
 * cohort. The sample size (`graded`) travels with every summary so a 72%
 * computed from 3 students reads differently from one computed from 300.
 *
 * ONE SOURCE FOR THE DISPLAY RULES
 * The pass mark, the score buckets, and the letter-grade bands are defined
 * here once so the summary cards, the charts, the tables, and any test agree.
 * The pass mark is a plain reporting threshold (default 50%), NOT a
 * institution policy — it is surfaced as "Pass ≥ 50%" so nobody mistakes it
 * for an official cut-off.
 *
 * PROMPT 28 ADDITIONS (institution roll-ups)
 * The institution dashboard reads the SAME graded facts across many exams, so
 * the row shape grew optional fields (`gradedAt`, `classId`/`className`,
 * `examId`/`examTitle`) and this module gained the month trend, the per-class
 * breakdown, the weakest-topic attention list, and the per-student topic
 * drill-down. Every rule above still holds: descriptive recounts only,
 * `null` for a missing sample, sample sizes carried with each metric.
 */

// --- Input shape (the graded facts a metric is computed from) ----------------

/**
 * One graded attempt reduced to exactly what the analytics need. The data
 * layer (lib/data/analytics.ts) has already read these from `exam_results` and
 * resolved the topic/subject names; this module never touches the database and
 * never re-derives a score (AGENTS.md §6).
 */
export type AnalyticsResultRow = {
  /** The student this result belongs to (for the roster + drill-down). */
  studentId: string;
  /**
   * The student's display name. Purely for the roster table — no metric here
   * reads it, so the aggregation stays name-agnostic.
   */
  studentName?: string;
  /** Whole-hundredths percentage earned (0–100). */
  percentage: number;
  /** Marks earned / available — kept so a score column can render "46 / 50". */
  score: number;
  maxScore: number;
  /** Correct / total question counts, for the accuracy read-outs. */
  correctCount: number;
  totalQuestions: number;
  /** Per-topic accuracy rows, resolved to names by the data layer. */
  topics: AnalyticsTopicStat[];
  /** Per-subject accuracy rows, resolved to names by the data layer. */
  subjects: AnalyticsSubjectStat[];
  /**
   * When this (representative) result was graded — ISO string. Only the
   * institution trend read (prompt 28) uses it; a missing stamp simply drops
   * out of the monthly buckets rather than landing in a fake "unknown" month.
   */
  gradedAt?: string;
  /** The student's current class, when the data layer resolved one. */
  classId?: string | null;
  className?: string;
  /** The exam this result came from — the institution view spans many exams. */
  examId?: string;
  examTitle?: string;
};

/** One topic's contribution to a single result (marks, not guesses). */
export type AnalyticsTopicStat = {
  topicId: string;
  topicName: string;
  correct: number;
  total: number;
};

/** One subject's contribution to a single result. */
export type AnalyticsSubjectStat = {
  subjectId: string;
  subjectName: string;
  score: number;
  maxScore: number;
};

// --- Pass mark & grade bands -------------------------------------------------

/** Default reporting pass threshold (percent). A display convention, not policy. */
export const DEFAULT_PASS_MARK = 50;

/** A letter grade band: inclusive lower percentage bound and its label. */
export type GradeBand = { grade: string; min: number };

/**
 * The standard Nigerian/WAEC-style letter bands, ordered high → low. A
 * percentage maps to the first band whose `min` it reaches. These are reporting
 * labels for the grade-distribution chart, never an official certification.
 */
export const GRADE_BANDS: readonly GradeBand[] = [
  { grade: "A", min: 75 },
  { grade: "B", min: 65 },
  { grade: "C", min: 55 },
  { grade: "D", min: 45 },
  { grade: "E", min: 40 },
  { grade: "F", min: 0 },
];

/** The letter grade for a percentage (first band whose floor it clears). */
export function gradeForPercentage(percentage: number): string {
  if (!Number.isFinite(percentage)) return "—";
  for (const band of GRADE_BANDS) {
    if (percentage >= band.min) return band.grade;
  }
  return GRADE_BANDS[GRADE_BANDS.length - 1].grade;
}

// --- Score distribution (10-bucket histogram) --------------------------------

/** One histogram bucket: a display label and how many results fall in it. */
export type ScoreBucket = {
  label: string;
  min: number;
  max: number;
  count: number;
};

/**
 * Ten 0–100 buckets (0–9, 10–19, …, 90–100). A percentage is assigned to the
 * bucket whose inclusive [min, max] range contains it; 100 lands in the last
 * bucket, and an out-of-range value is clamped so a stray number never drops
 * out of the histogram silently.
 */
export function buildScoreDistribution(
  rows: readonly AnalyticsResultRow[],
): ScoreBucket[] {
  const buckets: ScoreBucket[] = [];
  for (let i = 0; i < 10; i++) {
    const min = i * 10;
    const max = i === 9 ? 100 : i * 10 + 9;
    buckets.push({ label: `${min}–${max}`, min, max, count: 0 });
  }
  for (const row of rows) {
    const pct = Math.max(0, Math.min(100, row.percentage));
    const index = pct >= 100 ? 9 : Math.floor(pct / 10);
    buckets[index].count += 1;
  }
  return buckets;
}

// --- Grade distribution ------------------------------------------------------

/** One letter grade and how many results earned it, in band order. */
export type GradeCount = { grade: string; count: number };

/** Count results per letter grade, returned in GRADE_BANDS order. */
export function buildGradeDistribution(
  rows: readonly AnalyticsResultRow[],
): GradeCount[] {
  const counts = new Map<string, number>();
  for (const band of GRADE_BANDS) counts.set(band.grade, 0);
  for (const row of rows) {
    const grade = gradeForPercentage(row.percentage);
    counts.set(grade, (counts.get(grade) ?? 0) + 1);
  }
  return GRADE_BANDS.map((band) => ({
    grade: band.grade,
    count: counts.get(band.grade) ?? 0,
  }));
}

// --- Aggregate summary -------------------------------------------------------

/** The headline class metrics, every field honest about a missing sample. */
export type ClassSummary = {
  /** Results that carry a grade — the denominator for every average below. */
  graded: number;
  /** Class mean percentage, or null when nothing is graded yet. */
  average: number | null;
  highest: number | null;
  lowest: number | null;
  /** Count at/above the pass mark, and the fail count, out of `graded`. */
  passed: number;
  failed: number;
  /** Total students in the class roster (may exceed `graded`). */
  rosterSize: number;
  /** Students with no graded result yet (roster − graded, floored at 0). */
  notSubmitted: number;
};

/** Round to whole hundredths without floating-point drift. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Compute the class summary. `rosterSize` is the class's live student count so
 * the "not submitted" figure is honest about the sample that never sat (or was
 * never graded) rather than treating the graded set as the whole class. An
 * empty graded set yields nulls, never a misleading 0 average.
 */
export function computeClassSummary(
  rows: readonly AnalyticsResultRow[],
  rosterSize: number,
  passMark: number = DEFAULT_PASS_MARK,
): ClassSummary {
  const graded = rows.length;
  if (graded === 0) {
    return {
      graded: 0,
      average: null,
      highest: null,
      lowest: null,
      passed: 0,
      failed: 0,
      rosterSize,
      notSubmitted: Math.max(0, rosterSize),
    };
  }

  let sum = 0;
  let highest = -Infinity;
  let lowest = Infinity;
  let passed = 0;
  for (const row of rows) {
    sum += row.percentage;
    if (row.percentage > highest) highest = row.percentage;
    if (row.percentage < lowest) lowest = row.percentage;
    if (row.percentage >= passMark) passed += 1;
  }

  return {
    graded,
    average: round2(sum / graded),
    highest: round2(highest),
    lowest: round2(lowest),
    passed,
    failed: graded - passed,
    rosterSize,
    notSubmitted: Math.max(0, rosterSize - graded),
  };
}

// --- Topic & subject roll-ups ------------------------------------------------

/** One topic's class-level accuracy, aggregated across every graded result. */
export type TopicPerformance = {
  topicId: string;
  topicName: string;
  /** Total correct answers for this topic across the class. */
  correct: number;
  /** Total questions on this topic across the class. */
  total: number;
  /** Accuracy percent (correct/total), null when no data. */
  accuracy: number | null;
};

/**
 * Roll per-result topic stats up to class topic accuracy. A topic with zero
 * attempted questions drops out (it has no measured accuracy) rather than
 * showing a fake 0%. Sorted by name for a stable table.
 */
export function computeTopicPerformance(
  rows: readonly AnalyticsResultRow[],
): TopicPerformance[] {
  const map = new Map<string, TopicPerformance>();
  for (const row of rows) {
    for (const topic of row.topics) {
      if (!topic.topicId || topic.total <= 0) continue;
      const entry =
        map.get(topic.topicId) ??
        {
          topicId: topic.topicId,
          topicName: topic.topicName || "—",
          correct: 0,
          total: 0,
          accuracy: null,
        };
      entry.correct += topic.correct;
      entry.total += topic.total;
      map.set(topic.topicId, entry);
    }
  }
  const result = [...map.values()];
  for (const entry of result) {
    entry.accuracy = entry.total > 0 ? round2((entry.correct / entry.total) * 100) : null;
  }
  return result.sort((a, b) => a.topicName.localeCompare(b.topicName));
}

/** One subject's class-level score share. */
export type SubjectPerformance = {
  subjectId: string;
  subjectName: string;
  score: number;
  maxScore: number;
  /** Percent of marks available that the class earned in this subject. */
  percentage: number | null;
};

/** Roll per-result subject stats up to class subject performance. */
export function computeSubjectPerformance(
  rows: readonly AnalyticsResultRow[],
): SubjectPerformance[] {
  const map = new Map<string, SubjectPerformance>();
  for (const row of rows) {
    for (const subject of row.subjects) {
      if (!subject.subjectId || subject.maxScore <= 0) continue;
      const entry =
        map.get(subject.subjectId) ??
        {
          subjectId: subject.subjectId,
          subjectName: subject.subjectName || "—",
          score: 0,
          maxScore: 0,
          percentage: null,
        };
      entry.score += subject.score;
      entry.maxScore += subject.maxScore;
      map.set(subject.subjectId, entry);
    }
  }
  const result = [...map.values()];
  for (const entry of result) {
    entry.percentage =
      entry.maxScore > 0 ? round2((entry.score / entry.maxScore) * 100) : null;
  }
  return result.sort((a, b) => a.subjectName.localeCompare(b.subjectName));
}

/**
 * The strongest and weakest topics by measured accuracy, from an already
 * aggregated topic list. Returns nulls when fewer than one topic carries data
 * — a single topic is not a meaningful "strongest vs weakest" contrast, so the
 * view only shows the callout when there is a genuine spread. Ties break by
 * name so the pick is deterministic.
 */
export function topicHighlights(topics: readonly TopicPerformance[]): {
  strongest: TopicPerformance | null;
  weakest: TopicPerformance | null;
} {
  const scored = topics.filter(
    (topic) => topic.accuracy !== null && topic.total > 0,
  );
  if (scored.length < 2) return { strongest: null, weakest: null };
  let strongest = scored[0];
  let weakest = scored[0];
  for (const topic of scored) {
    if (topic.accuracy! > strongest.accuracy!) strongest = topic;
    else if (
      topic.accuracy! === strongest.accuracy! &&
      topic.topicName.localeCompare(strongest.topicName) < 0
    ) {
      strongest = topic;
    }
    if (topic.accuracy! < weakest.accuracy!) weakest = topic;
    else if (
      topic.accuracy! === weakest.accuracy! &&
      topic.topicName.localeCompare(weakest.topicName) < 0
    ) {
      weakest = topic;
    }
  }
  return { strongest, weakest };
}

// --- Institution roll-ups (prompt 28) ----------------------------------------

/**
 * One month of the institution trend. A bucket only exists when at least one
 * graded result carries a `gradedAt` inside it — an ungraded month is absent
 * from the series, never rendered as a fabricated zero dip.
 */
export type MonthlyTrendPoint = {
  /** UTC calendar month key, `YYYY-MM`. */
  month: string;
  /** Graded results stamped in the month (attempts, the honest sample). */
  graded: number;
  /** Distinct students behind those results. */
  students: number;
  /** Mean percentage of the month's results — a bucket always has rows. */
  average: number;
};

/**
 * Recount graded results per UTC month, oldest → newest. Like every metric
 * here this is a recount of stored facts; nothing is interpolated between the
 * months that exist.
 */
export function buildMonthlyTrend(
  rows: readonly AnalyticsResultRow[],
): MonthlyTrendPoint[] {
  type Bucket = { sum: number; graded: number; students: Set<string> };
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    if (!row.gradedAt) continue;
    const stamp = new Date(row.gradedAt);
    if (Number.isNaN(stamp.getTime())) continue;
    const month = stamp.toISOString().slice(0, 7);
    const bucket =
      buckets.get(month) ?? { sum: 0, graded: 0, students: new Set<string>() };
    bucket.sum += row.percentage;
    bucket.graded += 1;
    bucket.students.add(row.studentId);
    buckets.set(month, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, bucket]) => ({
      month,
      graded: bucket.graded,
      students: bucket.students.size,
      average: round2(bucket.sum / bucket.graded),
    }));
}

/** One class's slice of the institution view, summary and all. */
export type ClassBreakdownRow = {
  /** "" for the honest "Unassigned" bucket (students with no current class). */
  classId: string;
  className: string;
  rosterSize: number;
  /** Distinct students with at least one graded result in the scope. */
  studentsGraded: number;
  /** The same honest class summary the per-exam view computes. */
  summary: ClassSummary;
};

/**
 * Break graded rows down per class. Every class in `classes` gets a row —
 * including one with nothing graded yet, whose average is null ("—"), so an
 * untouched class never disappears from the institution picture and never
 * reads as a zero. Rows whose class id matches no listed class (e.g. an
 * archived or removed class, or no class at all) roll up into a single
 * "Unassigned" bucket that is only shown when it actually has results.
 */
export function computeClassBreakdown(
  classes: readonly { id: string; name: string; studentCount: number }[],
  rows: readonly AnalyticsResultRow[],
  passMark: number = DEFAULT_PASS_MARK,
): ClassBreakdownRow[] {
  const byClass = new Map<string, AnalyticsResultRow[]>();
  for (const row of rows) {
    const key = row.classId ?? "";
    const list = byClass.get(key) ?? [];
    list.push(row);
    byClass.set(key, list);
  }

  const breakdown: ClassBreakdownRow[] = classes.map((cls) => {
    const classRows = byClass.get(cls.id) ?? [];
    byClass.delete(cls.id);
    return {
      classId: cls.id,
      className: cls.name,
      rosterSize: cls.studentCount,
      studentsGraded: new Set(classRows.map((row) => row.studentId)).size,
      summary: computeClassSummary(classRows, cls.studentCount, passMark),
    };
  });

  const leftover = [...byClass.values()].flat();
  if (leftover.length > 0) {
    breakdown.push({
      classId: "",
      className: "Unassigned",
      rosterSize: 0,
      studentsGraded: new Set(leftover.map((row) => row.studentId)).size,
      summary: computeClassSummary(leftover, 0, passMark),
    });
  }
  return breakdown;
}

/**
 * The topics with the LOWEST measured accuracy — the institution's "needs
 * revision" ranking. This is a literal sort of counted correct/total answers,
 * not a diagnosis: a topic with no answered questions carries no accuracy and
 * is excluded rather than assumed weak. Ties break by name so the list is
 * deterministic, and the caller labels the sample size beside every entry.
 */
export function topicAttentionList(
  topics: readonly TopicPerformance[],
  limit = 5,
): TopicPerformance[] {
  return topics
    .filter((topic) => topic.accuracy !== null && topic.total > 0)
    .sort(
      (a, b) =>
        a.accuracy! - b.accuracy! || a.topicName.localeCompare(b.topicName),
    )
    .slice(0, Math.max(1, limit));
}

/** One student's measured accuracy on a single topic, across the scoped rows. */
export type StudentTopicPerformance = {
  studentId: string;
  studentName: string;
  correct: number;
  total: number;
  accuracy: number | null;
};

/**
 * The topic → student drill-down rung (prompt 28): across the scoped rows,
 * sum each student's correct/total answers on ONE topic — spanning every exam
 * in scope, so the figure answers "how is this student on this topic", not
 * "how did they do on one test". Sorted high → low, ties by name.
 */
export function computeStudentTopicPerformance(
  rows: readonly AnalyticsResultRow[],
  topicId: string,
): StudentTopicPerformance[] {
  const map = new Map<string, StudentTopicPerformance>();
  for (const row of rows) {
    for (const topic of row.topics) {
      if (topic.topicId !== topicId || topic.total <= 0) continue;
      const entry =
        map.get(row.studentId) ??
        {
          studentId: row.studentId,
          studentName: row.studentName ?? "—",
          correct: 0,
          total: 0,
          accuracy: null,
        };
      entry.correct += topic.correct;
      entry.total += topic.total;
      map.set(row.studentId, entry);
    }
  }
  const result = [...map.values()];
  for (const entry of result) {
    entry.accuracy = round2((entry.correct / entry.total) * 100);
  }
  return result.sort(
    (a, b) =>
      b.accuracy! - a.accuracy! || a.studentName.localeCompare(b.studentName),
  );
}

// --- Formatting helpers (shared with the view) -------------------------------

/** A percentage with a trailing %, or "—" for a missing sample. */
export function formatMetricPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(2)}%`;
}

/** A share of a total as a whole-percent string, guarding a zero denominator. */
export function formatShare(count: number, total: number): string {
  if (total <= 0) return "—";
  return `${Math.round((count / total) * 100)}%`;
}
