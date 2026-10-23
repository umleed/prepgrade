/**
 * Platform usage & activity tests — super-admin operational view.
 *
 * Pure modules only (lib/platform-usage.ts + the audit catalog), same Node
 * built-in runner as the rest of the suite — no Supabase, no Next. These pin
 * the data-correctness rules the /platform/usage screen depends on:
 *   - every window is UTC, half-open, clamped, and never guessed;
 *   - bucket series are contiguous (a gap is a real zero, not a missing
 *     point) and align with the SQL date_trunc(... AT TIME ZONE 'UTC');
 *   - series alignment drops unknown rows visibly (counted), never silently;
 *   - the institution filter fails closed on non-uuid junk instead of
 *     widening to "all";
 *   - activity categories come from the closed audit catalog only, and
 *     partition it exactly.
 *
 * The SUPER_ADMIN gate over the whole /platform area (including the new
 * route, which calls the same requireSuperAdmin) is pinned by
 * tests/platform/super-admin-access.test.mts; the database half of the
 * time-series function by supabase/tests/platform_usage_readiness.sql.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MS_PER_DAY,
  USAGE_ACTIVITY_PAGE_SIZE,
  USAGE_DEFAULT_PRESET_DAYS,
  USAGE_MAX_RANGE_DAYS,
  USAGE_RANGE_PRESETS,
  USAGE_SERIES_KEYS,
  USAGE_TIMEZONE,
  actionsForActivityCategory,
  alignUsageSeries,
  applicableSeriesFor,
  buildUsageBuckets,
  categorizeAuditAction,
  granularityForSpanDays,
  isoDayUtc,
  parseUtcDay,
  resolveUsageFilters,
  resolveUsageRange,
  seriesHaveNoActivity,
  usageHref,
} from "../../lib/platform-usage.ts";
import { PLATFORM_AUDIT_ACTIONS } from "../../lib/audit/platform.ts";

// Fixed "now": Thu 15 Oct 2026, 13:45 UTC.
const NOW = new Date(Date.UTC(2026, 9, 15, 13, 45, 0));
const TODAY_START = Date.UTC(2026, 9, 15);

// --- Calendar parsing --------------------------------------------------------

describe("parseUtcDay", () => {
  it("accepts strict padded calendar dates as UTC day starts", () => {
    assert.equal(parseUtcDay("2026-10-15"), TODAY_START);
    assert.equal(parseUtcDay(" 2026-01-01 "), Date.UTC(2026, 0, 1));
  });

  it("rejects impossible, unformatted, and non-string values", () => {
    for (const bad of [
      "2026-02-30", // impossible day
      "2026-13-01", // impossible month
      "2026-1-5",   // not zero-padded
      "15/10/2026", // wrong format
      "2026-10-15T00:00Z", // timestamp, not a calendar date
      "1999-01-01", // out of supported range
      "", null, undefined, 42, ["2026-10-15"],
    ]) {
      assert.equal(parseUtcDay(bad), null, String(bad));
    }
  });
});

// --- Window resolution (untrusted searchParams → legal UTC window) ----------

describe("resolveUsageRange", () => {
  it("defaults to the last 30 UTC days and flags the fallback", () => {
    const range = resolveUsageRange({}, NOW);
    assert.equal(range.preset, null);
    assert.equal(range.usedFallback, true);
    assert.equal(range.spanDays, USAGE_DEFAULT_PRESET_DAYS);
    assert.equal(range.toMs, TODAY_START + MS_PER_DAY); // end of TODAY (exclusive)
    assert.equal(range.granularity, "day");
    assert.equal(range.fromDay, "2026-09-16");
    assert.equal(range.toDay, "2026-10-15");
  });

  for (const days of USAGE_RANGE_PRESETS) {
    it(`preset=${days} covers the last ${days} UTC days including today`, () => {
      const range = resolveUsageRange({ preset: String(days) }, NOW);
      assert.equal(range.preset, days);
      assert.equal(range.usedFallback, false);
      assert.equal(range.spanDays, days);
      assert.equal(range.toMs, TODAY_START + MS_PER_DAY);
    });
  }

  it("drops an unknown preset to the default, flagged — never a wild window", () => {
    const range = resolveUsageRange({ preset: "28" }, NOW);
    assert.equal(range.preset, null);
    assert.equal(range.usedFallback, true);
    assert.equal(range.spanDays, USAGE_DEFAULT_PRESET_DAYS);
  });

  it("treats the `to` day as inclusive and half-open in ms", () => {
    const range = resolveUsageRange({ from: "2026-10-01", to: "2026-10-07" }, NOW);
    assert.equal(range.preset, null);
    assert.equal(range.usedFallback, false);
    assert.equal(range.fromMs, Date.UTC(2026, 9, 1));
    assert.equal(range.toMs, Date.UTC(2026, 9, 8)); // 00:00 UTC of the NEXT day
    assert.equal(range.spanDays, 7);
    assert.equal(range.toDay, "2026-10-07");
  });

  it("swaps inverted dates instead of refusing or inventing", () => {
    const range = resolveUsageRange({ from: "2026-10-07", to: "2026-10-01" }, NOW);
    assert.equal(range.fromDay, "2026-10-01");
    assert.equal(range.toDay, "2026-10-07");
  });

  it("never extends past the end of the current UTC day", () => {
    const range = resolveUsageRange({ from: "2026-10-10", to: "2026-12-31" }, NOW);
    assert.equal(range.toMs, TODAY_START + MS_PER_DAY);
    assert.equal(range.toDay, "2026-10-15");
  });

  it("clamps over-long windows to the cap and flags it", () => {
    const range = resolveUsageRange({ from: "2001-01-01", to: "2026-10-15" }, NOW);
    assert.equal(range.clamped, true);
    assert.equal(range.spanDays, USAGE_MAX_RANGE_DAYS);
    assert.equal(range.granularity, "month");
  });

  it("unparseable dates fall back to the default, flagged", () => {
    for (const params of [
      { from: "garbage", to: "2026-10-01" },
      { from: "2026-10-01", to: "2026-02-30" },
      { from: "", to: "" },
    ]) {
      const range = resolveUsageRange(params, NOW);
      assert.equal(range.usedFallback, true, JSON.stringify(params));
      assert.equal(range.spanDays, USAGE_DEFAULT_PRESET_DAYS);
    }
  });

  it("maps span to granularity at the documented boundaries", () => {
    assert.equal(granularityForSpanDays(1), "day");
    assert.equal(granularityForSpanDays(45), "day");
    assert.equal(granularityForSpanDays(46), "week");
    assert.equal(granularityForSpanDays(180), "week");
    assert.equal(granularityForSpanDays(181), "month");
  });
});

// --- Buckets (contiguous UTC calendar series) --------------------------------

describe("buildUsageBuckets", () => {
  it("builds one bucket per UTC day, matching the window span", () => {
    const from = Date.UTC(2026, 0, 1);
    const buckets = buildUsageBuckets(from, from + 7 * MS_PER_DAY, "day");
    assert.equal(buckets.length, 7);
    assert.equal(buckets[0].key, "2026-01-01");
    assert.equal(buckets[6].key, "2026-01-07");
    assert.equal(buckets[0].endMs, buckets[1].startMs); // contiguous
  });

  it("aligns week buckets to ISO Mondays (like date_trunc('week'))", () => {
    // 2026-01-01 is a Thursday → the week started Monday 2025-12-29.
    const from = Date.UTC(2026, 0, 1);
    const buckets = buildUsageBuckets(from, from + 14 * MS_PER_DAY, "week");
    assert.equal(buckets[0].key, "2025-12-29");
    assert.equal(buckets[1].key, "2026-01-05");
    assert.equal(new Date(buckets[0].startMs).getUTCDay(), 1);
  });

  it("aligns month buckets to the 1st", () => {
    const from = Date.UTC(2026, 0, 15);
    const buckets = buildUsageBuckets(from, Date.UTC(2026, 2, 10), "month");
    assert.deepEqual(buckets.map((b) => b.key), [
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
  });

  it("returns nothing for degenerate windows", () => {
    const t = Date.UTC(2026, 0, 1);
    assert.deepEqual(buildUsageBuckets(t, t, "day"), []);
    assert.deepEqual(buildUsageBuckets(t, t - MS_PER_DAY, "day"), []);
  });
});

// --- Series alignment (aggregation correctness) -------------------------------

const BUCKETS = buildUsageBuckets(
  Date.UTC(2026, 0, 1),
  Date.UTC(2026, 0, 4),
  "day",
);

describe("alignUsageSeries", () => {
  it("places counts in the matching bucket and sums duplicates", () => {
    const { series, droppedRows } = alignUsageSeries(
      [
        { source: "questions", bucket_start: "2026-01-01", event_count: 2 },
        { source: "questions", bucket_start: "2026-01-01", event_count: 3 },
        { source: "questions", bucket_start: "2026-01-03", event_count: "7" },
      ],
      BUCKETS,
      ["questions"],
    );
    assert.equal(droppedRows, 0);
    assert.deepEqual(series[0].points, [5, 0, 7]);
    assert.equal(series[0].total, 12);
    assert.equal(series[0].peak, 7);
  });

  it("a successful query with no rows is a REAL zero series, not missing", () => {
    const { series } = alignUsageSeries([], BUCKETS, ["exams", "institutions"]);
    assert.deepEqual(series.map((s) => s.points), [
      [0, 0, 0],
      [0, 0, 0],
    ]);
    assert.equal(seriesHaveNoActivity(series), true);
  });

  it("drops unknown sources and out-of-window buckets, counted not hidden", () => {
    const { series, droppedRows } = alignUsageSeries(
      [
        { source: "mystery", bucket_start: "2026-01-01", event_count: 9 },
        { source: "questions", bucket_start: "2025-12-31", event_count: 9 },
        { source: "questions", bucket_start: "2026-01-02", event_count: 1 },
      ],
      BUCKETS,
      ["questions"],
    );
    assert.equal(droppedRows, 2);
    assert.deepEqual(series[0].points, [0, 1, 0]);
  });

  it("never lets a negative or corrupt count through as data", () => {
    const { series } = alignUsageSeries(
      [
        { source: "exams", bucket_start: "2026-01-01", event_count: -5 },
        { source: "exams", bucket_start: "2026-01-02", event_count: null as unknown as number },
      ],
      BUCKETS,
      ["exams"],
    );
    assert.deepEqual(series[0].points, [0, 0, 0]);
  });
});

describe("applicableSeriesFor", () => {
  it("offers every series platform-wide", () => {
    const { sources, omitted } = applicableSeriesFor(null);
    assert.deepEqual(sources, [...USAGE_SERIES_KEYS]);
    assert.deepEqual(omitted, []);
  });

  it("drops the unattributable accounts series under a tenant filter", () => {
    const { sources, omitted } = applicableSeriesFor(
      "00000000-0000-4000-8000-0000000000b2",
    );
    assert.equal(sources.includes("accounts"), false);
    assert.deepEqual(omitted, ["accounts"]);
    assert.equal(sources.length, USAGE_SERIES_KEYS.length - 1);
  });
});

// --- Activity categories (closed-catalog partitioning) ------------------------

describe("categorizeAuditAction", () => {
  it("assigns every catalog action to exactly one category", () => {
    const seen = new Map<string, number>();
    for (const action of PLATFORM_AUDIT_ACTIONS) {
      const category = categorizeAuditAction(action);
      if (category === null) throw new Error(`uncatalogued action: ${action}`);
      seen.set(category, (seen.get(category) ?? 0) + 1);
    }
    assert.equal(
      [...seen.values()].reduce((sum, n) => sum + n, 0),
      PLATFORM_AUDIT_ACTIONS.length,
    );
  });

  it("routes institution_application.* to applications, not institutions", () => {
    assert.equal(
      categorizeAuditAction("institution_application.approved"),
      "application",
    );
    assert.equal(categorizeAuditAction("institution.status_changed"), "institution");
    assert.equal(categorizeAuditAction("platform.access_denied"), "platform");
    assert.equal(categorizeAuditAction("exam.published"), "exam");
  });

  it("refuses out-of-catalog strings — the UI shows them as Other, raw", () => {
    for (const bad of ["exam.deleted", "", "DROP TABLE", "institution"]) {
      assert.equal(categorizeAuditAction(bad), null, bad);
    }
  });

  it("actionsForActivityCategory only ever yields catalog names (filter safety)", () => {
    for (const category of ["platform", "institution", "application", "exam"] as const) {
      for (const action of actionsForActivityCategory(category)) {
        assert.equal(PLATFORM_AUDIT_ACTIONS.includes(action), true, action);
      }
    }
  });
});

// --- Filter resolution (fail-closed searchParams handling) --------------------

const UUID = "00000000-0000-4000-8000-0000000000b2";

describe("resolveUsageFilters", () => {
  it("accepts a well-formed uuid (lower-cased) and rejects junk outright", () => {
    assert.equal(
      resolveUsageFilters({ institution: UUID }).institution,
      UUID,
    );
    assert.equal(
      resolveUsageFilters({ institution: UUID.toUpperCase() }).institution,
      UUID,
    );

    for (const junk of ["'; DROP", "not-a-uuid", UUID.slice(0, 20), `${UUID}extra`]) {
      const resolved = resolveUsageFilters({ institution: junk });
      assert.equal(resolved.institution, null, junk);
      assert.equal(resolved.rejectedInstitutionFilter, true, junk);
    }
  });

  it("an absent filter means all institutions and is not a refusal", () => {
    const resolved = resolveUsageFilters({ institution: "  " });
    assert.equal(resolved.institution, null);
    assert.equal(resolved.rejectedInstitutionFilter, false);
  });

  it("unknown categories fall back to all; known ones pass", () => {
    assert.equal(resolveUsageFilters({ category: "billing" }).category, null);
    assert.equal(resolveUsageFilters({ category: "exam" }).category, "exam");
  });

  it("clamps pages to positive integers and pins the page size", () => {
    for (const page of [undefined, "0", "-3", "abc", ""]) {
      assert.equal(resolveUsageFilters({ page }).page, 1, String(page));
    }
    assert.equal(resolveUsageFilters({ page: "3" }).page, 3);
    assert.equal(resolveUsageFilters({}).pageSize, USAGE_ACTIVITY_PAGE_SIZE);
    // Array values (repeated params) take the first, never crash.
    assert.equal(resolveUsageFilters({ page: ["4", "9"] }).page, 4);
  });
});

// --- URL building (filters survive navigation) --------------------------------

const STATE = {
  from: null,
  to: null,
  preset: 30 as number | null,
  institution: null as string | null,
  category: null as string | null,
  page: 1,
};

describe("usageHref", () => {
  it("keeps the preset window in the link and omits page 1", () => {
    assert.equal(usageHref("/platform/usage", STATE), "/platform/usage?preset=30");
  });

  it("explicit dates win when no preset is active", () => {
    const href = usageHref("/platform/usage", {
      ...STATE,
      preset: null,
      from: "2026-10-01",
      to: "2026-10-07",
    });
    assert.equal(href, "/platform/usage?from=2026-10-01&to=2026-10-07");
  });

  it("pagination preserves institution and category", () => {
    const href = usageHref(
      "/platform/usage",
      { ...STATE, institution: UUID, category: "exam", page: 2 },
      { page: 3 },
    );
    assert.ok(href.includes("institution=" + UUID));
    assert.ok(href.includes("category=exam"));
    assert.ok(href.includes("page=3"));
  });

  it("changing the range or a filter resets to page 1", () => {
    const withPage = usageHref("/platform/usage", { ...STATE, page: 5 }, { preset: 7 });
    assert.equal(withPage.includes("page"), false);
    const filtered = usageHref(
      "/platform/usage",
      { ...STATE, page: 5 },
      { category: "platform" },
    );
    assert.equal(filtered.includes("page"), false);
    assert.ok(filtered.includes("category=platform"));
  });
});

// --- Timezone definition -------------------------------------------------------

describe("metric window definitions", () => {
  it("the screen's single timezone definition is UTC", () => {
    assert.equal(USAGE_TIMEZONE, "UTC");
    assert.equal(isoDayUtc(Date.UTC(2026, 0, 1, 23, 59, 59)), "2026-01-01");
    assert.equal(isoDayUtc(Date.UTC(2026, 0, 2, 0, 0, 0)), "2026-01-02");
  });
});
