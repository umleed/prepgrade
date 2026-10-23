/**
 * Student performance analytics reads — SERVER-ONLY (prompt 29).
 *
 * Assembles ONE student's own released results into the fact rows the pure
 * student-performance layer (`lib/student-performance.ts`) turns into metrics.
 * It reads ONLY durable, server-graded facts and reuses the SAME release gate
 * the result views use, so a number never reaches a student's analytics before
 * its exam's release policy permits it (AGENTS.md §6). It adds no score of its
 * own and never reads another student's data.
 *
 * WHOSE DATA, WHICH DATA (AGENTS.md §5)
 * The read pins BOTH the trusted `institutionId` (from the session, never a
 * request body) AND the verified `studentId` — the same two-key posture as
 * `listStudentResults`, which this module builds on. Every downstream snapshot
 * and answer read re-filters by `institutionId`, so a foreign exam or attempt
 * matches nothing. A student sees only their own performance; institution-wide
 * or peer data never flows through here.
 *
 * ONE REPRESENTATIVE RESULT PER EXAM
 * An exam allows several attempts; a performance trend must not double-count a
 * test. Each exam contributes its latest graded released result (results arrive
 * newest-graded-first, so the first one seen per exam is the latest).
 *
 * TOPIC ACCURACY IS RECONSTRUCTED, SUBJECT ACCURACY IS FROZEN (AGENTS.md §7)
 * Subject figures come straight from the frozen `subject_breakdown` the grader
 * wrote. Topic accuracy has no frozen breakdown, so — exactly as the staff
 * analytics do — it is recounted from the recorded answers + the frozen
 * snapshot's answer key + each question's CURRENT topic tag. The answer key is
 * read ONLY to count correct vs. total; no correct option or key leaves this
 * layer (only counts do). A topic re-tag in the bank after the fact would shift
 * how historical answers group — the same known, surfaced limitation the teacher
 * view carries, never a hidden one.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import { listStudentResults } from "@/lib/data/results";
import {
  buildTopicStats,
  type SnapshotRawRow,
} from "@/lib/data/analytics";
import type {
  AnalyticsResultRow,
  AnalyticsSubjectStat,
} from "@/lib/analytics";

/** A released result the student can open, for the "view your results" links. */
export type StudentReleasedResultLink = {
  resultId: string;
  examTitle: string;
  subjectName: string;
  gradedAt: string | null;
  percentage: number;
};

/** The full bundle the student performance page consumes. */
export type StudentPerformanceBundle = {
  /** One row per released exam's representative result (metrics read these). */
  rows: AnalyticsResultRow[];
  /** Released results feeding the metrics. */
  releasedResults: number;
  /** Graded results the release policy has not shown the student yet. */
  pendingResults: number;
  /** The student's released results, newest graded first, for linking. */
  releasedLinks: StudentReleasedResultLink[];
};

// --- Raw row shapes (snake_case) ---------------------------------------------

type QuestionTopicRow = {
  id: string;
  topic_id: string | null;
  topics: { name: string } | null;
};

type SnapshotExamRow = SnapshotRawRow & { exam_id: string };

type AnswerRawRow = {
  attempt_id: string;
  snapshot_id: string;
  selected_option_index: number | null;
};

/**
 * Load one student's released performance, tenant + ownership pinned. Returns a
 * bundle even with zero released results (an empty `rows`) so the page renders
 * an honest empty state rather than an error. Throws on a genuine data-source
 * failure (including the unconfigured case) so the page shows a real error.
 */
