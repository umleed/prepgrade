/**
 * Exam grading contract & result rules — pure, dependency-free, unit-testable.
 *
 * WHAT THIS AREA IS FOR (prompt 24)
 * The grading engine turns a LOCKED attempt into a durable result: it compares
 * each recorded answer against the frozen snapshot's answer key and produces
 * the score, the count buckets, the percentage, the time used, and a
 * subject-level breakdown. These are the exact rules the server applies
 * (lib/data/grading.ts) and the ones the browser would mirror for an instant
 * preview — kept as one pure source so a shown result and an authoritative one
 * can never drift (AGENTS.md §6).
 *
 * THE SERVER IS AUTHORITATIVE FOR SCORE (AGENTS.md §6)
 * Nothing here accepts a client-supplied score, percentage, grade, `is_correct`,
 * or marks-awarded value. The ONLY inputs are trusted server facts read from
 * the database: the immutable per-question `marks` and `correct_option_index`
 * (the frozen snapshot, 0011), and the CANONICAL option index the student
 * actually chose (already un-shuffled by the delivery layer, 0013 — so grading
 * compares canonical values and a randomised option can never desync the key).
 * A question is correct iff its chosen canonical index equals the frozen key.
 *
 * IDEMPOTENT & FINALISATION-SAFE
 * Grading is deterministic: the same locked inputs always yield the same
 * numbers, so a retried grade rewrites the identical result rather than
 * duplicating or drifting it (the `exam_results` row is keyed by attempt). This
 * module never mutates its inputs and never infers data it was not given — a
 * missing/invalid subject id simply drops out of the breakdown, it is never
 * fabricated (AGENTS.md §7).
 *
 * ANSWER KEYS STAY CONCEALED UNTIL RELEASE
 * `isResultReleased` encodes the exam's result-release policy so no surface
 * reveals a score — let alone a correct answer or explanation — before the
 * policy allows it (immediate / after the window / manual).
 */

// --- Grading input (all trusted server facts) --------------------------------

/**
 * One question reduced to exactly what grading needs. The caller (data layer)
 * has already resolved each recorded answer to its CANONICAL option index —
 * the shuffle undone at save time — so `selectedOptionIndex` and
 * `correctOptionIndex` live in the same coordinate space and compare directly.
 * `selectedOptionIndex` is `null` when the student left the question blank (no
 * answer row, or a review-flag-only row).
 */
export type GradingQuestion = {
  snapshotId: string;
  /** Frozen per-question marks (integer ≥ 1 in the schema; treated defensively). */
  marks: number;
  /** The frozen answer key — the canonical index that is correct. */
  correctOptionIndex: number;
  /** The canonical index the student chose, or `null` when unanswered. */
  selectedOptionIndex: number | null;
  /** The snapshot's subject id, or null/"" when it cannot be resolved. */
  subjectId: string | null;
};

// --- Grading output ----------------------------------------------------------

/** Per-subject performance, built ONLY from valid snapshot metadata. */
export type GradingSubjectStat = {
  subjectId: string;
  correct: number;
  total: number;
  score: number;
  maxScore: number;
};

/** The full computed result — the numbers a graded attempt records. */
export type GradingResult = {
  totalScore: number;
  maxScore: number;
  /** Whole hundredths (e.g. 66.67); 0 when there are no marks to divide by. */
  percentage: number;
  correctCount: number;
  incorrectCount: number;
  unansweredCount: number;
  totalQuestions: number;
  subjectBreakdown: GradingSubjectStat[];
};

/** Whether a single question was answered correctly (blank is never correct). */
export function isCorrectAnswer(question: GradingQuestion): boolean {
  return (
    question.selectedOptionIndex !== null &&
    question.selectedOptionIndex === question.correctOptionIndex
  );
}

/**
 * Round a percentage to whole hundredths. A zero/negative denominator yields
 * `0` rather than NaN/Infinity, so a degenerate (no-marks) exam still stores a
 * valid, comparable number.
 */
export function roundPercentage(score: number, max: number): number {
  if (!Number.isFinite(score) || !Number.isFinite(max) || max <= 0) return 0;
  const pct = (score / max) * 100;
  // Round to 2 decimals without floating-point drift (66.666… → 66.67).
  return Math.round((pct + Number.EPSILON) * 100) / 100;
}

/** Normalise a possibly-messy marks value to a finite, non-negative number. */
function safeMarks(marks: number): number {
  return Number.isFinite(marks) && marks > 0 ? marks : 0;
}

/**
 * Grade a set of objective questions. Every bucket is disjoint and their sum
 * equals `totalQuestions` (a schema CHECK backs this), so a partial or retried
 * grade can never double-count or drop a question. Only questions carrying a
 * real, non-empty subject id contribute to the breakdown — an unresolvable id
 * is skipped, never guessed (AGENTS.md §7).
 */
