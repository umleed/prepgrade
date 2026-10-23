/**
 * Platform assessments (exams) directory tests — Super Admin "Assessments".
 *
 * Pure modules only (lib/platform-assessments.ts + the reused exam catalog),
 * same Node built-in runner — no Supabase, no Next. These pin:
 *   - the untrusted-searchParams resolver (clamps/drops junk, keeps only
 *     UUID tenant ids, never guesses a status),
 *   - the linkable-href builder,
 *   - the aggregate collapse + mean-percentage rules (empty ≠ 0),
 *   - embed normalisation (object/array/null never leaks undefined; unknown
 *     status degrades to null rather than a guessed lifecycle state),
 *   - the release label derived only from real columns.
 *
 * The SUPER_ADMIN gate is covered by tests/platform/super-admin-access.test.mts;
 * the exam status catalog + display derivation are the tenant-owned rules in
 * lib/exams.ts (already tested) and are REUSED here, not reimplemented.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ASSESSMENT_DIRECTORY_PAGE_SIZE,
  EXAM_STATUSES,
  assessmentDirectoryHref,
  assessmentReleaseLabel,
  collapseCountGroups,
  isValidExamId,
  meanPercentage,
  normalizeExamRows,
  normalizeExamStatusFilter,
  resolveAssessmentDirectoryQuery,
  toAssessmentContainsPattern,
  type RawExamListRow,
} from "../../lib/platform-assessments.ts";

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

// --- id guard ------------------------------------------------------------------

describe("exam id guard", () => {
  it("accepts only UUIDs", () => {
    assert.equal(isValidExamId(UUID), true);
    for (const value of ["../etc", "abc", "", null, undefined, UUID.slice(0, -1)]) {
      assert.equal(isValidExamId(value), false, String(value));
    }
  });
});

// --- status normaliser -----------------------------------------------------------

describe("normalizeExamStatusFilter", () => {
  it("lowercases known statuses and drops unknown ones", () => {
    assert.equal(normalizeExamStatusFilter("PUBLISHED"), "published");
    assert.equal(normalizeExamStatusFilter(["draft", "archived"]), "draft");
    assert.equal(normalizeExamStatusFilter("active"), null);
    assert.equal(normalizeExamStatusFilter(undefined), null);
  });
});

// --- resolver ---------------------------------------------------------------------

describe("resolveAssessmentDirectoryQuery", () => {
  it("defaults cleanly", () => {
    const query = resolveAssessmentDirectoryQuery({});
    assert.equal(query.q, "");
    assert.equal(query.status, null);
    assert.equal(query.institutionId, null);
    assert.equal(query.page, 1);
    assert.equal(query.pageSize, ASSESSMENT_DIRECTORY_PAGE_SIZE);
  });

  it("keeps only UUID tenant filters and known statuses", () => {
    const query = resolveAssessmentDirectoryQuery({
      institution: UUID,
      status: "closed",
    });
    assert.equal(query.institutionId, UUID);
    assert.equal(query.status, "closed");
    assert.equal(
      resolveAssessmentDirectoryQuery({ institution: "1=1" }).institutionId,
      null,
    );
    assert.equal(resolveAssessmentDirectoryQuery({ status: "deleted" }).status, null);
  });

  it("clamps pages and caps search length", () => {
    assert.equal(resolveAssessmentDirectoryQuery({ page: "0" }).page, 1);
    assert.equal(resolveAssessmentDirectoryQuery({ page: "x" }).page, 1);
    assert.equal(resolveAssessmentDirectoryQuery({ page: "7" }).page, 7);
    assert.equal(
      resolveAssessmentDirectoryQuery({ q: "z".repeat(300) }).q.length,
      120,
    );
  });
});

// --- href builder -------------------------------------------------------------------

describe("assessmentDirectoryHref", () => {
  const base = "/platform/assessments";

  it("keeps the default view clean and preserves filters across pages", () => {
    assert.equal(assessmentDirectoryHref(base, resolveAssessmentDirectoryQuery({}), { page: 1 }), base);
    const filtered = resolveAssessmentDirectoryQuery({
      q: "mid",
      status: "published",
      institution: UUID,
    });
    const href = assessmentDirectoryHref(base, filtered, { page: 3 });
    const params = new URL(href, "http://localhost").searchParams;
    assert.equal(params.get("q"), "mid");
    assert.equal(params.get("status"), "published");
    assert.equal(params.get("institution"), UUID);
    assert.equal(params.get("page"), "3");
  });

  it("can switch the status tab back to All", () => {
    const filtered = resolveAssessmentDirectoryQuery({ status: "draft" });
    const href = assessmentDirectoryHref(base, filtered, { status: null, page: 1 });
    assert.equal(href.includes("status"), false);
  });
});

// --- search sanitiser -----------------------------------------------------------------

describe("toAssessmentContainsPattern", () => {
  it("strips filter-syntax characters and wraps contains-patterns", () => {
    assert.equal(toAssessmentContainsPattern("mid term"), "%mid term%");
    assert.equal(toAssessmentContainsPattern("50% (a),b"), "%50 ab%");
    assert.equal(toAssessmentContainsPattern("  %*  "), "");
  });
});

// --- aggregates ------------------------------------------------------------------------

describe("collapseCountGroups", () => {
  it("sums repeated keys and ignores malformed rows", () => {
    const map = collapseCountGroups([
      { key: "a", n: "3" },
      { key: "a", n: 2 },
      { key: "b", n: "1" },
      { key: "", n: 5 },
      { key: "c", n: "NaN" },
    ]);
    assert.equal(map.get("a"), 5);
    assert.equal(map.get("b"), 1);
    assert.equal(map.has("c"), false);
  });
});

describe("meanPercentage", () => {
  it("returns null for empty input — never a fake 0", () => {
    assert.equal(meanPercentage([]), null);
    assert.equal(meanPercentage([Number.NaN]), null);
  });

  it("averages and rounds to whole tenths", () => {
    assert.equal(meanPercentage([50, 60, 70]), 60);
    assert.equal(meanPercentage([66.666, 66.666]), 66.7);
  });
});

// --- row normalisation ------------------------------------------------------------------

function rawExam(overrides: Partial<RawExamListRow> = {}): RawExamListRow {
  return {
    id: UUID,
    title: "Midterm CBT",
    status: "published",
    institution_id: "inst-1",
    subject_id: "sub-1",
    duration_minutes: 60,
    starts_at: null,
    ends_at: null,
    published_at: "2026-01-01",
    published_to: 12,
    created_at: "2025-12-01",
    institution: { name: "Greenfield College" },
    subject: { name: "Mathematics" },
    ...overrides,
  };
}

describe("normalizeExamRows", () => {
  it("attaches real counts from the aggregate maps", () => {
    const [row] = normalizeExamRows([rawExam()], {
      questions: new Map([[UUID, 40]]),
      attempts: new Map([[UUID, 7]]),
      questionsAvailable: true,
      attemptsAvailable: true,
    });
    assert.equal(row.questionCount, 40);
    assert.equal(row.attemptCount, 7);
    assert.equal(row.status, "published");
    assert.equal(row.institutionName, "Greenfield College");
    assert.equal(row.subjectName, "Mathematics");
  });

  it("marks a column unavailable (null) when its read failed — not 0", () => {
    const [row] = normalizeExamRows([rawExam()], {
      questions: new Map(),
      attempts: new Map(),
      questionsAvailable: false,
      attemptsAvailable: true,
    });
    assert.equal(row.questionCount, null);
    assert.equal(row.attemptCount, 0);
  });

  it("degrades an unknown stored status to null rather than guessing", () => {
    const [row] = normalizeExamRows(
      [rawExam({ status: "cancelled" })],
      {
        questions: new Map(),
        attempts: new Map(),
        questionsAvailable: true,
        attemptsAvailable: true,
      },
    );
    assert.equal(row.status, null);
  });

  it("reads array-shaped embeds", () => {
    const [row] = normalizeExamRows(
      [rawExam({ institution: [{ name: "Tutorial Hub" }] })],
      {
        questions: new Map(),
        attempts: new Map(),
        questionsAvailable: true,
        attemptsAvailable: true,
      },
    );
    assert.equal(row.institutionName, "Tutorial Hub");
  });
});

// --- release label -------------------------------------------------------------------------

describe("assessmentReleaseLabel", () => {
  it("says not published without a published_at", () => {
    assert.equal(assessmentReleaseLabel(null, 5), "Not published");
  });

  it("reports the real published-to count", () => {
    assert.equal(
      assessmentReleaseLabel("2026-01-01", 1),
      "released to 1 student",
    );
    assert.equal(
      assessmentReleaseLabel("2026-01-01", 30),
      "released to 30 students",
    );
  });

  it("falls back to a plain 'released' when the count column is absent", () => {
    assert.equal(assessmentReleaseLabel("2026-01-01", null), "released");
  });
});

// --- reuse of the tenant-owned exam catalog ---------------------------------------------------

describe("exam status catalog reuse", () => {
  it("exposes the same five statuses the tenant surface uses", () => {
    assert.deepEqual(
      [...EXAM_STATUSES],
      ["draft", "scheduled", "published", "closed", "archived"],
    );
  });
});