export async function getStudentPerformance(
  institutionId: string,
  studentId: string,
): Promise<StudentPerformanceBundle> {
  // 1. The student's own results, release-gated by the shared result layer.
  const results = await listStudentResults(institutionId, studentId);
  const released = results.filter((result) => result.visibility === "released");
  const pendingResults = results.length - released.length;

  // 2. One representative (latest graded) released result per exam. `released`
  //    is newest-graded-first, so the first row seen for an exam is its latest.
  const byExam = new Map<string, (typeof released)[number]>();
  for (const result of released) {
    if (!byExam.has(result.examId)) byExam.set(result.examId, result);
  }
  const representative = [...byExam.values()];

  // 3. Reconstruct topic accuracy for the representative attempts only.
  const { snapshotsByExam, topicByQuestion, answersByAttempt } =
    await loadTopicFacts(institutionId, representative);

  const rows: AnalyticsResultRow[] = representative.map((result) => {
    const subjects: AnalyticsSubjectStat[] = result.subjectBreakdown.map(
      (subject) => ({
        subjectId: subject.subjectId,
        subjectName: subject.subjectName,
        score: subject.score,
        maxScore: subject.maxScore,
      }),
    );
    const topics = buildTopicStats(
      result.attemptId,
      snapshotsByExam.get(result.examId) ?? [],
      topicByQuestion,
      answersByAttempt,
    );
    return {
      studentId,
      studentName: undefined,
      examId: result.examId,
      examTitle: result.examTitle,
      percentage: result.percentage ?? 0,
      score: result.totalScore ?? 0,
      maxScore: result.maxScore ?? 0,
      correctCount: result.correctCount ?? 0,
      totalQuestions: result.totalQuestions ?? 0,
      gradedAt: result.gradedAt ?? undefined,
      topics,
      subjects,
    };
  });

  const releasedLinks: StudentReleasedResultLink[] = released.map((result) => ({
    resultId: result.resultId,
    examTitle: result.examTitle,
    subjectName: result.subjectName,
    gradedAt: result.gradedAt,
    percentage: result.percentage ?? 0,
  }));

  return {
    rows,
    releasedResults: rows.length,
    pendingResults,
    releasedLinks,
  };
}

/**
 * Read the frozen snapshots, current topic tags, and recorded answers the topic
 * recount needs for the representative attempts — every query re-filtered by
 * `institutionId`. An empty representative set short-circuits with empty maps
 * (no query round-trips), leaving topic accuracy honestly absent rather than
 * zero.
 */
async function loadTopicFacts(
  institutionId: string,
  representative: readonly { examId: string; attemptId: string }[],
): Promise<{
  snapshotsByExam: Map<string, SnapshotRawRow[]>;
  topicByQuestion: Map<string, { topicId: string; topicName: string }>;
  answersByAttempt: Map<string, Map<string, number | null>>;
}> {
  const snapshotsByExam = new Map<string, SnapshotRawRow[]>();
  const topicByQuestion = new Map<string, { topicId: string; topicName: string }>();
  const answersByAttempt = new Map<string, Map<string, number | null>>();

  if (representative.length === 0) {
    return { snapshotsByExam, topicByQuestion, answersByAttempt };
  }

  const supabase = createAdminClient();
  const examIds = [...new Set(representative.map((row) => row.examId))];
  const attemptIds = [...new Set(representative.map((row) => row.attemptId))];

  // a. Frozen snapshots for the student's exams (tenant-pinned), grouped by exam.
  const { data: snapshotData, error: snapshotError } = await supabase
    .from("exam_question_snapshots")
    .select("id, question_id, subject_id, correct_option_index, exam_id")
    .eq("institution_id", institutionId)
    .in("exam_id", examIds);
  if (snapshotError) throw snapshotError;

  const snapshots = (snapshotData ?? []) as unknown as SnapshotExamRow[];
  for (const snapshot of snapshots) {
    const list = snapshotsByExam.get(snapshot.exam_id) ?? [];
    list.push({
      id: snapshot.id,
      question_id: snapshot.question_id,
      subject_id: snapshot.subject_id,
      correct_option_index: snapshot.correct_option_index,
    });
    snapshotsByExam.set(snapshot.exam_id, list);
  }

  // b. Current topic tags for those questions (no topic => contributes nothing).
  const questionIds = [
    ...new Set(snapshots.map((snapshot) => snapshot.question_id).filter(Boolean)),
  ];
  if (questionIds.length > 0) {
    const { data: questionData, error: questionError } = await supabase
      .from("questions")
      .select("id, topic_id, topics(name)")
      .eq("institution_id", institutionId)
      .in("id", questionIds);
    if (questionError) throw questionError;
    for (const raw of (questionData ?? []) as unknown as QuestionTopicRow[]) {
      if (raw.topic_id && raw.topics?.name) {
        topicByQuestion.set(raw.id, { topicId: raw.topic_id, topicName: raw.topics.name });
      }
    }
  }

  // c. Recorded answers for the representative attempts only.
  const { data: answerData, error: answerError } = await supabase
    .from("exam_attempt_answers")
    .select("attempt_id, snapshot_id, selected_option_index")
    .eq("institution_id", institutionId)
    .in("attempt_id", attemptIds);
  if (answerError) throw answerError;
  for (const row of (answerData ?? []) as unknown as AnswerRawRow[]) {
    const inner =
      answersByAttempt.get(row.attempt_id) ?? new Map<string, number | null>();
    inner.set(row.snapshot_id, row.selected_option_index);
    answersByAttempt.set(row.attempt_id, inner);
  }

  return { snapshotsByExam, topicByQuestion, answersByAttempt };
}
