/**
 * Platform question-bank directory tests — Super Admin "Question Bank"
 * section.
 *
 * Pure modules only (lib/platform-question-bank.ts), same Node built-in
 * runner as the rest of the suite — no Supabase, no Next. These pin the
 * rules the directory depends on:
 *   - the untrusted-searchParams resolver (enum catalogs, UUID tenant
 *     filter, page clamps, search-length cap),
 *   - the URL builder that keeps filters linkable and drops stale params,
 *   - the search sanitiser (filter-syntax characters only — never spaces),
 *   - row normalisation: embeds (object/array/null) degrade to null names,
 *     out-of-catalog enum values are NEVER rendered as trusted ones,
 *   - the difficulty summary: fully keyed, sums correctly, and a null
 *     read stays null ("unavailable") instead of an empty-looking zero.
 *
 * The privacy posture (metadata-only SELECT, no question_text/options/
 * answer key) is a data-layer decision documented in
 * lib/data/platform-question-bank.ts; the SUPER_ADMIN gate is covered by
 * tests/platform/super-admin-access.test.mts. No new schema: the reads hit
 * the questions/question_versions tables from migrations 0006/0009.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  QUESTION_DIFFICULTIES,
  QUESTION_PROVENANCES,
  QUESTION_STATUSES,
  buildDifficultySummary,
  isValidInstitutionUuid,
  normalizeQuestionRows,
  questionDirectoryHref,
  questionQueryHasFilters,
  resolveQuestionDirectoryQuery,
  toQuestionContainsPattern,
  type RawQuestionRow,
} from "../../lib/platform-question-bank.ts";

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

// --- Catalogs ------------------------------------------------------------------

describe("question catalog passthrough", () => {
  it("reuses the exact catalogs from lib/questions.ts", () => {
    assert.deepEqual([...QUESTION_STATUSES], ["active", "archived"]);
    assert.deepEqual([...QUESTION_DIFFICULTIES], ["easy", "medium", "hard"]);
    assert.deepEqual([...QUESTION_PROVENANCES], ["teacher_created", "licensed"]);
  });
});

// --- Institution id guard --------------------------------------------------------

describe("isValidInstitutionUuid", () => {
  it("accepts only well-formed UUIDs", () => {
    assert.equal(isValidInstitutionUuid(UUID), true);
    for (const value of ["abc", "drop table", "", null, undefined]) {
      assert.equal(isValidInstitutionUuid(value), false, String(value));
    }
  });
});

// --- Untrusted searchParams resolver ----------------------------------------------

describe("resolveQuestionDirectoryQuery", () => {
  it("defaults to an unfiltered first page", () => {
    const query = resolveQuestionDirectoryQuery({});
    assert.equal(query.q, "");
    assert.equal(query.status, null);
    assert.equal(query.difficulty, null);
    assert.equal(query.provenance, null);
    assert.equal(query.institutionId, null);
    assert.equal(query.page, 1);
  });

  it("accepts only catalog members, case-insensitively", () => {
    assert.equal(resolveQuestionDirectoryQuery({ status: "Active" }).status, "active");
    assert.equal(resolveQuestionDirectoryQuery({ difficulty: "HARD" }).difficulty, "hard");
    assert.equal(
      resolveQuestionDirectoryQuery({ provenance: "teacher_created" }).provenance,
      "teacher_created",
    );
    // Unknown values drop to null — never a guessed default.
    assert.equal(resolveQuestionDirectoryQuery({ status: "deleted" }).status, null);
    assert.equal(resolveQuestionDirectoryQuery({ difficulty: "extreme" }).difficulty, null);
    assert.equal(resolveQuestionDirectoryQuery({ provenance: "scraped" }).provenance, null);
  });

  it("keeps only UUID-shaped institution filters", () => {
    assert.equal(resolveQuestionDirectoryQuery({ institution: UUID }).institutionId, UUID);
    assert.equal(resolveQuestionDirectoryQuery({ institution: "1 OR 1=1" }).institutionId, null);
  });

  it("clamps junk pages to 1 and caps the search length", () => {
    assert.equal(resolveQuestionDirectoryQuery({ page: "0" }).page, 1);
    assert.equal(resolveQuestionDirectoryQuery({ page: "-4" }).page, 1);
    assert.equal(resolveQuestionDirectoryQuery({ page: "abc" }).page, 1);
    assert.equal(resolveQuestionDirectoryQuery({ page: "5" }).page, 5);
    assert.equal(resolveQuestionDirectoryQuery({ q: "a".repeat(400) }).q.length, 120);
  });

  it("takes the first value of array params", () => {
    assert.equal(resolveQuestionDirectoryQuery({ q: ["first", "second"] }).q, "first");
    assert.equal(resolveQuestionDirectoryQuery({ status: ["active", "archived"] }).status, "active");
  });
});

describe("questionQueryHasFilters", () => {
  it("is false only for the fully unfiltered query", () => {
    assert.equal(questionQueryHasFilters(resolveQuestionDirectoryQuery({})), false);
    assert.equal(questionQueryHasFilters(resolveQuestionDirectoryQuery({ q: "x" })), true);
    assert.equal(questionQueryHasFilters(resolveQuestionDirectoryQuery({ status: "archived" })), true);
    assert.equal(questionQueryHasFilters(resolveQuestionDirectoryQuery({ institution: UUID })), true);
  });
});

// --- href builder -------------------------------------------------------------------

describe("questionDirectoryHref", () => {
  const base = "/platform/question-bank";

  it("keeps the unfiltered first page a clean path", () => {
    const query = resolveQuestionDirectoryQuery({});
    assert.equal(questionDirectoryHref(base, query, {}), base);
  });

  it("carries every active filter into the next URL", () => {
    const filtered = resolveQuestionDirectoryQuery({
      q: "waec",
      status: "active",
      difficulty: "easy",
      provenance: "licensed",
      institution: UUID,
    });
    const href = questionDirectoryHref(base, filtered, { page: 2 });
    const params = new URL(href, "http://localhost").searchParams;
    assert.equal(params.get("q"), "waec");
    assert.equal(params.get("status"), "active");
    assert.equal(params.get("difficulty"), "easy");
    assert.equal(params.get("provenance"), "licensed");
    assert.equal(params.get("institution"), UUID);
    assert.equal(params.get("page"), "2");
  });

  it("applies overrides and omits page 1", () => {
    const filtered = resolveQuestionDirectoryQuery({ difficulty: "hard" });
    const href = questionDirectoryHref(base, filtered, { difficulty: null, page: 1 });
    assert.equal(href.includes("difficulty"), false);
    assert.equal(href.includes("page"), false);
  });
});

// --- search sanitiser -----------------------------------------------------------------

describe("toQuestionContainsPattern", () => {
  it("strips filter-syntax characters but keeps inner spaces", () => {
    assert.equal(toQuestionContainsPattern("waec 2023"), "%waec 2023%");
    assert.equal(toQuestionContainsPattern("50% (a),b"), "%50 ab%");
    assert.equal(toQuestionContainsPattern("   "), "");
    assert.equal(toQuestionContainsPattern("%*,"), "");
  });
});

// --- Row normalisation (pure, defensive) ----------------------------------------------

describe("normalizeQuestionRows", () => {
  const raw = (overrides: Partial<RawQuestionRow> = {}): RawQuestionRow => ({
    id: "q1",
    institution_id: UUID,
    subject_id: "s1",
    difficulty: "medium",
    provenance: "teacher_created",
    status: "active",
    source_label: "WAEC 2023",
    source_year: 2023,
    marks: 1,
    created_at: "2026-01-01",
    institution: { name: "Greenfield College" },
    subject: { name: "Mathematics" },
    ...overrides,
  });

  it("reads object embeds and catalog values", () => {
    const [row] = normalizeQuestionRows([raw()]);
    assert.equal(row.institutionName, "Greenfield College");
    assert.equal(row.subjectName, "Mathematics");
    assert.equal(row.difficulty, "medium");
    assert.equal(row.provenance, "teacher_created");
    assert.equal(row.status, "active");
    assert.equal(row.sourceYear, 2023);
    assert.equal(row.marks, 1);
  });

  it("reads array embeds (to-one drift) without crashing", () => {
    const [row] = normalizeQuestionRows([
      raw({ institution: [{ name: "Tutorial Hub" }], subject: [{ name: "Physics" }] }),
    ]);
    assert.equal(row.institutionName, "Tutorial Hub");
    assert.equal(row.subjectName, "Physics");
  });

  it("survives null embeds — never undefined, never a guessed name", () => {
    const [row] = normalizeQuestionRows([raw({ institution: null, subject: null })]);
    assert.equal(row.institutionName, null);
    assert.equal(row.subjectName, null);
  });

  it("degrades out-of-catalog enum values to null (fail-closed)", () => {
    const [row] = normalizeQuestionRows([
      raw({ difficulty: "impossible", provenance: "scraped", status: "deleted" }),
    ]);
    assert.equal(row.difficulty, null);
    assert.equal(row.provenance, null);
    assert.equal(row.status, null);
    // The row itself is still listed — metadata we trust is untouched.
    assert.equal(row.id, "q1");
  });

  it("normalises non-number source fields to null, not NaN", () => {
    const [row] = normalizeQuestionRows([
      raw({ source_year: "2023" as unknown as number, marks: undefined as unknown as number, source_label: 42 as unknown as string }),
    ]);
    assert.equal(row.sourceYear, null);
    assert.equal(row.marks, null);
    assert.equal(row.sourceLabel, null);
  });
});

// --- Difficulty summary -----------------------------------------------------------------

describe("buildDifficultySummary", () => {
  it("keys every catalog difficulty and sums the total", () => {
    const counts = new Map([
      ["easy", 3],
      ["medium", 5],
      ["hard", 2],
    ]);
    const summary = buildDifficultySummary(counts);
    assert.deepEqual(summary, {
      byDifficulty: { easy: 3, medium: 5, hard: 2 },
      total: 10,
    });
  });

  it("fills missing difficulties with 0 and ignores unknown keys", () => {
    const counts = new Map([
      ["easy", 1],
      ["legacy_bucket", 99],
    ]);
    const summary = buildDifficultySummary(counts);
    assert.equal(summary?.byDifficulty.easy, 1);
    assert.equal(summary?.byDifficulty.medium, 0);
    assert.equal(summary?.byDifficulty.hard, 0);
    assert.equal(summary?.total, 1);
    assert.equal("legacy_bucket" in (summary?.byDifficulty ?? {}), false);
  });

  it("a failed read stays null — never an empty-looking zero", () => {
    assert.equal(buildDifficultySummary(null), null);
  });
});
