/**
 * Class / subject / topic analytics reads — SERVER-ONLY (prompt 27).
 *
 * Assembles the raw facts the pure analytics layer (`lib/analytics.ts`) turns
 * into class metrics. It reads ONLY durable, server-computed facts — the
 * `exam_results` rows (prompt 24), the frozen `exam_question_snapshots`, and the
 * recorded `exam_attempt_answers` — and never recomputes a score, accepts a
 * client-supplied number, or exposes an answer key (AGENTS.md §6). The answer
 * key is read ONLY to recount how many answers were correct; the returned rows
 * carry counts, never a correct option or the key itself.
 *
 * WHERE EACH DIMENSION COMES FROM (honesty about the data, AGENTS.md §7)
 *   * The class summary, score/grade distributions, and pass/fail come straight
 *     from each graded result's stored `percentage` — the grading engine's
 *     derived fact, never re-derived here.
 *   * SUBJECT performance comes from the frozen `subject_breakdown` jsonb the
 *     grader wrote — authoritative and historical.
 *   * TOPIC accuracy has no frozen breakdown: `exam_question_snapshots` carries
 *     a `subject_id` but NOT a `topic_id`, and `exam_results` stores no topic
 *     roll-up. So a topic figure is reconstructed from the recorded answers +
 *     the frozen snapshot's answer key + the question's CURRENT topic tag. This
 *     is descriptive (a recount of what was answered), but a topic re-tag in the
 *     bank after the fact would shift how historical answers group — a known
 *     limitation, called out in the completion report, not a hidden one.
 *
 * ONE REPRESENTATIVE RESULT PER STUDENT
 * An exam allows several attempts (max_attempts); a class metric must not
 * double-count a student. Each student contributes their LATEST graded result
 * (newest `graded_at`), matching how a final grade is normally taken.
 *
 * TENANT + OWNERSHIP (same posture as lib/data/results.ts, AGENTS.md §5)
 * Every read is filtered by the caller's trusted `institution_id` (resolved
 * from the session, never a request body). A foreign exam id resolves to a null
 * exam, so existence elsewhere is never confirmed.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import type {
  AnalyticsResultRow,
  AnalyticsSubjectStat,
  AnalyticsTopicStat,
} from "@/lib/analytics";

/** An assigned class with its live roster size (for the completion denominator). */
export type AnalyticsClassRoster = {
  id: string;
  name: string;
  studentCount: number;
};

/** One assigned student, so a not-submitted roster can be listed honestly. */
export type AnalyticsRosterStudent = {
  id: string;
  name: string;
  className: string | null;
};

/** The exam context header the analytics page renders. */
export type AnalyticsExamContext = {
  id: string;
  title: string;
  subjectName: string;
  durationMinutes: number;
  startsAt: string | null;
  endsAt: string | null;
  status: string;
};

/** The full bundle the analytics page consumes. */
export type ExamAnalyticsBundle = {
  exam: AnalyticsExamContext;
  /** Distinct active students assigned to the exam (classes + direct). */
  rosterSize: number;
  /** Assigned classes with roster counts, name-ordered. */
  classes: AnalyticsClassRoster[];
  /** Every active assigned student (classes + direct), id-deduped. */
  roster: AnalyticsRosterStudent[];
  /** One row per graded student's representative result. */
  rows: AnalyticsResultRow[];
};

// --- Raw row shapes (snake_case) ---------------------------------------------

type ResultRawRow = {
  id: string;
  attempt_id: string;
  student_id: string;
  total_score: number | string;
  max_score: number | string;
  percentage: number | string;
  correct_count: number | string;
  total_questions: number | string;
  graded_at: string | null;
  subject_breakdown: unknown;
  students: { full_name: string } | null;
};

export type SnapshotRawRow = {
  id: string;
  question_id: string;
  subject_id: string | null;
  correct_option_index: number;
};

type AnswerRawRow = {
  attempt_id: string;
  snapshot_id: string;
  selected_option_index: number | null;
};

