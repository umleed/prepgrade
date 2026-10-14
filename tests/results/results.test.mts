/**
 * Result-view tests — prompt 25 (pure contract layer).
 *
 * These cover the shared display rules the student and staff result views read
 * the grading engine's stored facts through, so a shown result and an
 * authoritative one can never drift (AGENTS.md §6): the release-visibility gate
 * (which mirrors the grading layer's `isResultReleased` exactly), the
 * policy-aware release hint, the consistent percentage/score/time formatting,
 * and the defensive parse of the stored `subject_breakdown` jsonb — where a
 * malformed entry drops out rather than being guessed or fabricated (AGENTS.md
 * §7). The Supabase data layer (lib/data/results.ts) is NOT exercised here —
 * there is no live DB in `npm test`; its tenant + ownership filters and the
 * number-stripping fail-closed read are enforced by the `.eq(...)` query filters
 * over the 0014 table.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  breakdownSubjectIds,
  buildSubjectRows,
  formatPercentage,
  formatScore,
  formatTimeUsed,
  releaseHint,
  studentResultVisibility,
} from "../../lib/results.ts";

describe("studentResultVisibility — mirrors the grading release gate", () => {
  const gradedAt = Date.parse("2026-01-10T10:00:00Z");

  it("never reveals an ungraded result", () => {
    assert.equal(
      studentResultVisibility({
        resultsRelease: "immediate",
        gradedAtMs: null,
        windowEndsAtMs: null,
        releasedAtMs: null,
      }),
      "not_yet_released",
    );
  });

  it("immediate releases as soon as it is graded", () => {
    assert.equal(
      studentResultVisibility({
        resultsRelease: "immediate",
        gradedAtMs: gradedAt,
        windowEndsAtMs: gradedAt + 60_000,
        releasedAtMs: null,
        nowMs: gradedAt,
      }),
      "released",
    );
  });

  it("after_window stays hidden until the window closes", () => {
    const windowEnd = gradedAt + 60 * 60_000;
    assert.equal(
      studentResultVisibility({
        resultsRelease: "after_window",
        gradedAtMs: gradedAt,
        windowEndsAtMs: windowEnd,
        releasedAtMs: null,
        nowMs: windowEnd - 1,
      }),
      "not_yet_released",
    );
    assert.equal(
      studentResultVisibility({
        resultsRelease: "after_window",
        gradedAtMs: gradedAt,
        windowEndsAtMs: windowEnd,
        releasedAtMs: null,
        nowMs: windowEnd + 1,
      }),
      "released",
    );
  });

  it("manual stays hidden until an explicit release stamp exists", () => {
    assert.equal(
      studentResultVisibility({
        resultsRelease: "manual",
        gradedAtMs: gradedAt,
        windowEndsAtMs: null,
        releasedAtMs: null,
        nowMs: gradedAt + 999_999,
      }),
      "not_yet_released",
    );
    assert.equal(
      studentResultVisibility({
        resultsRelease: "manual",
        gradedAtMs: gradedAt,
        windowEndsAtMs: null,
        releasedAtMs: gradedAt + 10,
        nowMs: gradedAt + 10,
      }),
      "released",
    );
  });
});

describe("releaseHint — honest policy copy, never a fabricated date", () => {
  it("describes each policy's release condition", () => {
    assert.match(releaseHint("manual"), /teacher/i);
    assert.match(releaseHint("after_window"), /window/i);
    assert.match(releaseHint("immediate"), /shortly|finalis/i);
  });
});

describe("formatPercentage — consistent, non-misleading", () => {
  it("keeps genuine decimals and drops a trailing .00", () => {
    assert.equal(formatPercentage(66.67), "66.67%");
    assert.equal(formatPercentage(100), "100%");
    assert.equal(formatPercentage(50), "50%");
    assert.equal(formatPercentage(0), "0%");
  });
  it("shows an em dash for a non-finite value rather than a fake number", () => {
    assert.equal(formatPercentage(Number.NaN), "—");
  });
});

describe("formatScore", () => {
  it("renders earned over available", () => {
    assert.equal(formatScore(12, 18), "12 / 18");
  });
  it("treats a non-finite value as zero", () => {
    assert.equal(formatScore(Number.NaN, 10), "0 / 10");
  });
});

describe("formatTimeUsed", () => {
  it("formats seconds, minutes, and hours", () => {
    assert.equal(formatTimeUsed(45), "45s");
    assert.equal(formatTimeUsed(750), "12m 30s");
    assert.equal(formatTimeUsed(3900), "1h 05m");
  });
  it("shows an em dash for zero/invalid rather than a fake 0s", () => {
    assert.equal(formatTimeUsed(0), "—");
    assert.equal(formatTimeUsed(-5), "—");
    assert.equal(formatTimeUsed(Number.NaN), "—");
  });
});

describe("buildSubjectRows — defensive read of the stored breakdown", () => {
  const nameFor = (id: string) => (id === "math" ? "Mathematics" : id === "eng" ? "English" : null);

  it("resolves names, derives percentage, and sorts by subject name", () => {
    const rows = buildSubjectRows(
      [
        { subjectId: "math", correct: 3, total: 5, score: 3, maxScore: 5 },
        { subjectId: "eng", correct: 1, total: 2, score: 1, maxScore: 2 },
      ],
      nameFor,
    );
    assert.deepEqual(rows.map((r) => r.subjectName), ["English", "Mathematics"]);
    const math = rows.find((r) => r.subjectId === "math")!;
    assert.equal(math.percentage, 60);
    assert.equal(math.correct, 3);
  });

  it("drops malformed entries instead of guessing them", () => {
    const rows = buildSubjectRows(
      [
        null,
        "not-an-object",
        [],
        { subjectId: "", correct: 1, total: 1, score: 1, maxScore: 1 }, // empty id dropped
        { subjectId: 42, correct: 1, total: 1, score: 1, maxScore: 1 }, // non-string id dropped
        { subjectId: "math", correct: 2, total: 2, score: 2, maxScore: 2 }, // kept
      ],
      nameFor,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.subjectName, "Mathematics");
  });

  it("accepts numeric buckets that arrive as strings from PostgREST", () => {
    const rows = buildSubjectRows(
      [{ subjectId: "math", correct: "2", total: "4", score: "2", maxScore: "4" }],
      nameFor,
    );
    assert.equal(rows[0]!.correct, 2);
    assert.equal(rows[0]!.maxScore, 4);
    assert.equal(rows[0]!.percentage, 50);
  });

  it("guards a zero denominator to 0% and falls back to an em dash name", () => {
    const rows = buildSubjectRows(
      [{ subjectId: "ghost", correct: 0, total: 0, score: 0, maxScore: 0 }],
      () => null,
    );
    assert.equal(rows[0]!.subjectName, "—");
    assert.equal(rows[0]!.percentage, 0);
  });
});

describe("breakdownSubjectIds — collects only valid ids", () => {
  it("dedupes valid subject ids and ignores malformed entries", () => {
    const ids = breakdownSubjectIds([
      { subjectId: "math" },
      { subjectId: "math" },
      { subjectId: "" },
      { subjectId: 7 },
      null,
      { subjectId: "eng" },
    ]);
    assert.deepEqual([...ids].sort(), ["eng", "math"]);
  });
});