export function gradeObjectiveAnswers(
  questions: readonly GradingQuestion[],
): GradingResult {
  let totalScore = 0;
  let maxScore = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let unansweredCount = 0;

  const subjects = new Map<string, GradingSubjectStat>();

  for (const question of questions) {
    const marks = safeMarks(question.marks);
    maxScore += marks;

    const subjectKey =
      typeof question.subjectId === "string" && question.subjectId.length > 0
        ? question.subjectId
        : null;
    if (subjectKey) {
      const stat =
        subjects.get(subjectKey) ??
        { subjectId: subjectKey, correct: 0, total: 0, score: 0, maxScore: 0 };
      stat.total += 1;
      stat.maxScore += marks;
      subjects.set(subjectKey, stat);
    }

    if (question.selectedOptionIndex === null) {
      unansweredCount += 1;
    } else if (isCorrectAnswer(question)) {
      correctCount += 1;
      totalScore += marks;
      if (subjectKey) {
        const stat = subjects.get(subjectKey)!;
        stat.correct += 1;
        stat.score += marks;
      }
    } else {
      incorrectCount += 1;
    }
  }

  return {
    totalScore,
    maxScore,
    percentage: roundPercentage(totalScore, maxScore),
    correctCount,
    incorrectCount,
    unansweredCount,
    totalQuestions: questions.length,
    subjectBreakdown: [...subjects.values()],
  };
}

// --- Time used (server-clock only) -------------------------------------------

/**
 * Whole seconds the student used, from the server-stamped start to the terminal
 * stamp, clamped to `[0, maxSeconds]`. `maxSeconds` is the attempt window
 * (`expiresAt − startedAt`), so even a lagged terminal timestamp (a submit that
 * landed after the deadline) never reports more time than was ever available.
 * Invalid/unordered timestamps collapse to `0`, never a negative duration.
 */
export function computeTimeUsedSeconds(input: {
  startedAtMs: number;
  endedAtMs: number;
  maxSeconds: number | null;
}): number {
  if (
    !Number.isFinite(input.startedAtMs) ||
    !Number.isFinite(input.endedAtMs)
  ) {
    return 0;
  }
  const elapsedMs = input.endedAtMs - input.startedAtMs;
  if (elapsedMs <= 0) return 0;
  const seconds = Math.floor(elapsedMs / 1000);
  if (input.maxSeconds === null || !Number.isFinite(input.maxSeconds)) {
    return seconds;
  }
  return Math.max(0, Math.min(seconds, Math.floor(input.maxSeconds)));
}

// --- Result release policy (0011 results_release) ----------------------------

export type ExamResultReleaseInput = {
  /** The exam's frozen policy (from `exams.results_release`). */
  resultsRelease: "immediate" | "after_window" | "manual";
  /** Epoch ms the result was computed on the server, or null if not graded. */
  gradedAtMs: number | null;
  /** Epoch ms the availability window closed, or null when unscheduled. */
  windowEndsAtMs: number | null;
  /** Epoch ms an explicit release stamp was set (manual path), or null. */
  releasedAtMs: number | null;
  nowMs?: number;
};

/**
 * Whether a graded result may be shown to the student (and, by the same gate,
 * whether its correct answers/explanations may be revealed). One rule the
 * grading layer and the result views (prompt 25) share so what is stored as
 * released and what is rendered can never disagree:
 *   * `manual` — only once an explicit `released_at` stamp exists;
 *   * `after_window` — once the availability window has closed (an unscheduled
 *     exam has no window to wait for, so it falls back to released-on-grade);
 *   * `immediate` — as soon as it has been graded.
 * An ungraded result (no `gradedAt`) is never visible under any policy.
 */
export function isResultReleased(input: ExamResultReleaseInput): boolean {
  if (input.gradedAtMs === null) return false;
  const now = input.nowMs ?? Date.now();

  if (input.resultsRelease === "manual") {
    return input.releasedAtMs !== null;
  }
  if (input.resultsRelease === "immediate") {
    return true;
  }
  // after_window
  if (input.windowEndsAtMs === null || !Number.isFinite(input.windowEndsAtMs)) {
    return true; // no window to hold it back
  }
  return now > input.windowEndsAtMs;
}

/**
 * Whether a correct answer / explanation may be exposed for a given result.
 * Kept as its own named rule so callers state intent explicitly: it is exactly
 * the release gate, but a caller may still pass the score without the key.
 */
export function canRevealAnswers(input: ExamResultReleaseInput): boolean {
  return isResultReleased(input);
}
