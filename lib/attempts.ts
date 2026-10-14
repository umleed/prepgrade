/**
 * Exam attempt contract & delivery rules — pure, dependency-free, unit-testable.
 *
 * WHAT THIS AREA IS FOR (prompts 22–23)
 * An attempt is one student's single sitting of a published exam. The CBT
 * interface (prompt 22) renders it; the attempt state machine (prompt 23)
 * owns its lifecycle. This module is the SINGLE source of the timing,
 * randomisation-mapping, and transition rules both the browser (instant
 * feedback: countdown, navigator colours) and the server (authoritative:
 * accept/refuse a save, expire, submit) share — so what a student is shown
 * and what the server would actually honour can never drift (AGENTS.md §6).
 *
 * THE SERVER IS AUTHORITATIVE (AGENTS.md §6)
 * `startedAt` / `expiresAt` are stamped by the server from its own clock at
 * start; the client only ever DISPLAYS the countdown this layer computes from
 * those trusted values. Refreshing or losing the network never resets the
 * timer because expiry is judged against the stored `expiresAt`, not a
 * client-supplied number. A save or submit carries no score, no correct-answer
 * flag, and no timestamp the server trusts — the client supplies only a
 * question id and a display option index, which are mapped and validated here.
 *
 * RANDOMISATION PRESERVES THE ANSWER KEY (AGENTS.md §6)
 * When an exam shuffles questions or options, the display order is a
 * permutation generated ONCE at start and persisted on the attempt. This layer
 * maps a displayed option index back to the frozen snapshot's canonical index
 * (the one `correct_option_index` refers to), so grading (prompt 24) compares
 * canonical values and a shuffle can never desync the answer key. The correct
 * answer is never part of any structure this module returns to the client.
 *
 * GRADING IS OUT OF SCOPE HERE (prompt 24)
 * Submitting LOCKS an attempt (no further answers accepted) and records that
 * the student finished; it does NOT compute a score. Scores, percentages, and
 * result release are the grading engine's job, kept server-side until release
 * is permitted. This module only decides whether a transition is legal.
 */

// --- Attempt lifecycle -------------------------------------------------------

/**
 * Stored attempt states. `NOT_STARTED` is deliberately absent: it is the
 * absence of a row, not a row with a status — an attempt materialises the
 * moment a student starts. `abandoned` (a proctored/timeout retire state) is a
 * future concern and is not claimed here, mirroring how the question bank only
 * admits types the grader can actually score (0006).
 */
export const EXAM_ATTEMPT_STATUSES = [
  "in_progress",
  "submitted",
  "expired",
] as const;
export type ExamAttemptStatus = (typeof EXAM_ATTEMPT_STATUSES)[number];

export const EXAM_ATTEMPT_STATUS_LABELS: Record<ExamAttemptStatus, string> = {
  in_progress: "In progress",
  submitted: "Submitted",
  expired: "Expired",
};

