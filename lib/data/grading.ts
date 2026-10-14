/**
 * Exam grading data access — SERVER-ONLY (prompt 24).
 *
 * Turns a LOCKED attempt into a durable `exam_results` row. It reads ONLY
 * trusted server facts — the immutable snapshot (marks + frozen answer key +
 * subject id) and the student's recorded CANONICAL selections — feeds them to
 * the pure rules in lib/grading.ts, and writes the computed numbers. No score,
 * percentage, correctness flag, or answer key is ever taken from a client
 * (AGENTS.md §6); this module is reached exclusively from server code.
 *
 * TENANT + OWNERSHIP (same posture as lib/data/attempts.ts, AGENTS.md §5)
 * Every read and write is filtered by the caller's trusted `institution_id`
 * (resolved from the session, never a request body) AND the attempt must belong
 * to that tenant. A foreign/absent attempt id resolves to a null read (never a
 * per-case leak) and grades nothing.
 *
 * IDEMPOTENT + FINALISATION-SAFE (AGENTS.md §6)
 * Grading runs only on a TERMINAL (submitted/expired) attempt, whose answers
 * can no longer change, so the computation is deterministic: a retried grade
 * UPSERTs the SAME `exam_results` row (keyed by `attempt_id`) with identical
 * numbers rather than duplicating it or drifting a finalised result. The
 * release stamp is monotonic — an already-released result is never silently
 * un-released by a regrade.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import {
  computeTimeUsedSeconds,
  gradeObjectiveAnswers,
  isResultReleased,
  type GradingQuestion,
} from "@/lib/grading";

// --- Row shapes --------------------------------------------------------------

type GradingAttemptRow = {
  id: string;
  exam_id: string;
  student_id: string;
  institution_id: string;
  status: string;
  started_at: string;
  expires_at: string;
  submitted_at: string | null;
};

type GradingSnapshotRow = {
  id: string;
  marks: number;
  correct_option_index: number;
  subject_id: string | null;
};

type GradingAnswerRow = {
  snapshot_id: string;
  selected_option_index: number | null;
};

type ExamReleaseRow = {
  results_release: string;
  ends_at: string | null;
};

type ExistingResultRow = {
  released_at: string | null;
};

export type GradeAttemptOutcome =
  | { ok: true; released: boolean }
  | { ok: false; reason: "notFound" | "notReady" | "unavailable"; message: string };

function toReleasePolicy(value: string): "immediate" | "after_window" | "manual" {
  return value === "immediate" || value === "manual" ? value : "after_window";
}

function parseMs(value: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Grade one attempt and persist its result. Safe to call repeatedly: it is a
 * no-op on a still-in-progress attempt (nothing to finalise) and an idempotent
 * UPSERT on a terminal one. Returns whether the result is released to the
 * student under the exam's policy, so callers can log/reflect the state without
 * re-deriving it.
 */
