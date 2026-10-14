/**
 * Exam attempt data access — SERVER-ONLY (prompts 22–23).
 *
 * Every function takes the trusted `institutionId` (resolved from the session
 * via `AuthPrincipal`, NEVER a request body) AND the `studentId` resolved from
 * that session's own roster row, and applies BOTH as hard filters — the same
 * tenant-isolation + ownership contract as lib/data/exams.ts (AGENTS.md §5).
 * The service-role client bypasses RLS, so these `.eq("institution_id", …)`
 * and `.eq("student_id", …)` filters, plus the ownership check on every
 * attempt read, are the ONLY thing isolating one student's attempt from
 * another's and one tenant from another. A crafted attempt id from a different
 * student or school resolves to `null` (never a per-case leak).
 *
 * WHAT THE CLIENT CAN AND CANNOT TOUCH
 * The frozen snapshot rows carry the answer key (`correct_option_index`) and
 * explanations; the presentation this module returns STRIPS both — a student
 * sees question text and shuffled option TEXT only (AGENTS.md §6). The client
 * sends back a `snapshotId` and a DISPLAY option index; this module maps it to
 * the canonical index (undoing the shuffle via the attempt's stored order) and
 * validates it against the real option count before persisting. No score,
 * correct-answer flag, or timestamp is ever taken from the client.
 *
 * SERVER-AUTHORITATIVE TIMING
 * `started_at`/`expires_at` are stamped here from the server clock at start and
 * read back for every save/submit; the pure rules in lib/attempts.ts judge a
 * write against the STORED deadline, so a refresh or a stale tab cannot extend
 * an attempt or save after it expired.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import { getStudentExamView } from "@/lib/data/exams";
import { gradeAttempt } from "@/lib/data/grading";
import { studentExamStartGate } from "@/lib/exams";
import {
  attemptSubmitDecision,
  buildOptionOrder,
  canAcceptAnswer,
  canonicalToDisplay,
  computeAttemptExpiresAt,
  displayToCanonical,
  isAttemptExpired,
  shuffledCopy,
  type AttemptAnswerPresentation,
  type AttemptQuestionPresentation,
  type AttemptState,
  type ExamAttemptStatus,
  type RandomSource,
} from "@/lib/attempts";

// --- Row shapes --------------------------------------------------------------

type AttemptRow = {
  id: string;
  exam_id: string;
  student_id: string;
  institution_id: string;
  attempt_number: number;
  status: string;
  started_at: string;
  expires_at: string;
  submitted_at: string | null;
  question_order: unknown;
  option_orders: unknown;
};

type SnapshotRow = {
  id: string;
  position: number;
  marks: number;
  question_text: string;
  difficulty: string;
  options: unknown;
  correct_option_index: number;
};

type AnswerRow = {
  snapshot_id: string;
  selected_option_index: number | null;
  marked_for_review: boolean;
};

function toOptions(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toOptionOrders(value: unknown): Record<string, number[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(raw)) {
      out[key] = raw.filter(
        (n): n is number => typeof n === "number" && Number.isInteger(n),
      );
    }
  }
  return out;
}

function toAttemptStatus(value: string): ExamAttemptStatus | null {
  return value === "in_progress" || value === "submitted" || value === "expired"
    ? value
    : null;
}

/** A cryptographically-backed [0,1) source for shuffling, with a safe fallback.
 *  The shuffle order is not a secret (it is stored per attempt), but a
 *  non-deterministic source keeps two students' orders genuinely independent. */
function secureRandom(): RandomSource {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => void } };
  if (g.crypto?.getRandomValues) {
    return () => {
      const buffer = new Uint32Array(1);
      g.crypto!.getRandomValues!(buffer);
      return buffer[0] / 0x100_0000;
    };
  }
  return Math.random;
}

// --- Result types ------------------------------------------------------------

export type AttemptStartResult =
  | { ok: true; state: AttemptState; resumed: boolean }
  | { ok: false; reason: "notFound" | "locked" | "unavailable"; message: string };

export type AttemptMutationResult =
  | { ok: true; state?: AttemptState }
  | { ok: false; reason: "notFound" | "locked" | "expired" | "invalid"; message: string };