export function isExamAttemptStatus(value: unknown): value is ExamAttemptStatus {
  return (
    typeof value === "string" &&
    (EXAM_ATTEMPT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The transitions the delivery layer performs. Forward-only and terminal-safe:
 * once an attempt is `submitted` or `expired` it is history — no answer write
 * or repeat submit may reopen it. `in_progress → expired` happens when the
 * server clock passes `expiresAt` before an explicit submit; `in_progress →
 * submitted` is the student finishing. A submit on an already-terminal attempt
 * is an idempotent no-op (see `attemptSubmitDecision`), never an error.
 */
const ATTEMPT_TRANSITIONS: Record<ExamAttemptStatus, readonly ExamAttemptStatus[]> = {
  in_progress: ["submitted", "expired"],
  submitted: [],
  expired: [],
};

export function canTransitionAttempt(
  from: ExamAttemptStatus,
  to: ExamAttemptStatus,
): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

// --- Timing (server-stamped, client-displayed) -------------------------------

/**
 * The authoritative deadline for an attempt. It is the sooner of:
 *   * the per-attempt duration (`startedAt + durationMinutes`), and
 *   * the exam's own availability-window end (`examEndsAtMs`), when set.
 *
 * The window cap is what makes "the server is authoritative for expiry" true:
 * a student who starts one minute before the window closes does not get a full
 * extra hour, and no client manipulation of the countdown can outrun the
 * stored `expiresAt`. An unset/invalid window bound never shortens the attempt
 * on its own (mirrors how the exam window rules skip unparseable bounds).
 */
export function computeAttemptExpiresAt(input: {
  startedAtMs: number;
  durationMinutes: number;
  examEndsAtMs: number | null;
}): number {
  const durationMs =
    Number.isFinite(input.durationMinutes) && input.durationMinutes > 0
      ? Math.floor(input.durationMinutes) * 60_000
      : 0;
  let expires = input.startedAtMs + durationMs;

  if (input.examEndsAtMs !== null && Number.isFinite(input.examEndsAtMs)) {
    // Cap at the window end, but never before the attempt started (a window
    // that closed in the same instant still yields a valid, already-expired
    // deadline rather than a negative duration).
    expires = Math.max(input.startedAtMs, Math.min(expires, input.examEndsAtMs));
  }
  return expires;
}

/** Whole milliseconds left, clamped at zero so a countdown never goes negative. */
export function attemptTimeRemainingMs(
  expiresAtMs: number,
  nowMs: number = Date.now(),
): number {
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, expiresAtMs - nowMs);
}

export function isAttemptExpired(expiresAtMs: number, nowMs: number = Date.now()): boolean {
  if (!Number.isFinite(expiresAtMs)) return false;
  return nowMs >= expiresAtMs;
}

/**
 * Format a millisecond span as the CBT countdown's `M:SS` (or `H:MM:SS` past
 * an hour). Pure and shared so the header timer and any test agree on the
 * exact rendering; rounds DOWN (floor) so the last second of an attempt reads
 * `0:01` before `0:00`, never a premature `0:00`.
 */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

// --- Save gating -------------------------------------------------------------

/**
 * Whether an answer write may be accepted. True only while the attempt is
 * genuinely open on the SERVER's clock: still `in_progress` AND not past
 * `expiresAt`. A submitted or expired attempt is locked (AGENTS.md §6), and a
 * client that kept a stale tab open cannot save after the deadline — the
 * authoritative check is the stored `expiresAt`, not the client's timer.
 */
export function canAcceptAnswer(input: {
  status: ExamAttemptStatus;
  expiresAtMs: number;
  nowMs?: number;
}): boolean {
  if (input.status !== "in_progress") return false;
  return !isAttemptExpired(input.expiresAtMs, input.nowMs ?? Date.now());
}

// --- Submit decision (idempotent) --------------------------------------------

export type AttemptSubmitDecision =
  | { outcome: "submitted"; next: "submitted" }
  | { outcome: "expired"; next: "expired" }
  | { outcome: "already_submitted" }
  | { outcome: "already_expired" };

/**
 * What a submit request resolves to, judged from the attempt's CURRENT stored
 * status and the server clock. Idempotency is the whole point (AGENTS.md §6):
 * a double-click, a retried request after a lost response, and a second tab
 * all land on the same terminal state without rewriting history.
 *   * already `submitted` / `expired` → no-op, reported as such;
 *   * in_progress but past the deadline → the attempt expired, so it is
 *     recorded `expired` (auto-submission on server-verified expiry), NOT a
 *     fresh `submitted`;
 *   * in_progress with time left → `submitted`.
 */
export function attemptSubmitDecision(input: {
  status: ExamAttemptStatus;
  expiresAtMs: number;
  nowMs?: number;
}): AttemptSubmitDecision {
  const now = input.nowMs ?? Date.now();
  if (input.status === "submitted") return { outcome: "already_submitted" };
  if (input.status === "expired") return { outcome: "already_expired" };
  if (isAttemptExpired(input.expiresAtMs, now)) {
    return { outcome: "expired", next: "expired" };
  }
  return { outcome: "submitted", next: "submitted" };
}

// --- Randomisation: order + answer-key mapping -------------------------------

/** A minimal, injectable random source in [0, 1). The data layer supplies a
 *  crypto-backed one; tests pass a deterministic stub. Keeping it a parameter
 *  is what makes the shuffle helpers pure and reproducible. */
export type RandomSource = () => number;

/**
 * Fisher–Yates over a COPY, driven by the injected `rng`. Never mutates the
 * input, and with an identity (`shuffle === false`) returns a plain copy so
 * the caller always gets a fresh array it may persist.
 */
export function shuffledCopy<T>(
  items: readonly T[],
  shuffle: boolean,
  rng: RandomSource,
): T[] {
  const result = [...items];
  if (!shuffle) return result;
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    if (j > i) continue; // guard a misbehaving rng from an out-of-range swap
    const swap = result[i];
    result[i] = result[j];
    result[j] = swap;
  }
  return result;
}

/**
 * The canonical option index shown at each DISPLAY slot. `optionOrder[d]` is
 * the snapshot's original index for display slot `d`. Without shuffling it is
 * the identity `[0, 1, … n-1]`. Persisted once at start so recovery, display,
 * and grading all agree on the same permutation.
 */
export function buildOptionOrder(optionCount: number, shuffle: boolean, rng: RandomSource): number[] {
  const identity = Array.from({ length: Math.max(0, optionCount) }, (_, index) => index);
  return shuffledCopy(identity, shuffle, rng);
}

/**
 * Map a student's DISPLAY selection to the frozen snapshot's canonical index —
 * the value that is actually stored and later graded. Returns `null` for an
 * out-of-range or non-integer display index so the caller can refuse the write
 * rather than store a bogus answer. This is the single place the shuffle is
 * undone, which is why a randomised option can never corrupt the key.
 */
export function displayToCanonical(
  optionOrder: readonly number[],
  displayIndex: number,
): number | null {
  if (!Number.isInteger(displayIndex) || displayIndex < 0) return null;
  if (displayIndex >= optionOrder.length) return null;
  const canonical = optionOrder[displayIndex];
  return Number.isInteger(canonical) ? canonical : null;
}

/** The inverse: which DISPLAY slot shows a stored canonical index (for restoring
 *  a saved selection on recovery). `null` when the canonical value is absent. */
export function canonicalToDisplay(
  optionOrder: readonly number[],
  canonicalIndex: number,
): number | null {
  if (!Number.isInteger(canonicalIndex)) return null;
  const display = optionOrder.indexOf(canonicalIndex);
  return display === -1 ? null : display;
}

// --- Navigator state ---------------------------------------------------------

/**
 * The per-question state the navigator renders. Derived, never stored: a
 * question is "answered" iff a selection exists, and may additionally be
 * "marked for review". `current` is the slot the student is viewing. Colour
 * precedence (current > flagged > answered > unanswered) lives in the view;
 * this only reports the facts so the header progress count and the grid can
 * never disagree about how many are answered.
 */
export type AttemptQuestionNavState = {
  answered: boolean;
  markedForReview: boolean;
};

export function attemptQuestionNavState(
  hasAnswer: boolean,
  markedForReview: boolean,
): AttemptQuestionNavState {
  return { answered: hasAnswer, markedForReview };
}

/** Count of answered questions across a snapshot of per-question state — the
 *  one source for the "X of Y answered" progress line. */
export function countAnswered(states: ReadonlyMap<string, AttemptQuestionNavState>): number {
  let answered = 0;
  for (const state of states.values()) if (state.answered) answered += 1;
  return answered;
}

// --- Client-facing presentation types ----------------------------------------
// None of these carry `correctOptionIndex`, the answer key, or an explanation —
// those stay server-side until grading/result release (prompts 24–25).

/** One option as the CBT interface sees it: a display slot and its text. */
export type AttemptOptionPresentation = {
  displayIndex: number;
  text: string;
};

/** One question rendered for the attempt. `snapshotId` is the id the student
 *  answers against (frozen content), and options are already permuted. */
export type AttemptQuestionPresentation = {
  snapshotId: string;
  position: number;
  questionText: string;
  options: AttemptOptionPresentation[];
  marks: number;
  difficulty: string;
};

/** A saved answer echoed back for recovery: the DISPLAY selection to restore,
 *  already mapped from the stored canonical index. */
export type AttemptAnswerPresentation = {
  snapshotId: string;
  displayIndex: number;
  markedForReview: boolean;
};

/** The full payload the CBT interface boots from (start or resume). */
export type AttemptState = {
  attemptId: string;
  examId: string;
  examTitle: string;
  durationMinutes: number;
  status: ExamAttemptStatus;
  startedAt: string;
  expiresAt: string;
  /** Server "now" at read time, so the client can seed its countdown without
   *  trusting its own clock for the first paint. */
  serverNow: string;
  totalQuestions: number;
  totalMarks: number;
  questions: AttemptQuestionPresentation[];
  answers: AttemptAnswerPresentation[];
};

/**
 * Whether the interface should be in a read-only/locked mode. The client uses
 * this to stop accepting input the instant it learns the attempt is no longer
 * `in_progress` (submitted elsewhere, or expired server-side); the server
 * independently refuses any save regardless (`canAcceptAnswer`).
 */
export function attemptIsLocked(status: ExamAttemptStatus): boolean {
  return status !== "in_progress";
}