type QuestionTopicRow = {
  id: string;
  topic_id: string | null;
  topics: { name: string } | null;
};

/** Cast a PostgREST numeric (may arrive as a string) to a finite number. */
export function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function asBreakdown(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Resolve the exam's assigned audience: the classes it was assigned to (with
 * live roster counts) and the distinct active student ids across those classes
 * plus any direct assignments. Mirrors the audience logic in
 * lib/data/exams.ts but returns the roster size analytics need as the
 * completion denominator.
 */
async function resolveAudience(
  institutionId: string,
  examId: string,
): Promise<{
  rosterSize: number;
  classes: AnalyticsClassRoster[];
  roster: AnalyticsRosterStudent[];
}> {
  const supabase = createAdminClient();

  const { data: classRows, error: classError } = await supabase
    .from("exam_class_assignments")
    .select("class_id")
    .eq("exam_id", examId)
    .eq("institution_id", institutionId);
  if (classError) throw classError;
  const classIds = [...new Set((classRows ?? []).map((row) => row.class_id as string))];

  const { data: directRows, error: directError } = await supabase
    .from("exam_student_assignments")
    .select("student_id")
    .eq("exam_id", examId)
    .eq("institution_id", institutionId)
    .eq("status", "active");
  if (directError) throw directError;
  const directIds = new Set(
    (directRows ?? []).map((row) => row.student_id as string),
  );

  // studentId -> roster entry, so a class student and a direct assignment of
  // the same scholar dedupe to one row (the completion denominator is people).
  const rosterById = new Map<string, AnalyticsRosterStudent>();
  const perClass = new Map<string, number>();
  const classes: AnalyticsClassRoster[] = [];

  if (classIds.length > 0) {
    const [classNamesRes, rosterRes] = await Promise.all([
      supabase
        .from("classes")
        .select("id, name")
        .eq("institution_id", institutionId)
        .in("id", classIds),
      supabase
        .from("students")
        .select("id, full_name, class_id")
        .eq("institution_id", institutionId)
        .in("class_id", classIds)
        .eq("status", "active")
        .is("deleted_at", null),
    ]);
    if (classNamesRes.error) throw classNamesRes.error;
    if (rosterRes.error) throw rosterRes.error;

    const classNameById = new Map<string, string>(
      (classNamesRes.data ?? []).map((row) => [row.id as string, row.name as string]),
    );
    for (const row of rosterRes.data ?? []) {
      const classId = row.class_id as string;
      perClass.set(classId, (perClass.get(classId) ?? 0) + 1);
      rosterById.set(row.id as string, {
        id: row.id as string,
        name: row.full_name as string,
        className: classNameById.get(classId) ?? null,
      });
    }
    for (const row of classNamesRes.data ?? []) {
      classes.push({
        id: row.id as string,
        name: row.name as string,
        studentCount: perClass.get(row.id as string) ?? 0,
      });
    }
    classes.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Direct assignments add students not already counted through a class.
  if (directIds.size > 0) {
    const { data: directStudents, error: directStudentsError } = await supabase
      .from("students")
      .select("id, full_name, class_id")
      .eq("institution_id", institutionId)
      .in("id", [...directIds])
      .eq("status", "active")
      .is("deleted_at", null);
    if (directStudentsError) throw directStudentsError;

    const directClassIds = [
      ...new Set(
        (directStudents ?? [])
          .map((row) => row.class_id as string | null)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    let directClassNameById = new Map<string, string>();
    if (directClassIds.length > 0) {
      const namesRes = await supabase
        .from("classes")
        .select("id, name")
        .eq("institution_id", institutionId)
        .in("id", directClassIds);
      if (namesRes.error) throw namesRes.error;
      directClassNameById = new Map<string, string>(
        (namesRes.data ?? []).map((row) => [row.id as string, row.name as string]),
      );
    }
    for (const row of directStudents ?? []) {
      const id = row.id as string;
      if (rosterById.has(id)) continue; // already counted via its class
      const classId = row.class_id as string | null;
      rosterById.set(id, {
        id,
        name: row.full_name as string,
        className: classId ? directClassNameById.get(classId) ?? null : null,
      });
    }
  }

  const roster = [...rosterById.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { rosterSize: roster.length, classes, roster };
}

/**
 * Build per-student topic stats from the recorded answers + the frozen
 * snapshot's answer key + each question's current topic tag. A question with no
 * topic simply does not contribute to any topic bucket (never a fabricated
 * "uncategorised" row). Every student sat the same frozen snapshot, so a
 * topic's `total` is the number of that topic's questions on the exam.
 */
export function buildTopicStats(
  attemptId: string,
  snapshots: SnapshotRawRow[],
  topicByQuestion: Map<string, { topicId: string; topicName: string }>,
  answersByAttempt: Map<string, Map<string, number | null>>,
): AnalyticsTopicStat[] {
  const selected = answersByAttempt.get(attemptId);
  const buckets = new Map<string, AnalyticsTopicStat>();

  for (const snapshot of snapshots) {
    const topic = snapshot.question_id
      ? topicByQuestion.get(snapshot.question_id)
      : undefined;
    if (!topic) continue;

    const entry =
      buckets.get(topic.topicId) ??
      { topicId: topic.topicId, topicName: topic.topicName, correct: 0, total: 0 };
    entry.total += 1;

    const chosen = selected?.get(snapshot.id) ?? null;
    if (chosen !== null && chosen === snapshot.correct_option_index) {
      entry.correct += 1;
    }
    buckets.set(topic.topicId, entry);
  }

  return [...buckets.values()];
}

/** Parse the frozen subject_breakdown jsonb into per-subject display stats. */
export function buildSubjectStats(
  breakdown: readonly unknown[],
): AnalyticsSubjectStat[] {
  const stats: AnalyticsSubjectStat[] = [];
  for (const entry of breakdown) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const subjectId = record.subjectId;
    if (typeof subjectId !== "string" || subjectId.length === 0) continue;
    stats.push({
      subjectId,
      subjectName: "", // resolved by the page through the shared name lookup
      score: num(record.score),
      maxScore: num(record.maxScore),
    });
  }
  return stats;
}

/**
 * Load the full analytics bundle for one exam of this tenant. Returns `null`
 * when the exam is absent or belongs to another tenant (existence is never
 * leaked, AGENTS.md §5). Throws on a genuine data-source failure so the page can
 * render an honest error state.
 */
export async function getExamClassAnalytics(
  institutionId: string,
  examId: string,
): Promise<ExamAnalyticsBundle | null> {
  const supabase = createAdminClient();

  // 1. The exam, tenant-scoped. A foreign/absent id resolves to null.
  const { data: examData, error: examError } = await supabase
    .from("exams")
    .select(
      "id, title, subject_id, duration_minutes, starts_at, ends_at, status",
    )
    .eq("id", examId)
    .eq("institution_id", institutionId)
    .maybeSingle();
  if (examError) throw examError;
  if (!examData) return null;

  const examRow = examData as {
    id: string;
    title: string;
    subject_id: string | null;
    duration_minutes: number;
    starts_at: string | null;
    ends_at: string | null;
    status: string;
  };

  // 2. The exam's subject name (platform or this tenant's row).
  let subjectName = "—";
  if (examRow.subject_id) {
    const { data: subjectRow, error: subjectError } = await supabase
      .from("subjects")
      .select("name")
      .eq("id", examRow.subject_id)
      .maybeSingle();
    if (subjectError) throw subjectError;
    subjectName = subjectRow?.name ?? "—";
  }

  const [audience, resultsRes, snapshotsRes] = await Promise.all([
    resolveAudience(institutionId, examRow.id),
    supabase
      .from("exam_results")
      .select(
        "id, attempt_id, student_id, total_score, max_score, percentage, correct_count, total_questions, graded_at, subject_breakdown, students(full_name)",
      )
      .eq("exam_id", examRow.id)
      .eq("institution_id", institutionId)
      .order("graded_at", { ascending: false }),
    supabase
      .from("exam_question_snapshots")
      .select("id, question_id, subject_id, correct_option_index")
      .eq("exam_id", examRow.id)
      .eq("institution_id", institutionId),
  ]);
  if (resultsRes.error) throw resultsRes.error;
  if (snapshotsRes.error) throw snapshotsRes.error;

  const allResults = (resultsRes.data ?? []) as unknown as ResultRawRow[];

  // 3. One representative (latest-graded) result per student.
  const byStudent = new Map<string, ResultRawRow>();
  for (const row of allResults) {
    if (!byStudent.has(row.student_id)) byStudent.set(row.student_id, row);
  }
  const representative = [...byStudent.values()];

  // 4. Topic tags for the exam's questions (question → current topic).
  const snapshots = (snapshotsRes.data ?? []) as unknown as SnapshotRawRow[];
  const questionIds = [
    ...new Set(snapshots.map((snapshot) => snapshot.question_id).filter(Boolean)),
  ];

  const topicByQuestion = new Map<string, { topicId: string; topicName: string }>();
  if (questionIds.length > 0) {
    const { data: questionRows, error: questionError } = await supabase
      .from("questions")
      .select("id, topic_id, topics(name)")
      .eq("institution_id", institutionId)
      .in("id", questionIds);
    if (questionError) throw questionError;
    for (const raw of questionRows ?? []) {
      const row = raw as unknown as QuestionTopicRow;
      if (row.topic_id && row.topics?.name) {
        topicByQuestion.set(row.id, {
          topicId: row.topic_id,
          topicName: row.topics.name,
        });
      }
    }
  }

  // 5. Recorded answers for the representative attempts only.
  const attemptIds = representative.map((row) => row.attempt_id);
  const answersByAttempt = new Map<string, Map<string, number | null>>();
  if (attemptIds.length > 0) {
    const { data: answerRows, error: answerError } = await supabase
      .from("exam_attempt_answers")
      .select("attempt_id, snapshot_id, selected_option_index")
      .eq("institution_id", institutionId)
      .in("attempt_id", attemptIds);
    if (answerError) throw answerError;
    for (const row of (answerRows ?? []) as unknown as AnswerRawRow[]) {
      const inner =
        answersByAttempt.get(row.attempt_id) ?? new Map<string, number | null>();
      inner.set(row.snapshot_id, row.selected_option_index);
      answersByAttempt.set(row.attempt_id, inner);
    }
  }

  // 6. Assemble the per-student rows the pure layer aggregates.
  const rows: AnalyticsResultRow[] = representative.map((row) => ({
    studentId: row.student_id,
    studentName: row.students?.full_name ?? "—",
    percentage: num(row.percentage),
    score: num(row.total_score),
    maxScore: num(row.max_score),
    correctCount: num(row.correct_count),
    totalQuestions: num(row.total_questions),
    topics: buildTopicStats(row.attempt_id, snapshots, topicByQuestion, answersByAttempt),
    subjects: buildSubjectStats(asBreakdown(row.subject_breakdown)),
  }));

  return {
    exam: {
      id: examRow.id,
      title: examRow.title,
      subjectName,
      durationMinutes: examRow.duration_minutes,
      startsAt: examRow.starts_at,
      endsAt: examRow.ends_at,
      status: examRow.status,
    },
    rosterSize: audience.rosterSize,
    classes: audience.classes,
    roster: audience.roster,
    rows,
  };
}

/**
 * Resolve the display names for the subject ids a bundle's breakdowns reference
 * (platform + this tenant's rows). Kept separate from the bundle read so the
 * page can label subjects without a second round-trip per row. An id that no
 * longer resolves falls back to "—" — never a guess (AGENTS.md §7).
 */
export async function resolveSubjectNames(
  institutionId: string,
  subjectIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(subjectIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("subjects")
    .select("id, name")
    .eq("institution_id", institutionId)
    .in("id", unique);
  if (error) throw error;
  return new Map<string, string>(
    (data ?? []).map((row) => [row.id as string, row.name as string]),
  );
}