// --- Shared read: load an attempt the student owns ---------------------------

async function loadOwnedAttempt(
  supabase: ReturnType<typeof createAdminClient>,
  institutionId: string,
  studentId: string,
  attemptId: string,
): Promise<AttemptRow | null> {
  const { data, error } = await supabase
    .from("exam_attempts")
    .select(
      "id, exam_id, student_id, institution_id, attempt_number, status, started_at, expires_at, submitted_at, question_order, option_orders",
    )
    .eq("id", attemptId)
    .eq("institution_id", institutionId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (error) throw error;
  return (data as AttemptRow | null) ?? null;
}

/** Flip a stale in-progress attempt to `expired` on the server clock, if due.
 *  Returns the (possibly updated) status. This is the auto-submission-on-expiry
 *  hook the interface relies on: any read/save/submit of a timed-out attempt
 *  settles it to `expired` exactly once, so the timer is authoritative even if
 *  the student never clicks submit. */
async function settleExpiry(
  supabase: ReturnType<typeof createAdminClient>,
  attempt: AttemptRow,
  nowMs: number,
): Promise<ExamAttemptStatus> {
  const status = toAttemptStatus(attempt.status);
  if (status !== "in_progress") return status ?? "in_progress";
  const expiresMs = new Date(attempt.expires_at).getTime();
  if (!isAttemptExpired(expiresMs, nowMs)) return "in_progress";
  const { error } = await supabase
    .from("exam_attempts")
    .update({ status: "expired" })
    .eq("id", attempt.id)
    .eq("institution_id", attempt.institution_id)
    .eq("status", "in_progress");
  if (error) throw error;
  attempt.status = "expired";
  // The attempt just became terminal — grade it. Best-effort here (this runs
  // on fire-and-forget settle paths too): a grading hiccup must never break an
  // autosave/read, and the result is reconciled idempotently on the next
  // submit/sync (prompt 24).
  try {
    await gradeAttempt(attempt.institution_id, attempt.id);
  } catch {
    // Swallowed intentionally — the durable grade is retried by submit/sync.
  }
  return "expired";
}

// --- Presentation builder ----------------------------------------------------

/** Build the client-safe view of one attempt: questions in stored display
 *  order with shuffled option TEXT (never the key), plus saved answers mapped
 *  back to display slots. Shared by start, resume, and recovery reads. */
async function buildAttemptState(
  supabase: ReturnType<typeof createAdminClient>,
  attempt: AttemptRow,
  examTitle: string,
  durationMinutes: number,
  nowMs: number,
): Promise<AttemptState> {
  const order = toStringArray(attempt.question_order);
  const optionOrders = toOptionOrders(attempt.option_orders);

  const { data: snapshotRows, error: snapshotError } = await supabase
    .from("exam_question_snapshots")
    .select("id, position, marks, question_text, difficulty, options, correct_option_index")
    .eq("exam_id", attempt.exam_id)
    .eq("institution_id", attempt.institution_id);
  if (snapshotError) throw snapshotError;

  const byId = new Map<string, SnapshotRow>(
    (snapshotRows ?? []).map((row) => [row.id as string, row as SnapshotRow]),
  );

  const questions: AttemptQuestionPresentation[] = [];
  order.forEach((snapshotId, index) => {
    const snapshot = byId.get(snapshotId);
    if (!snapshot) return; // a vanished snapshot is skipped, never fabricated
    const canonicalOptions = toOptions(snapshot.options);
    const optionOrder = optionOrders[snapshotId] ?? canonicalOptions.map((_, i) => i);
    const options = optionOrder
      .map((canonicalIndex, displayIndex) => ({
        displayIndex,
        text: canonicalOptions[canonicalIndex] ?? "",
      }))
      .filter((option) => option.text.length > 0);
    questions.push({
      snapshotId,
      position: index + 1,
      questionText: snapshot.question_text,
      options,
      marks: snapshot.marks,
      difficulty: snapshot.difficulty,
    });
  });

  const { data: answerRows, error: answerError } = await supabase
    .from("exam_attempt_answers")
    .select("snapshot_id, selected_option_index, marked_for_review")
    .eq("attempt_id", attempt.id)
    .eq("institution_id", attempt.institution_id);
  if (answerError) throw answerError;

  const answers: AttemptAnswerPresentation[] = [];
  for (const row of (answerRows ?? []) as AnswerRow[]) {
    const optionOrder = optionOrders[row.snapshot_id] ?? undefined;
    const display =
      row.selected_option_index === null
        ? null
        : canonicalToDisplay(optionOrder ?? [], row.selected_option_index);
    // A marked-only row still needs echoing so the review flag survives reload.
    answers.push({
      snapshotId: row.snapshot_id,
      displayIndex: display === null ? -1 : display,
      markedForReview: row.marked_for_review,
    });
  }

  const totalMarks = questions.reduce((sum, question) => sum + question.marks, 0);

  return {
    attemptId: attempt.id,
    examId: attempt.exam_id,
    examTitle,
    durationMinutes,
    status: toAttemptStatus(attempt.status) ?? "in_progress",
    startedAt: attempt.started_at,
    expiresAt: attempt.expires_at,
    serverNow: new Date(nowMs).toISOString(),
    totalQuestions: questions.length,
    totalMarks,
    questions,
    answers,
  };
}

// --- Start / resume ----------------------------------------------------------

/**
 * Begin an attempt, or RESUME the student's live one. Idempotent by design
 * (AGENTS.md §6): refreshing the exam page or reopening the tab calls this
 * again and gets the SAME in-progress attempt back — the stored `expires_at`
 * is never recomputed, so the authoritative timer does not reset.
 *
 * The gate is the SAME pure rule the instructions screen and start action use
 * (`studentExamStartGate`), but now fed with the REAL attempt count from this
 * student's history rather than the placeholder zero, so the attempt budget is
 * enforced server-side at the moment of creation.
 */
export async function startOrResumeAttempt(
  institutionId: string,
  studentId: string,
  classId: string | null,
  examId: string,
): Promise<AttemptStartResult> {
  const supabase = createAdminClient();

  const view = await getStudentExamView(institutionId, studentId, classId, examId);
  if (!view) {
    return {
      ok: false,
      reason: "notFound",
      message:
        "This exam is not assigned to you, so it cannot be opened. We never confirm whether an exam exists in another institution.",
    };
  }

  const nowMs = Date.now();

  // Count this student's attempts and find any live one, in one pass.
  const { data: attemptRows, error: attemptsError } = await supabase
    .from("exam_attempts")
    .select(
      "id, exam_id, student_id, institution_id, attempt_number, status, started_at, expires_at, submitted_at, question_order, option_orders",
    )
    .eq("exam_id", examId)
    .eq("student_id", studentId)
    .eq("institution_id", institutionId)
    .order("attempt_number", { ascending: true });
  if (attemptsError) throw attemptsError;

  const attempts = (attemptRows ?? []) as AttemptRow[];
  let liveAttempt: AttemptRow | null = null;
  let usedAttempts = 0;
  for (const attempt of attempts) {
    const status = toAttemptStatus(attempt.status);
    if (status === "in_progress" && !isAttemptExpired(new Date(attempt.expires_at).getTime(), nowMs)) {
      // A still-live attempt wins — but only the newest such row, in case a
      // prior bug ever left two; older ones are settled to expired below.
      if (!liveAttempt) liveAttempt = attempt;
      else void settleExpiry(supabase, attempt, nowMs);
    } else {
      // Anything terminal (or an in-progress row past its deadline) counts
      // against the budget. Settle a timed-out row so its state is honest.
      if (status === "in_progress") void settleExpiry(supabase, attempt, nowMs);
      usedAttempts += 1;
    }
  }
  if (liveAttempt) usedAttempts = Math.max(0, attempts.length - 1);

  if (liveAttempt) {
    const state = await buildAttemptState(
      supabase,
      liveAttempt,
      view.exam.title,
      view.exam.durationMinutes,
      nowMs,
    );
    return { ok: true, state, resumed: true };
  }

  const gate = studentExamStartGate({
    status: view.exam.status,
    assignmentActive: true,
    startsAt: view.exam.startsAt,
    endsAt: view.exam.endsAt,
    attemptsUsed: usedAttempts,
    maxAttempts: view.exam.maxAttempts,
    now: new Date(nowMs),
  });
  if (!gate.allowed) {
    return { ok: false, reason: "locked", message: gate.message };
  }

  // Read the frozen content. A published exam always has snapshots; a missing
  // set means the exam was never really deliverable, so fail closed.
  const { data: snapshotRows, error: snapshotError } = await supabase
    .from("exam_question_snapshots")
    .select("id, position, marks")
    .eq("exam_id", examId)
    .eq("institution_id", institutionId)
    .order("position", { ascending: true });
  if (snapshotError) throw snapshotError;
  const snapshots = (snapshotRows ?? []).map((row) => row as { id: string });
  if (snapshots.length < 1) {
    return {
      ok: false,
      reason: "unavailable",
      message: "This exam has no questions available to deliver yet.",
    };
  }

  const rng = secureRandom();
  const ordered = shuffledCopy(snapshots, view.exam.shuffleQuestions, rng);
  const questionOrder = ordered.map((snapshot) => snapshot.id);

  // Option orders need each question's option COUNT. Fetch them once.
  const { data: optionRows, error: optionError } = await supabase
    .from("exam_question_snapshots")
    .select("id, options")
    .eq("exam_id", examId)
    .eq("institution_id", institutionId);
  if (optionError) throw optionError;
  const optionOrders: Record<string, number[]> = {};
  for (const row of (optionRows ?? []) as { id: string; options: unknown }[]) {
    optionOrders[row.id] = buildOptionOrder(toOptions(row.options).length, view.exam.shuffleOptions, rng);
  }

  const startedAt = new Date(nowMs);
  const examEndsAtMs = view.exam.endsAt ? new Date(view.exam.endsAt).getTime() : null;
  const expiresAtMs = computeAttemptExpiresAt({
    startedAtMs: nowMs,
    durationMinutes: view.exam.durationMinutes,
    examEndsAtMs: Number.isFinite(examEndsAtMs ?? NaN) ? examEndsAtMs : null,
  });

  const insertPayload = {
    exam_id: examId,
    student_id: studentId,
    institution_id: institutionId,
    attempt_number: usedAttempts + 1,
    status: "in_progress" as const,
    started_at: startedAt.toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    question_order: questionOrder,
    option_orders: optionOrders,
  };

  const { data: inserted, error: insertError } = await supabase
    .from("exam_attempts")
    .insert(insertPayload)
    .select(
      "id, exam_id, student_id, institution_id, attempt_number, status, started_at, expires_at, submitted_at, question_order, option_orders",
    )
    .maybeSingle();

  if (insertError) {
    // A unique collision means a concurrent start already created this
    // attempt number — recover by resuming the live row rather than erroring.
    const isCollision = insertError.code === "23505" || /duplicate key/i.test(insertError.message);
    if (!isCollision) throw insertError;
    const { data: rows } = await supabase
      .from("exam_attempts")
      .select(
        "id, exam_id, student_id, institution_id, attempt_number, status, started_at, expires_at, submitted_at, question_order, option_orders",
      )
      .eq("exam_id", examId)
      .eq("student_id", studentId)
      .eq("institution_id", institutionId)
      .eq("status", "in_progress")
      .order("attempt_number", { ascending: false })
      .limit(1);
    const winner = (rows ?? [])[0] as AttemptRow | undefined;
    if (winner) {
      const state = await buildAttemptState(
        supabase,
        winner,
        view.exam.title,
        view.exam.durationMinutes,
        Date.now(),
      );
      return { ok: true, state, resumed: true };
    }
    return {
      ok: false,
      reason: "unavailable",
      message: "We couldn't start your attempt right now. Please reload and try again.",
    };
  }

  const state = await buildAttemptState(
    supabase,
    inserted as AttemptRow,
    view.exam.title,
    view.exam.durationMinutes,
    Date.now(),
  );
  return { ok: true, state, resumed: false };
}

// --- Recovery read -----------------------------------------------------------

/**
 * Load the current state of a specific attempt the student owns, for refresh /
 * reconnect recovery without creating anything. A timed-out in-progress row is
 * settled to `expired` here so the interface learns the truth on reconnect.
 */
export async function getAttemptState(
  institutionId: string,
  studentId: string,
  attemptId: string,
): Promise<AttemptState | null> {
  const supabase = createAdminClient();
  const attempt = await loadOwnedAttempt(supabase, institutionId, studentId, attemptId);
  if (!attempt) return null;

  const nowMs = Date.now();
  await settleExpiry(supabase, attempt, nowMs);

  // Reconcile grading on any recovery/sync read of a terminal attempt (prompt
  // 24): `gradeAttempt` is idempotent, so this re-runs a grade a prior submit
  // may have failed to persist and never duplicates one. Best-effort so the
  // authoritative state read always returns even if grading is briefly down.
  if (attempt.status !== "in_progress") {
    try {
      await gradeAttempt(institutionId, attempt.id);
    } catch {
      // Swallowed — the read still reflects the locked attempt; the grade
      // retries on the next sync/submit.
    }
  }

  // Exam title/duration come from the exam row (tenant-scoped).
  const { data: exam, error: examError } = await supabase
    .from("exams")
    .select("title, duration_minutes")
    .eq("id", attempt.exam_id)
    .eq("institution_id", institutionId)
    .maybeSingle();
  if (examError) throw examError;

  return buildAttemptState(
    supabase,
    attempt,
    (exam as { title: string; duration_minutes: number } | null)?.title ?? "Exam",
    (exam as { title: string; duration_minutes: number } | null)?.duration_minutes ?? 0,
    nowMs,
  );
}

// --- Answer save -------------------------------------------------------------

/**
 * Autosave one question's state. The client sends the DISPLAY option index (or
 * `null` for "no selection yet") and the marked-for-review flag; this maps the
 * index to the frozen snapshot's canonical index via the attempt's stored
 * option order, validates it against the real option count, and UPSERTs on the
 * (attempt, snapshot) key so a retried save is idempotent.
 *
 * Refused (fail closed) when the attempt is not owned by this student, is not
 * `in_progress`, or is past its stored deadline (`canAcceptAnswer`) — a stale
 * tab cannot write after submit or expiry (AGENTS.md §6).
 */
export async function saveAttemptAnswer(
  institutionId: string,
  studentId: string,
  attemptId: string,
  snapshotId: string,
  displayIndex: number | null,
  markedForReview: boolean,
): Promise<AttemptMutationResult> {
  const supabase = createAdminClient();
  const attempt = await loadOwnedAttempt(supabase, institutionId, studentId, attemptId);
  if (!attempt) {
    return { ok: false, reason: "notFound", message: "This attempt could not be found." };
  }

  const nowMs = Date.now();
  const status = await settleExpiry(supabase, attempt, nowMs);
  if (
    !canAcceptAnswer({
      status,
      expiresAtMs: new Date(attempt.expires_at).getTime(),
      nowMs,
    })
  ) {
    return {
      ok: false,
      reason: status === "expired" ? "expired" : "locked",
      message:
        status === "expired"
          ? "Your time is up — answers can no longer be changed."
          : "This attempt has already been submitted, so answers can no longer be changed.",
    };
  }

  // The snapshot must belong to THIS attempt's exam (not just the tenant), and
  // we need its real option count to validate the mapped canonical index.
  const { data: snapshot, error: snapshotError } = await supabase
    .from("exam_question_snapshots")
    .select("id, options")
    .eq("id", snapshotId)
    .eq("exam_id", attempt.exam_id)
    .eq("institution_id", institutionId)
    .maybeSingle();
  if (snapshotError) throw snapshotError;
  if (!snapshot) {
    return { ok: false, reason: "invalid", message: "That question is not part of this exam." };
  }

  const optionOrders = toOptionOrders(attempt.option_orders);
  const optionOrder =
    optionOrders[snapshotId] ?? toOptions((snapshot as { options: unknown }).options).map((_, i) => i);

  let canonicalIndex: number | null = null;
  if (displayIndex !== null) {
    const mapped = displayToCanonical(optionOrder, displayIndex);
    if (mapped === null || mapped >= optionOrder.length) {
      return { ok: false, reason: "invalid", message: "That answer is not a valid option." };
    }
    canonicalIndex = mapped;
  }

  // No answer and no review flag → remove the row (keeps "answered" honest).
  if (canonicalIndex === null && !markedForReview) {
    const { error: deleteError } = await supabase
      .from("exam_attempt_answers")
      .delete()
      .eq("attempt_id", attemptId)
      .eq("snapshot_id", snapshotId)
      .eq("institution_id", institutionId);
    if (deleteError) throw deleteError;
    return { ok: true };
  }

  const { error: upsertError } = await supabase
    .from("exam_attempt_answers")
    .upsert(
      {
        attempt_id: attemptId,
        snapshot_id: snapshotId,
        institution_id: institutionId,
        selected_option_index: canonicalIndex,
        marked_for_review: markedForReview,
      },
      { onConflict: "attempt_id,snapshot_id" },
    );
  if (upsertError) throw upsertError;
  return { ok: true };
}

// --- Submit (idempotent) -----------------------------------------------------

/**
 * Explicit submit, or the automatic submit-on-expiry the interface triggers
 * when the countdown reaches zero. Idempotent (AGENTS.md §6): a double-click,
 * a retry after a lost response, and a second tab all resolve to the SAME
 * terminal state, and once locked no further answer write is honoured. An
 * attempt whose deadline passed is recorded `expired`, not `submitted`, so the
 * reason it closed stays honest for grading (prompt 24) and reporting.
 */
export async function submitAttempt(
  institutionId: string,
  studentId: string,
  attemptId: string,
): Promise<AttemptMutationResult> {
  const supabase = createAdminClient();
  const attempt = await loadOwnedAttempt(supabase, institutionId, studentId, attemptId);
  if (!attempt) {
    return { ok: false, reason: "notFound", message: "This attempt could not be found." };
  }

  const nowMs = Date.now();
  const status = toAttemptStatus(attempt.status) ?? "in_progress";
  const decision = attemptSubmitDecision({
    status,
    expiresAtMs: new Date(attempt.expires_at).getTime(),
    nowMs,
  });

  if (decision.outcome === "already_submitted" || decision.outcome === "already_expired") {
    // Idempotent success: already terminal, nothing to rewrite — but ensure the
    // result exists (a prior submit may have failed to grade it). Idempotent.
    try {
      await gradeAttempt(institutionId, attemptId);
    } catch {
      // Swallowed — reconciled on the next sync/read.
    }
    return { ok: true };
  }

  const nextStatus = decision.next; // 'submitted' | 'expired'
  const { error } = await supabase
    .from("exam_attempts")
    .update({
      status: nextStatus,
      submitted_at: new Date(nowMs).toISOString(),
    })
    .eq("id", attemptId)
    .eq("institution_id", institutionId)
    .eq("student_id", studentId)
    .eq("status", "in_progress"); // guard: only ever move a live attempt
  if (error) throw error;

  attempt.status = nextStatus;

  // The attempt just locked (submitted or auto-expired) — grade it now, while
  // the answer set is final (prompt 24). Best-effort so a transient grading
  // fault never fails an otherwise-successful submit; the sync read and a
  // retried submit both reconcile it idempotently.
  try {
    await gradeAttempt(institutionId, attemptId);
  } catch {
    // Swallowed — the durable grade is retried on the next sync/submit.
  }

  const { data: exam } = await supabase
    .from("exams")
    .select("title, duration_minutes")
    .eq("id", attempt.exam_id)
    .eq("institution_id", institutionId)
    .maybeSingle();
  const state = await buildAttemptState(
    supabase,
    attempt,
    (exam as { title: string; duration_minutes: number } | null)?.title ?? "Exam",
    (exam as { title: string; duration_minutes: number } | null)?.duration_minutes ?? 0,
    nowMs,
  );
  return { ok: true, state };
}
