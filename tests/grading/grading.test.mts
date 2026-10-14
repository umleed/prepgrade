/**
 * Grading engine tests — prompt 24 (pure contract layer).
 *
 * These cover the exact rules the server grades a locked attempt with, so a
 * shown score and an authoritative one can never drift (AGENTS.md §6): the
 * score/percentage/count computation from the frozen answer key, the disjoint
 * bucket partition (partial / all-correct / all-wrong / unanswered), the
 * randomised-option integrity (grading compares CANONICAL indices so a shuffle
 * can never desync the key), decimal-friendly percentages, the time-used clamp,
 * the subject breakdown built only from valid metadata, and — above all — that
 * NO client-supplied score is ever consulted, plus the release gate that keeps
 * an answer key concealed until the policy allows it.
 *
 * The Supabase data layer (lib/data/grading.ts) is NOT exercised here — there is
 * no live DB in `npm test`. Its guarantees (the tenant + ownership filters, the
 * one-result-per-attempt idempotent UPSERT, the terminal-only grading anchor,
 * and deployed RLS) are enforced by 0014_exam_results.sql and the queries' hard
 * `.eq("institution_id", …)` filters, and are covered by the runnable
 * exam_results readiness harness against a real database.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canRevealAnswers,
  computeTimeUsedSeconds,
  gradeObjectiveAnswers,
  isCorrectAnswer,
  isResultReleased,
  roundPercentage,
  type GradingQuestion,
} from "../../lib/grading.ts";

// Helper: build a grading question with sensible defaults.
function question(overrides: Partial<GradingQuestion> = {}): GradingQuestion {
  return {
    snapshotId: overrides.snapshotId ?? "snap-1",
    marks: overrides.marks ?? 1,
    correctOptionIndex: overrides.correctOptionIndex ?? 0,
    selectedOptionIndex:
      overrides.selectedOptionIndex === undefined ? 0 : overrides.selectedOptionIndex,
    subjectId: overrides.subjectId === undefined ? null : overrides.subjectId,
  };
}

describe("isCorrectAnswer", () => {
  it("counts a matching canonical selection as correct", () => {
    assert.equal(isCorrectAnswer(question({ correctOptionIndex: 2, selectedOptionIndex: 2 })), true);
  });
  it("counts a mismatched selection as not-correct", () => {
    assert.equal(isCorrectAnswer(question({ correctOptionIndex: 2, selectedOptionIndex: 1 })), false);
  });
  it("never counts a blank as correct", () => {
    assert.equal(isCorrectAnswer(question({ selectedOptionIndex: null })), false);
  });
});

describe("gradeObjectiveAnswers — buckets partition the question set", () => {
  it("grades an all-correct paper at full marks and 100%", () => {
    const result = gradeObjectiveAnswers([
      question({ snapshotId: "a", marks: 2, correctOptionIndex: 1, selectedOptionIndex: 1 }),
      question({ snapshotId: "b", marks: 3, correctOptionIndex: 0, selectedOptionIndex: 0 }),
    ]);
    assert.equal(result.totalScore, 5);
    assert.equal(result.maxScore, 5);
    assert.equal(result.percentage, 100);
    assert.deepEqual(
      [result.correctCount, result.incorrectCount, result.unansweredCount],
      [2, 0, 0],
    );
    assert.equal(result.totalQuestions, 2);
  });

  it("grades an all-wrong paper at zero", () => {
    const result = gradeObjectiveAnswers([
      question({ snapshotId: "a", marks: 1, correctOptionIndex: 0, selectedOptionIndex: 1 }),
      question({ snapshotId: "b", marks: 1, correctOptionIndex: 2, selectedOptionIndex: 0 }),
    ]);
    assert.equal(result.totalScore, 0);
    assert.equal(result.percentage, 0);
    assert.deepEqual(
      [result.correctCount, result.incorrectCount, result.unansweredCount],
      [0, 2, 0],
    );
  });

  it("separates unanswered from incorrect in a partial paper", () => {
    const result = gradeObjectiveAnswers([
      question({ snapshotId: "a", marks: 2, correctOptionIndex: 0, selectedOptionIndex: 0 }), // correct
      question({ snapshotId: "b", marks: 2, correctOptionIndex: 0, selectedOptionIndex: 3 }), // incorrect
      question({ snapshotId: "c", marks: 2, correctOptionIndex: 0, selectedOptionIndex: null }), // blank
    ]);
    assert.equal(result.totalScore, 2);
    assert.equal(result.maxScore, 6);
    assert.equal(result.percentage, 33.33);
    assert.deepEqual(
      [result.correctCount, result.incorrectCount, result.unansweredCount],
      [1, 1, 1],
    );
    // The three buckets sum to the question count (the schema CHECK's invariant).
    assert.equal(
      result.correctCount + result.incorrectCount + result.unansweredCount,
      result.totalQuestions,
    );
  });

  it("scores by per-question marks, not a flat count", () => {
    // A heavily-weighted correct question outscores several light ones.
    const result = gradeObjectiveAnswers([
      question({ snapshotId: "a", marks: 10, correctOptionIndex: 0, selectedOptionIndex: 0 }),
      question({ snapshotId: "b", marks: 1, correctOptionIndex: 0, selectedOptionIndex: 1 }),
      question({ snapshotId: "c", marks: 1, correctOptionIndex: 0, selectedOptionIndex: 1 }),
    ]);
    assert.equal(result.totalScore, 10);
    assert.equal(result.maxScore, 12);
  });
});

describe("gradeObjectiveAnswers — randomisation integrity (AGENTS.md §6)", () => {
  it("grades a shuffled selection by its CANONICAL index, so a shuffle never flips the answer", () => {
    // The key says canonical option 2 is correct. A student who picks the
    // display slot that maps back to canonical 2 (the delivery layer already
    // resolved it) is graded correct regardless of the on-screen order.
    const correctCanonical = 2;
    const result = gradeObjectiveAnswers([
      question({ snapshotId: "a", marks: 1, correctOptionIndex: correctCanonical, selectedOptionIndex: 2 }),
    ]);
    assert.equal(result.correctCount, 1);
    assert.equal(result.totalScore, 1);

    // Picking the display slot that maps to a DIFFERENT canonical option is wrong.
    const wrong = gradeObjectiveAnswers([
      question({ snapshotId: "a", marks: 1, correctOptionIndex: correctCanonical, selectedOptionIndex: 0 }),
    ]);
    assert.equal(wrong.incorrectCount, 1);
  });
});

describe("roundPercentage — decimal marks support", () => {
  it("rounds to whole hundredths", () => {
    assert.equal(roundPercentage(2, 3), 66.67);
    assert.equal(roundPercentage(1, 3), 33.33);
    assert.equal(roundPercentage(1, 6), 16.67);
    assert.equal(roundPercentage(1, 2), 50);
    assert.equal(roundPercentage(0, 4), 0);
  });
  it("guards a zero/negative denominator to 0 rather than NaN/Infinity", () => {
    assert.equal(roundPercentage(0, 0), 0);
    assert.equal(roundPercentage(5, 0), 0);
    assert.equal(roundPercentage(5, -1), 0);
    assert.equal(roundPercentage(Number.NaN, 10), 0);
  });
});

describe("gradeObjectiveAnswers — subject breakdown from valid metadata only", () => {
  it("groups per-subject performance and skips unresolvable subject ids", () => {
    const result = gradeObjectiveAnswers([
      question({ snapshotId: "a", marks: 1, correctOptionIndex: 0, selectedOptionIndex: 0, subjectId: "math" }),
      question({ snapshotId: "b", marks: 1, correctOptionIndex: 0, selectedOptionIndex: 1, subjectId: "math" }),
      question({ snapshotId: "c", marks: 2, correctOptionIndex: 0, selectedOptionIndex: 0, subjectId: "eng" }),
      question({ snapshotId: "d", marks: 1, correctOptionIndex: 0, selectedOptionIndex: 0, subjectId: null }), // skipped
      question({ snapshotId: "e", marks: 1, correctOptionIndex: 0, selectedOptionIndex: 0, subjectId: "" }), // skipped
    ]);
    const math = result.subjectBreakdown.find((s) => s.subjectId === "math");
    const eng = result.subjectBreakdown.find((s) => s.subjectId === "eng");
    assert.deepEqual(math, { subjectId: "math", correct: 1, total: 2, score: 1, maxScore: 2 });
    assert.deepEqual(eng, { subjectId: "eng", correct: 1, total: 1, score: 2, maxScore: 2 });
    // Only two subjects surface — the null/"" ids never appear.
    assert.equal(result.subjectBreakdown.length, 2);
    // The overall buckets still count every question.
    assert.equal(result.totalQuestions, 5);
    assert.equal(result.correctCount, 4);
  });
});

describe("gradeObjectiveAnswers — idempotent recompute (finalisation safety)", () => {
  it("produces identical numbers on a repeat grade of the same locked answers", () => {
    const answers = [
      question({ snapshotId: "a", marks: 2, correctOptionIndex: 1, selectedOptionIndex: 1, subjectId: "x" }),
      question({ snapshotId: "b", marks: 2, correctOptionIndex: 1, selectedOptionIndex: 0 }),
      question({ snapshotId: "c", marks: 2, correctOptionIndex: 1, selectedOptionIndex: null }),
    ];
    const first = gradeObjectiveAnswers(answers);
    const second = gradeObjectiveAnswers(answers);
    assert.deepEqual(first, second); // a retried grade is a true no-op
  });
});

describe("gradeObjectiveAnswers — never trusts a client score", () => {
  it("derives the score purely from the answer key, ignoring any marks-awarded hint", () => {
    // A malicious payload has no field for a claimed score — the only inputs
    // are the frozen key + the chosen index, so a bogus "score" is unrepresentable.
    const result = gradeObjectiveAnswers([
      question({ snapshotId: "a", marks: 5, correctOptionIndex: 0, selectedOptionIndex: 4 }),
    ]);
    assert.equal(result.totalScore, 0); // wrong choice earns nothing regardless
    assert.equal(result.incorrectCount, 1);
  });
});

describe("computeTimeUsedSeconds", () => {
  const start = Date.parse("2026-01-10T09:00:00Z");
  it("reports whole seconds used within the window", () => {
    assert.equal(
      computeTimeUsedSeconds({ startedAtMs: start, endedAtMs: start + 90_000, maxSeconds: 600 }),
      90,
    );
  });
  it("clamps to the window when the terminal stamp lands late", () => {
    assert.equal(
      computeTimeUsedSeconds({ startedAtMs: start, endedAtMs: start + 900_000, maxSeconds: 600 }),
      600,
    );
  });
  it("collapses a negative or malformed span to zero", () => {
    assert.equal(
      computeTimeUsedSeconds({ startedAtMs: start, endedAtMs: start - 5_000, maxSeconds: 600 }),
      0,
    );
    assert.equal(
      computeTimeUsedSeconds({ startedAtMs: Number.NaN, endedAtMs: start, maxSeconds: 600 }),
      0,
    );
  });
  it("leaves time unbounded when there is no window cap", () => {
    assert.equal(
      computeTimeUsedSeconds({ startedAtMs: start, endedAtMs: start + 120_000, maxSeconds: null }),
      120,
    );
  });
});

describe("isResultReleased — conceal the key until policy allows (AGENTS.md §6)", () => {
  const gradedAt = Date.parse("2026-01-10T10:00:00Z");

  it("never reveals an ungraded result", () => {
    assert.equal(
      isResultReleased({ resultsRelease: "immediate", gradedAtMs: null, windowEndsAtMs: null, releasedAtMs: null }),
      false,
    );
  });

  it("immediate releases as soon as it is graded", () => {
    assert.equal(
      isResultReleased({ resultsRelease: "immediate", gradedAtMs: gradedAt, windowEndsAtMs: gradedAt + 60_000, releasedAtMs: null, nowMs: gradedAt }),
      true,
    );
  });

  it("after_window stays hidden until the window closes", () => {
    const windowEnd = gradedAt + 60 * 60_000;
    assert.equal(
      isResultReleased({ resultsRelease: "after_window", gradedAtMs: gradedAt, windowEndsAtMs: windowEnd, releasedAtMs: null, nowMs: windowEnd - 1 }),
      false,
    );
    assert.equal(
      isResultReleased({ resultsRelease: "after_window", gradedAtMs: gradedAt, windowEndsAtMs: windowEnd, releasedAtMs: null, nowMs: windowEnd + 1 }),
      true,
    );
  });

  it("after_window with no window set falls back to released-on-grade", () => {
    assert.equal(
      isResultReleased({ resultsRelease: "after_window", gradedAtMs: gradedAt, windowEndsAtMs: null, releasedAtMs: null, nowMs: gradedAt }),
      true,
    );
  });

  it("manual stays hidden until an explicit release stamp exists", () => {
    assert.equal(
      isResultReleased({ resultsRelease: "manual", gradedAtMs: gradedAt, windowEndsAtMs: gradedAt - 1, releasedAtMs: null, nowMs: gradedAt + 999_999 }),
      false,
    );
    assert.equal(
      isResultReleased({ resultsRelease: "manual", gradedAtMs: gradedAt, windowEndsAtMs: null, releasedAtMs: gradedAt + 10, nowMs: gradedAt + 10 }),
      true,
    );
  });

  it("canRevealAnswers tracks the release gate exactly", () => {
    const input = {
      resultsRelease: "after_window" as const,
      gradedAtMs: gradedAt,
      windowEndsAtMs: gradedAt + 1000,
      releasedAtMs: null,
      nowMs: gradedAt, // still inside the window
    };
    assert.equal(isResultReleased(input), false);
    assert.equal(canRevealAnswers(input), false);
  });
});
