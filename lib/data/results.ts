/**
 * Exam result reads — SERVER-ONLY (prompt 25).
 *
 * Presents the durable `exam_results` rows the grading engine (prompt 24)
 * computed. This module NEVER recomputes, accepts, or trusts a score: it reads
 * the stored derived facts and the exam's frozen release policy, then applies
 * the SAME pure release gate the grading layer uses (`lib/results.ts`) so what
 * is visible follows the policy exactly (AGENTS.md §6). It adds no score,
 * percentage, or answer key of its own.
 *
 * TENANT + OWNERSHIP (same posture as lib/data/grading.ts, AGENTS.md §5)
 * Every read is filtered by the caller's trusted `institution_id` (resolved
 * from the session, never a request body). Student-facing reads additionally
 * pin `student_id` to the verified student record, so a tampered result id that
 * belongs to another student resolves to nothing — existence is never leaked.
 *
 * FAIL CLOSED ON VISIBILITY
 * A student result whose release policy has not yet permitted it is returned
 * with its numbers STRIPPED (nulls) and a plain-language hint, not a partially
 * rendered score. Staff reads are authorised to see the numbers but carry the
 * student-facing visibility so a teacher can tell whether it has gone out yet.
 * Answer keys never live in `exam_results`, so none can leak from here anyway.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import {
  buildSubjectRows,
  releaseHint,
  studentResultVisibility,
  type ExamResultRelease,
  type StudentResultVisibility,
  type SubjectResultRow,
} from "@/lib/results";

// --- Result shapes returned to the views -------------------------------------

/** One graded result as its own student may see it (numbers gated by policy). */
export type StudentResultSummary = {
  resultId: string;
  attemptId: string;
  examId: string;
  examTitle: string;
  subjectName: string;
  /** The attempt's terminal status that produced this result. */
  attemptStatus: string;
  submittedAt: string | null;
  gradedAt: string | null;
  visibility: StudentResultVisibility;
  /** Non-null only while `not_yet_released`; when the numbers will appear. */
  hint: string | null;
  // These are null (and the breakdown empty) until the policy releases them.
  totalScore: number | null;
  maxScore: number | null;
  percentage: number | null;
  correctCount: number | null;
  incorrectCount: number | null;
  unansweredCount: number | null;
  totalQuestions: number | null;
  timeUsedSeconds: number | null;
  subjectBreakdown: SubjectResultRow[];
};

/** One graded result as an authorised teacher / institution admin sees it. */
export type ExamResultRow = {
  resultId: string;
  attemptId: string;
  studentId: string;
  studentName: string;
  studentCode: string;
  attemptNumber: number;
  attemptStatus: string;
  submittedAt: string | null;
  gradedAt: string | null;
  totalScore: number;
  maxScore: number;
  percentage: number;
  correctCount: number;
  incorrectCount: number;
  unansweredCount: number;
  totalQuestions: number;
  timeUsedSeconds: number;
  /** Whether the SAME result is released to the student yet (for staff context). */
  studentVisibility: StudentResultVisibility;
  subjectBreakdown: SubjectResultRow[];
};

// --- Raw row shapes (snake_case + embeds) ------------------------------------

type ResultEmbeddedRow = {
  id: string;
  attempt_id: string;
  exam_id: string;
  student_id: string;
  total_score: number | string;
  max_score: number | string;
  percentage: number | string;
  correct_count: number | string;
  incorrect_count: number | string;
  unanswered_count: number | string;
  total_questions: number | string;
  time_used_seconds: number | string;
  subject_breakdown: unknown;
  released_at: string | null;
  graded_at: string | null;
  exams: {
    title: string;
    subject_id: string;
    results_release: string;
    ends_at: string | null;
    status: string;
  } | null;
  exam_attempts: {
    status: string;
    submitted_at: string | null;
    attempt_number: number;
  } | null;
  students?: { full_name: string; student_code: string } | null;
};

// Each embed resolves through exam_results' single FK to that table
// (exam_id -> exams, attempt_id -> exam_attempts, student_id -> students), so
// the concise PostgREST form is unambiguous — the same style the students read
// uses for `classes(name)`.
const RESULT_COLUMNS =
  "id, attempt_id, exam_id, student_id, total_score, max_score, percentage, correct_count, incorrect_count, unanswered_count, total_questions, time_used_seconds, subject_breakdown, released_at, graded_at, exams(title, subject_id, results_release, ends_at, status), exam_attempts(status, submitted_at, attempt_number)";

