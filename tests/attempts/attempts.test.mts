/**
 * Exam attempt delivery tests — prompts 22–23 (pure contract layer).
 *
 * These cover the rules the CBT interface and the attempt state machine SHARE
 * so the browser's behaviour and the server's enforcement can never drift
 * (AGENTS.md §6): the server-authoritative deadline, the countdown rendering,
 * the save/submit gating, the idempotent submit decision, and — most
 * importantly — the randomisation mapping that lets a shuffled option still
 * resolve to the SAME canonical answer the grader will use.
 *
 * The Supabase data layer (lib/data/attempts.ts) is NOT exercised here — there
 * is no live DB in `npm test`. Its guarantees (the tenant + student ownership
 * filters, the snapshot→attempt anchor, the append-only timing columns, and
 * deployed RLS) are enforced by 0013_exam_attempts.sql and the queries' hard
 * `.eq("institution_id"/"student_id", …)` filters, and would be covered by a
 * runnable SQL harness against a real database.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXAM_ATTEMPT_STATUSES,
  attemptIsLocked,
  attemptQuestionNavState,
  attemptSubmitDecision,
  attemptTimeRemainingMs,
  buildOptionOrder,
  canAcceptAnswer,
  canTransitionAttempt,
  canonicalToDisplay,
  computeAttemptExpiresAt,
  countAnswered,
  displayToCanonical,
  formatCountdown,
  isAttemptExpired,
  isExamAttemptStatus,
  shuffledCopy,
  type ExamAttemptStatus,
} from "../../lib/attempts.ts";

// A deterministic [0,1) source so shuffles are reproducible in tests.
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32 — fast, deterministic, good enough to exercise the mapping.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

describe("attempt status vocabulary", () => {
  it("has exactly the three stored states (not_started is the absence of a row)", () => {
    assert.deepEqual([...EXAM_ATTEMPT_STATUSES], ["in_progress", "submitted", "expired"]);
    assert.equal(isExamAttemptStatus("in_progress"), true);
    assert.equal(isExamAttemptStatus("not_started"), false);
    assert.equal(isExamAttemptStatus("abandoned"), false);
  });

  it("only ever moves forward and treats terminal states as closed", () => {
    assert.equal(canTransitionAttempt("in_progress", "submitted"), true);
    assert.equal(canTransitionAttempt("in_progress", "expired"), true);
    assert.equal(canTransitionAttempt("submitted", "in_progress"), false);
    assert.equal(canTransitionAttempt("expired", "in_progress"), false);
    assert.equal(attemptIsLocked("submitted"), true);
    assert.equal(attemptIsLocked("expired"), true);
    assert.equal(attemptIsLocked("in_progress"), false);
  });
});

describe("server-authoritative timing", () => {
  const start = Date.parse("2026-01-10T09:00:00Z");

  it("sets the deadline a full duration after the server start time", () => {
    const expires = computeAttemptExpiresAt({
      startedAtMs: start,
      durationMinutes: 60,
      examEndsAtMs: null,
    });
    assert.equal(expires, start + 60 * 60_000);
  });

  it("caps the deadline at the exam window end when that is sooner", () => {
    // Started 09:00 with 60 minutes, but the window closes at 09:20.
    const windowEnd = start + 20 * 60_000;
    const expires = computeAttemptExpiresAt({
      startedAtMs: start,
      durationMinutes: 60,
      examEndsAtMs: windowEnd,
    });
    assert.equal(expires, windowEnd);
  });

  it("never lets the window cap push the deadline before the start", () => {
    const expires = computeAttemptExpiresAt({
      startedAtMs: start,
      durationMinutes: 60,
      examEndsAtMs: start - 10 * 60_000, // already closed
    });
    assert.equal(expires, start);
  });

  it("clamps remaining time at zero and flags expiry on the deadline", () => {
    const expires = start + 60_000;
    assert.equal(attemptTimeRemainingMs(expires, start), 60_000);
    assert.equal(attemptTimeRemainingMs(expires, start + 120_000), 0);
    assert.equal(isAttemptExpired(expires, start + 59_999), false);
    assert.equal(isAttemptExpired(expires, expires), true);
  });
});

describe("formatCountdown", () => {
  it("renders M:SS under an hour and H:MM:SS at or over it, flooring", () => {
    assert.equal(formatCountdown(42 * 60_000 + 18 * 1000), "42:18");
    assert.equal(formatCountdown(1500), "0:01"); // floors, never a premature 0:00
    assert.equal(formatCountdown(500), "0:00");
    assert.equal(formatCountdown(3_600_000), "1:00:00");
    assert.equal(formatCountdown(-5_000), "0:00"); // never negative
  });
});

describe("canAcceptAnswer", () => {
  const expires = Date.parse("2026-01-10T10:00:00Z");

  it("accepts a save only while in progress and before the deadline", () => {
    assert.equal(
      canAcceptAnswer({ status: "in_progress", expiresAtMs: expires, nowMs: expires - 1000 }),
      true,
    );
  });

  it("refuses after submit, after expiry, and at/after the deadline", () => {
    assert.equal(
      canAcceptAnswer({ status: "submitted", expiresAtMs: expires, nowMs: expires - 1000 }),
      false,
    );
    assert.equal(
      canAcceptAnswer({ status: "expired", expiresAtMs: expires, nowMs: expires - 1000 }),
      false,
    );
    // A stale tab cannot write once the server clock has passed the deadline.
    assert.equal(
      canAcceptAnswer({ status: "in_progress", expiresAtMs: expires, nowMs: expires }),
      false,
    );
  });
});

describe("attemptSubmitDecision (idempotent)", () => {
  const expires = Date.parse("2026-01-10T10:00:00Z");

  it("submits a live attempt with time remaining", () => {
    assert.deepEqual(
      attemptSubmitDecision({ status: "in_progress", expiresAtMs: expires, nowMs: expires - 1000 }),
      { outcome: "submitted", next: "submitted" },
    );
  });

  it("records an overdue attempt as expired, not submitted", () => {
    assert.deepEqual(
      attemptSubmitDecision({ status: "in_progress", expiresAtMs: expires, nowMs: expires + 1 }),
      { outcome: "expired", next: "expired" },
    );
  });

  it("treats a repeat submit as a no-op on the terminal state", () => {
    assert.deepEqual(
      attemptSubmitDecision({ status: "submitted", expiresAtMs: expires, nowMs: expires - 1000 }),
      { outcome: "already_submitted" },
    );
    assert.deepEqual(
      attemptSubmitDecision({ status: "expired", expiresAtMs: expires, nowMs: expires + 1 }),
      { outcome: "already_expired" },
    );
  });
});

describe("randomisation preserves the answer key", () => {
  it("shuffledCopy leaves the input untouched and returns a permutation", () => {
    const input = [1, 2, 3, 4, 5];
    const output = shuffledCopy(input, true, makeRng(1234));
    assert.notEqual(output, input);
    assert.deepEqual([...input], [1, 2, 3, 4, 5]);
    assert.deepEqual([...output].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  it("an unshuffled order is the identity", () => {
    assert.deepEqual(buildOptionOrder(4, false, makeRng(9)), [0, 1, 2, 3]);
  });

  it("maps every display slot back to a distinct canonical index", () => {
    const order = buildOptionOrder(4, true, makeRng(77));
    // A permutation: same multiset, no repeats.
    assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3]);
    // The canonical index of each display slot round-trips through display.
    for (let display = 0; display < order.length; display++) {
      const canonical = displayToCanonical(order, display);
      assert.equal(canonical, order[display]);
      assert.equal(canonicalToDisplay(order, canonical as number), display);
    }
  });

  it("the correct answer survives a shuffle (the integrity rule of AGENTS.md §6)", () => {
    // Snapshot says option 2 is correct. Whatever the display permutation,
    // the display slot that SHOWS canonical 2 must map back to canonical 2.
    const correctCanonical = 2;
    const order = buildOptionOrder(4, true, makeRng(4242));
    const displayShowingCorrect = canonicalToDisplay(order, correctCanonical);
    assert.notEqual(displayShowingCorrect, null);
    assert.equal(displayToCanonical(order, displayShowingCorrect as number), correctCanonical);
  });

  it("refuses out-of-range or non-integer display selections", () => {
    const order = [2, 0, 1];
    assert.equal(displayToCanonical(order, -1), null);
    assert.equal(displayToCanonical(order, 3), null);
    assert.equal(displayToCanonical(order, 1.5), null);
    assert.equal(canonicalToDisplay(order, 99), null);
  });
});

describe("navigator state", () => {
  it("reports answered + review flags independently", () => {
    assert.deepEqual(attemptQuestionNavState(true, false), {
      answered: true,
      markedForReview: false,
    });
    assert.deepEqual(attemptQuestionNavState(false, true), {
      answered: false,
      markedForReview: true,
    });
  });

  it("counts answered questions for the progress line", () => {
    const states = new Map([
      ["a", attemptQuestionNavState(true, false)],
      ["b", attemptQuestionNavState(false, true)],
      ["c", attemptQuestionNavState(true, true)],
      ["d", attemptQuestionNavState(false, false)],
    ]);
    assert.equal(countAnswered(states), 2);
  });
});

// Guard: the status type is exported for callers building on the contract.
const _statusTypeCheck: ExamAttemptStatus = "in_progress";
void _statusTypeCheck;
