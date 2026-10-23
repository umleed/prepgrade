/**
 * Institution-wide analytics reads — SERVER-ONLY (prompt 28).
 *
 * Assembles the facts the institution analytics dashboard turns into
 * tenant-level counts, trends, per-class breakdowns, subject performance, and
 * the weakest-topic attention list. Same posture as lib/data/analytics.ts
 * (prompt 27): only durable, server-computed facts are read — the
 * `exam_results` rows, the frozen `exam_question_snapshots`, and the recorded
 * `exam_attempt_answers`. Nothing is recomputed from a client value, no score
 * is trusted from the browser, and no answer key leaves the server (AGENTS.md §6).
 *
 * HONEST ABOUT THE SAMPLE
 * Every read is period-bounded (`graded_at`) and tenant-filtered
 * (`.eq("institution_id", …)` from the trusted session, AGENTS.md §5). A
 * student may sat several attempts; the metrics use their LATEST graded
 * result per assessment, while the raw attempt count travels alongside so the
 * view can explain what a metric recounts. Supabase caps a page at 1000 rows,
 * so results are paged up to a hard ceiling; if that ceiling is reached the
 * bundle says so (`truncated`) instead of silently presenting a partial
 * recount as the whole picture (AGENTS.md §7).
 *
 * TOPIC RECONSTRUCTION — SAME KNOWN LIMIT AS PROMPT 27
 * Snapshots freeze a `subject_id` but not a `topic_id`, so topic accuracy is
 * reconstructed from the recorded answers + the frozen key + each question's
 * CURRENT topic tag. A later re-tag would regroup history; the view calls
 * this out rather than hiding it.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import type { AnalyticsResultRow } from "@/lib/analytics";
import {
  asBreakdown,
  buildSubjectStats,
  buildTopicStats,
  num,
  type SnapshotRawRow,
} from "@/lib/data/analytics";

/** One active class with its live roster count (breakdown + denominators). */
export type InstitutionAnalyticsClassRow = {
  id: string;
  name: string;
  studentCount: number;
};

/** An assessment that has graded results inside the reporting period. */
export type InstitutionAnalyticsExamRow = {
  id: string;
  title: string;
};

/** Everything the institution analytics page renders, already tenant-scoped. */
export type InstitutionAnalyticsBundle = {
  /** Active, non-deleted students in the tenant — the completion denominator. */
  activeStudents: number;
  /** Active classes with roster counts, name-ordered. */
  classes: InstitutionAnalyticsClassRow[];
  /**
   * One row per student × assessment: the LATEST graded result, newest
   * first. Optional fields (gradedAt/class/exam) are filled for the
   * institution roll-ups in lib/analytics.ts.
   */
  rows: AnalyticsResultRow[];
  /** All graded result rows in the period — attempts, before dedup. */
  gradedAttempts: number;
  /** The same attempt count, bucketed by the student's current class ("" = none). */
  gradedAttemptsByClass: Map<string, number>;
  /** Distinct assessments with at least one graded result in the period. */
  exams: InstitutionAnalyticsExamRow[];
  /** True when the period holds more results than the read ceiling (5000). */
  truncated: boolean;
};

// --- Raw row shapes (snake_case) ----------------------------------------------

type InstitutionResultRaw = {
  attempt_id: string;
  exam_id: string;
  student_id: string;
  total_score: number | string;
  max_score: number | string;
  percentage: number | string;
  correct_count: number | string;
  total_questions: number | string;
  graded_at: string | null;
  subject_breakdown: unknown;
  students: { full_name: string; class_id: string | null } | null;
};

/** PostgREST serves 1000 rows per page; the ceiling bounds one dashboard read. */
const PAGE_SIZE = 1000;
const MAX_RESULT_PAGES = 5;

/** Chunk an id list so an `.in(…)` filter never builds an over-long query. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Load the tenant's graded results for the reporting period, newest first.
 * `periodDays === null` means "all time". Pages past the read ceiling stop
 * the loop and flag the bundle `truncated` rather than pretending the
 * recount is complete.
 */