export async function gradeAttempt(
  institutionId: string,
  attemptId: string,
): Promise<GradeAttemptOutcome> {
  const supabase = createAdminClient();

  // 1. The attempt, tenant-scoped. A foreign/absent id resolves to null.
  const { data: attemptData, error: attemptError } = await supabase
    .from("exam_attempts")
    .select(
      "id, exam_id, student_id, institution_id, status, started_at, expires_at, submitted_at",
    )
    .eq("id", attemptId)
    .eq("institution_id", institutionId)
    .maybeSingle();
  if (attemptError) throw attemptError;
  if (!attemptData) {
    return { ok: false, reason: "notFound", message: "This attempt could not be found." };
  }

  const attempt = attemptData as GradingAttemptRow;
  // Only a terminal attempt has a final answer set to grade (AGENTS.md §6). A
  // live attempt is refused here AND by the DB anchor trigger — defence in
  // depth, so no code path can half-grade an in-progress sitting.
  if (attempt.status === "in_progress") {
    return {
      ok: false,
      reason: "notReady",
      message: "This attempt is still in progress and cannot be graded yet.",
    };
  }

  // 2. The frozen snapshot: marks + answer key + subject, for THIS exam + tenant.
  const { data: snapshotData, error: snapshotError } = await supabase
    .from("exam_question_snapshots")
    .select("id, marks, correct_option_index, subject_id")
    .eq("exam_id", attempt.exam_id)
    .eq("institution_id", institutionId);
  if (snapshotError) throw snapshotError;
  const snapshots = (snapshotData ?? []) as GradingSnapshotRow[];
  if (snapshots.length < 1) {
    // A terminal attempt with no snapshot rows is a data anomaly (a published
    // exam always has snapshots). Fail closed — record nothing rather than a
    // fabricated zero result.
    return {
      ok: false,
      reason: "unavailable",
      message: "This attempt's exam has no gradable questions on record.",
    };
  }

  // 3. The recorded answers, keyed by snapshot. Selected index is already
  //    canonical (the delivery layer undid the shuffle at save time).
  const { data: answerData, error: answerError } = await supabase
    .from("exam_attempt_answers")
    .select("snapshot_id, selected_option_index")
    .eq("attempt_id", attempt.id)
    .eq("institution_id", institutionId);
  if (answerError) throw answerError;
  const selectedBySnapshot = new Map<string, number | null>(
    ((answerData ?? []) as GradingAnswerRow[]).map((row) => [
      row.snapshot_id,
      row.selected_option_index,
    ]),
  );

  // 4. Build the grading input from trusted rows only. A snapshot with a broken
  //    correct index (negative / non-integer) can never match a real answer, so
  //    it simply grades as not-correct — it is not silently dropped, because
  //    that would shrink the denominator the student is graded against.
  const questions: GradingQuestion[] = snapshots.map((snapshot) => ({
    snapshotId: snapshot.id,
    marks: Number.isInteger(snapshot.marks) ? snapshot.marks : 0,
    correctOptionIndex: Number.isInteger(snapshot.correct_option_index)
      ? snapshot.correct_option_index
      : -1,
    selectedOptionIndex: selectedBySnapshot.get(snapshot.id) ?? null,
    subjectId: typeof snapshot.subject_id === "string" ? snapshot.subject_id : null,
  }));

  const graded = gradeObjectiveAnswers(questions);

  // 5. Time used, from server stamps. An attempt expired by the read-settle
  //    path has no `submitted_at`, so fall back to the deadline it hit.
  const startedMs = parseMs(attempt.started_at) ?? 0;
  const expiresMs = parseMs(attempt.expires_at);
  const endedMs = parseMs(attempt.submitted_at) ?? expiresMs ?? startedMs;
  const windowSeconds =
    expiresMs !== null ? Math.max(0, Math.floor((expiresMs - startedMs) / 1000)) : null;
  const timeUsedSeconds = computeTimeUsedSeconds({
    startedAtMs: startedMs,
    endedAtMs: endedMs,
    maxSeconds: windowSeconds,
  });

  // 6. Release policy from the exam (tenant-scoped), judged by the pure rule.
  const { data: examData, error: examError } = await supabase
    .from("exams")
    .select("results_release, ends_at")
    .eq("id", attempt.exam_id)
    .eq("institution_id", institutionId)
    .maybeSingle();
  if (examError) throw examError;
  const exam = (examData as ExamReleaseRow | null) ?? {
    results_release: "after_window",
    ends_at: null,
  };

  const nowMs = Date.now();
  // Preserve any prior release stamp (monotonic): a regrade never un-releases.
  const { data: existingData, error: existingError } = await supabase
    .from("exam_results")
    .select("released_at")
    .eq("attempt_id", attempt.id)
    .eq("institution_id", institutionId)
    .maybeSingle();
  if (existingError) throw existingError;
  const existing = (existingData as ExistingResultRow | null) ?? null;
  const existingReleasedMs = parseMs(existing?.released_at ?? null);

  const releaseInput = {
    resultsRelease: toReleasePolicy(exam.results_release),
    gradedAtMs: nowMs,
    windowEndsAtMs: parseMs(exam.ends_at),
    releasedAtMs: existingReleasedMs,
    nowMs,
  };
  const released = isResultReleased(releaseInput);
  // Stamp the moment it first becomes visible; keep the existing stamp otherwise.
  const releasedAtToStore = existing?.released_at ?? (released ? new Date(nowMs).toISOString() : null);

  // 7. Idempotent UPSERT keyed on attempt_id — one result per sitting.
  const payload = {
    attempt_id: attempt.id,
    exam_id: attempt.exam_id,
    student_id: attempt.student_id,
    institution_id: institutionId,
    total_score: graded.totalScore,
    max_score: graded.maxScore,
    percentage: graded.percentage,
    correct_count: graded.correctCount,
    incorrect_count: graded.incorrectCount,
    unanswered_count: graded.unansweredCount,
    total_questions: graded.totalQuestions,
    time_used_seconds: timeUsedSeconds,
    subject_breakdown: graded.subjectBreakdown,
    released_at: releasedAtToStore,
    graded_at: new Date(nowMs).toISOString(),
  };

  const { error: upsertError } = await supabase
    .from("exam_results")
    .upsert(payload, { onConflict: "attempt_id" });
  if (upsertError) throw upsertError;

  return { ok: true, released };
}