/** Cast a PostgREST numeric (may arrive as a string) to a finite number. */
function num(value: number | string | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toReleasePolicy(value: string | undefined | null): ExamResultRelease {
  return value === "immediate" || value === "manual" ? value : "after_window";
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function asBreakdown(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Batched subject-name lookup for this tenant (platform rows included). */
async function subjectNames(
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

/**
 * Turn one raw row into the trusted facts + release decision. The release gate
 * runs server-side on the exam's policy, so the caller never re-derives it from
 * a stored flag alone (a regrade can lag the stamp; the policy is authoritative).
 */
function interpret(row: ResultEmbeddedRow, nowMs: number): {
  release: ExamResultRelease;
  windowEndsAtMs: number | null;
  visibility: StudentResultVisibility;
  examTitle: string;
  examSubjectId: string;
  attemptStatus: string;
  submittedAt: string | null;
  attemptNumber: number;
} {
  const exam = row.exams;
  const attempt = row.exam_attempts;
  const release = toReleasePolicy(exam?.results_release);
  const visibility = studentResultVisibility({
    resultsRelease: release,
    gradedAtMs: parseMs(row.graded_at),
    windowEndsAtMs: parseMs(exam?.ends_at ?? null),
    releasedAtMs: parseMs(row.released_at),
    nowMs,
  });
  return {
    release,
    windowEndsAtMs: parseMs(exam?.ends_at ?? null),
    visibility,
    examTitle: exam?.title ?? "—",
    examSubjectId: exam?.subject_id ?? "",
    attemptStatus: attempt?.status ?? "submitted",
    submittedAt: attempt?.submitted_at ?? null,
    attemptNumber: num(attempt?.attempt_number ?? 1),
  };
}

// --- Student reads (own results only, gated by release policy) ---------------

/**
 * Every graded result belonging to ONE student of this tenant, newest graded
 * first. A result not yet released by its exam's policy is returned with its
 * numbers stripped and a hint, so the student view can render an honest
 * "not yet released" state without ever exposing an unreleased score.
 */
export async function listStudentResults(
  institutionId: string,
  studentId: string,
): Promise<StudentResultSummary[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("exam_results")
    .select(RESULT_COLUMNS)
    .eq("institution_id", institutionId)
    .eq("student_id", studentId)
    .order("graded_at", { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as unknown as ResultEmbeddedRow[];
  return mapToStudentSummaries(institutionId, rows);
}

/**
 * One of the student's own results, tenant + ownership filtered. `null` means
 * absent OR another student's/tenant's — existence is never leaked (AGENTS.md
 * §5). A not-yet-released result still resolves (so the student sees its state),
 * but its numbers are stripped.
 */
export async function getStudentResult(
  institutionId: string,
  studentId: string,
  resultId: string,
): Promise<StudentResultSummary | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("exam_results")
    .select(RESULT_COLUMNS)
    .eq("id", resultId)
    .eq("institution_id", institutionId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const rows = [data as unknown as ResultEmbeddedRow];
  const summaries = await mapToStudentSummaries(institutionId, rows);
  return summaries[0] ?? null;
}

async function mapToStudentSummaries(
  institutionId: string,
  rows: ResultEmbeddedRow[],
): Promise<StudentResultSummary[]> {
  const nowMs = Date.now();
  const interpreted = rows.map((row) => interpret(row, nowMs));

  // Collect every subject id we may need a name for: the exam's own subject
  // (context label) and each released breakdown's subjects.
  const ids: string[] = [];
  rows.forEach((row, index) => {
    const info = interpreted[index];
    ids.push(info.examSubjectId);
    if (info.visibility === "released") {
      for (const entry of asBreakdown(row.subject_breakdown)) {
        const subjectId =
          entry && typeof entry === "object"
            ? (entry as { subjectId?: unknown }).subjectId
            : undefined;
        if (typeof subjectId === "string") ids.push(subjectId);
      }
    }
  });
  const names = await subjectNames(institutionId, ids);
  const nameFor = (id: string) => names.get(id) ?? null;

  return rows.map((row, index) => {
    const info = interpreted[index];
    const released = info.visibility === "released";
    return {
      resultId: row.id,
      attemptId: row.attempt_id,
      examId: row.exam_id,
      examTitle: info.examTitle,
      subjectName: nameFor(info.examSubjectId) ?? "—",
      attemptStatus: info.attemptStatus,
      submittedAt: info.submittedAt,
      gradedAt: row.graded_at,
      visibility: info.visibility,
      hint: released ? null : releaseHint(info.release),
      totalScore: released ? num(row.total_score) : null,
      maxScore: released ? num(row.max_score) : null,
      percentage: released ? num(row.percentage) : null,
      correctCount: released ? num(row.correct_count) : null,
      incorrectCount: released ? num(row.incorrect_count) : null,
      unansweredCount: released ? num(row.unanswered_count) : null,
      totalQuestions: released ? num(row.total_questions) : null,
      timeUsedSeconds: released ? num(row.time_used_seconds) : null,
      subjectBreakdown: released
        ? buildSubjectRows(asBreakdown(row.subject_breakdown), nameFor)
        : [],
    };
  });
}

// --- Staff reads (authorised teachers / institution admins) ------------------

/**
 * All graded results for ONE exam of this tenant, highest percentage first.
 * Staff are authorised to see the numbers regardless of the student release
 * gate, but each row carries `studentVisibility` so the screen can honestly
 * mark whether a result has gone out to the student yet.
 */
export async function listExamResults(
  institutionId: string,
  examId: string,
): Promise<ExamResultRow[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("exam_results")
    .select(`${RESULT_COLUMNS}, students(full_name, student_code)`)
    .eq("institution_id", institutionId)
    .eq("exam_id", examId)
    .order("percentage", { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as unknown as ResultEmbeddedRow[];
  return mapToExamResultRows(institutionId, rows);
}

/**
 * One result of ONE exam of this tenant, for the staff detail view. `null` when
 * the id is absent, belongs to another tenant, or is not this exam's — the
 * exam-scope check stops a valid result id from another exam leaking in.
 */
export async function getExamResult(
  institutionId: string,
  examId: string,
  resultId: string,
): Promise<ExamResultRow | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("exam_results")
    .select(`${RESULT_COLUMNS}, students(full_name, student_code)`)
    .eq("id", resultId)
    .eq("institution_id", institutionId)
    .eq("exam_id", examId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const rows = [data as unknown as ResultEmbeddedRow];
  const mapped = await mapToExamResultRows(institutionId, rows);
  return mapped[0] ?? null;
}

async function mapToExamResultRows(
  institutionId: string,
  rows: ResultEmbeddedRow[],
): Promise<ExamResultRow[]> {
  const nowMs = Date.now();
  const interpreted = rows.map((row) => interpret(row, nowMs));

  const ids: string[] = [];
  rows.forEach((row, index) => {
    ids.push(interpreted[index].examSubjectId);
    for (const entry of asBreakdown(row.subject_breakdown)) {
      const subjectId =
        entry && typeof entry === "object"
          ? (entry as { subjectId?: unknown }).subjectId
          : undefined;
      if (typeof subjectId === "string") ids.push(subjectId);
    }
  });
  const names = await subjectNames(institutionId, ids);
  const nameFor = (id: string) => names.get(id) ?? null;

  return rows.map((row, index) => {
    const info = interpreted[index];
    return {
      resultId: row.id,
      attemptId: row.attempt_id,
      studentId: row.student_id,
      studentName: row.students?.full_name ?? "—",
      studentCode: row.students?.student_code ?? "—",
      attemptNumber: info.attemptNumber,
      attemptStatus: info.attemptStatus,
      submittedAt: info.submittedAt,
      gradedAt: row.graded_at,
      totalScore: num(row.total_score),
      maxScore: num(row.max_score),
      percentage: num(row.percentage),
      correctCount: num(row.correct_count),
      incorrectCount: num(row.incorrect_count),
      unansweredCount: num(row.unanswered_count),
      totalQuestions: num(row.total_questions),
      timeUsedSeconds: num(row.time_used_seconds),
      studentVisibility: info.visibility,
      subjectBreakdown: buildSubjectRows(asBreakdown(row.subject_breakdown), nameFor),
    };
  });
}