async function fetchResults(
  institutionId: string,
  periodDays: number | null,
): Promise<{ rows: InstitutionResultRaw[]; truncated: boolean }> {
  const supabase = createAdminClient();
  const fromIso =
    periodDays === null
      ? null
      : new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

  const all: InstitutionResultRaw[] = [];
  for (let page = 0; page < MAX_RESULT_PAGES; page++) {
    let query = supabase
      .from("exam_results")
      .select(
        "attempt_id, exam_id, student_id, total_score, max_score, percentage, correct_count, total_questions, graded_at, subject_breakdown, students(full_name, class_id)",
      )
      .eq("institution_id", institutionId)
      .order("graded_at", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (fromIso) query = query.gte("graded_at", fromIso);

    const { data, error } = await query;
    if (error) throw error;
    const batch = (data ?? []) as unknown as InstitutionResultRaw[];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) {
      return { rows: all, truncated: false };
    }
  }
  return { rows: all, truncated: true };
}

/**
 * The full institution bundle for one tenant and reporting period. Throws on
 * a genuine data-source failure (missing tables, unconfigured keys) so the
 * page can render its honest "cannot load" state; an empty tenant simply
 * yields empty arrays and zero counts, which the view renders as empty states.
 */
export async function getInstitutionAnalytics(
  institutionId: string,
  periodDays: number | null,
): Promise<InstitutionAnalyticsBundle> {
  const supabase = createAdminClient();

  // 1. Roster context and the period's graded results, in parallel.
  const [rosterRes, classesRes, results] = await Promise.all([
    supabase
      .from("students")
      .select("id, class_id")
      .eq("institution_id", institutionId)
      .eq("status", "active")
      .is("deleted_at", null),
    supabase
      .from("classes")
      .select("id, name")
      .eq("institution_id", institutionId)
      .eq("status", "active")
      .order("name", { ascending: true }),
    fetchResults(institutionId, periodDays),
  ]);
  if (rosterRes.error) throw rosterRes.error;
  if (classesRes.error) throw classesRes.error;

  const classRows = (classesRes.data ?? []) as { id: string; name: string }[];
  const classNameById = new Map<string, string>(
    classRows.map((row) => [row.id, row.name]),
  );

  // Roster counts per class, from the same active-student read (one query).
  const studentCountByClass = new Map<string, number>();
  for (const row of (rosterRes.data ?? []) as {
    id: string;
    class_id: string | null;
  }[]) {
    if (row.class_id && classNameById.has(row.class_id)) {
      studentCountByClass.set(
        row.class_id,
        (studentCountByClass.get(row.class_id) ?? 0) + 1,
      );
    }
  }
  const classes: InstitutionAnalyticsClassRow[] = classRows.map((row) => ({
    id: row.id,
    name: row.name,
    studentCount: studentCountByClass.get(row.id) ?? 0,
  }));

  // 2. Every graded attempt in the period counts toward the sample size …
  const gradedAttempts = results.rows.length;
  const gradedAttemptsByClass = new Map<string, number>();
  for (const row of results.rows) {
    const key = row.students?.class_id ?? "";
    gradedAttemptsByClass.set(key, (gradedAttemptsByClass.get(key) ?? 0) + 1);
  }

  // … while each student × assessment contributes only its latest result.
  const byStudentExam = new Set<string>();
  const representative: InstitutionResultRaw[] = [];
  for (const row of results.rows) {
    const key = `${row.student_id}:${row.exam_id}`;
    if (byStudentExam.has(key)) continue;
    byStudentExam.add(key);
    representative.push(row);
  }

  // 3. Exam titles for the assessments the representative rows came from.
  const examIds = [...new Set(representative.map((row) => row.exam_id))];
  const examTitleById = new Map<string, string>();
  for (const batch of chunk(examIds, 200)) {
    const { data, error } = await supabase
      .from("exams")
      .select("id, title")
      .eq("institution_id", institutionId)
      .in("id", batch);
    if (error) throw error;
    for (const row of (data ?? []) as { id: string; title: string }[]) {
      examTitleById.set(row.id, row.title);
    }
  }
  const exams: InstitutionAnalyticsExamRow[] = examIds
    .map((id) => ({ id, title: examTitleById.get(id) ?? "—" }))
    .sort((a, b) => a.title.localeCompare(b.title));

  // 4. Frozen snapshots (question ids + the answer key) for those exams.
  const snapshotsByExam = new Map<string, SnapshotRawRow[]>();
  for (const batch of chunk(examIds, 100)) {
    const { data, error } = await supabase
      .from("exam_question_snapshots")
      .select("id, question_id, subject_id, correct_option_index")
      .eq("institution_id", institutionId)
      .in("exam_id", batch);
    if (error) throw error;
    for (const row of (data ?? []) as unknown as (SnapshotRawRow & {
      exam_id: string;
    })[]) {
      const list = snapshotsByExam.get(row.exam_id) ?? [];
      list.push(row);
      snapshotsByExam.set(row.exam_id, list);
    }
  }

  // 5. Current topic tags for every question those snapshots reference.
  const questionIds = [
    ...new Set(
      [...snapshotsByExam.values()]
        .flat()
        .map((snapshot) => snapshot.question_id)
        .filter(Boolean),
    ),
  ];
  const topicByQuestion = new Map<string, { topicId: string; topicName: string }>();
  for (const batch of chunk(questionIds, 200)) {
    const { data, error } = await supabase
      .from("questions")
      .select("id, topic_id, topics(name)")
      .eq("institution_id", institutionId)
      .in("id", batch);
    if (error) throw error;
    for (const raw of (data ?? []) as unknown as {
      id: string;
      topic_id: string | null;
      topics: { name: string } | null;
    }[]) {
      if (raw.topic_id && raw.topics?.name) {
        topicByQuestion.set(raw.id, { topicId: raw.topic_id, topicName: raw.topics.name });
      }
    }
  }

  // 6. Recorded answers for the representative attempts only.
  const answersByAttempt = new Map<string, Map<string, number | null>>();
  for (const batch of chunk(representative.map((row) => row.attempt_id), 200)) {
    const { data, error } = await supabase
      .from("exam_attempt_answers")
      .select("attempt_id, snapshot_id, selected_option_index")
      .eq("institution_id", institutionId)
      .in("attempt_id", batch);
    if (error) throw error;
    for (const row of (data ?? []) as unknown as {
      attempt_id: string;
      snapshot_id: string;
      selected_option_index: number | null;
    }[]) {
      const inner =
        answersByAttempt.get(row.attempt_id) ?? new Map<string, number | null>();
      inner.set(row.snapshot_id, row.selected_option_index);
      answersByAttempt.set(row.attempt_id, inner);
    }
  }

  // 7. Assemble the rows the pure layer aggregates. subjectName stays "" and
  //    is resolved by the page through resolveSubjectNames (shared with 27).
  const rows: AnalyticsResultRow[] = representative.map((row) => {
    const classId = row.students?.class_id ?? null;
    return {
      studentId: row.student_id,
      studentName: row.students?.full_name ?? "—",
      percentage: num(row.percentage),
      score: num(row.total_score),
      maxScore: num(row.max_score),
      correctCount: num(row.correct_count),
      totalQuestions: num(row.total_questions),
      topics: buildTopicStats(
        row.attempt_id,
        snapshotsByExam.get(row.exam_id) ?? [],
        topicByQuestion,
        answersByAttempt,
      ),
      subjects: buildSubjectStats(asBreakdown(row.subject_breakdown)),
      gradedAt: row.graded_at ?? undefined,
      classId,
      className: classId ? classNameById.get(classId) : undefined,
      examId: row.exam_id,
      examTitle: examTitleById.get(row.exam_id) ?? "—",
    };
  });

  return {
    activeStudents: ((rosterRes.data ?? []) as unknown[]).length,
    classes,
    rows,
    gradedAttempts,
    gradedAttemptsByClass,
    exams,
    truncated: results.truncated,
  };
}
