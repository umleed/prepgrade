/**
 * Platform usage & activity — PURE layer (no Supabase, no Next).
 *
 * Rules this module encodes (AGENTS.md §5/§7, prompt 31 honesty contract):
 *  - Every time-based metric is defined in UTC and over a half-open
 *    [from, to) window. No local-timezone drift, no "today" ambiguity.
 *  - Untrusted searchParams are resolved/clamped here so the data layer can
 *    only ever receive a legal window, a bounded page, and catalog-backed
 *    filter values.
 *  - Series alignment NEVER invents a trend: a bucket with no rows is a real
 *    zero only when the underlying query SUCCEEDED. Query failure is a
 *    separate `unavailable` state, decided in the data layer.
 *  - Activity categories are derived from the closed audit-action catalog
 *    (lib/audit/platform.ts) — a client-supplied category string can only
 *    select among known action names, never arbitrary columns.
 */

import {
  PLATFORM_AUDIT_ACTIONS,
  isPlatformAuditAction,
  type PlatformAuditAction,
} from "./audit/platform.ts";

// --- Time zone & window constants ------------------------------------------

/** All usage metrics are computed in UTC; the UI states this explicitly. */
export const USAGE_TIMEZONE = "UTC";

export const MS_PER_DAY = 86_400_000;

/** Preset windows (inclusive UTC calendar days, ending "today"). */
export const USAGE_RANGE_PRESETS = [7, 30, 90] as const;
export type UsagePresetDays = (typeof USAGE_RANGE_PRESETS)[number];
export const USAGE_DEFAULT_PRESET_DAYS: UsagePresetDays = 30;

/** Hard cap on any custom window — protects the chart and the SQL scan. */
export const USAGE_MAX_RANGE_DAYS = 366;

/** Granularity is derived from span, never client-supplied. */
export type UsageGranularity = "day" | "week" | "month";

export function granularityForSpanDays(spanDays: number): UsageGranularity {
  if (spanDays <= 45) return "day";
  if (spanDays <= 180) return "week";
  return "month";
}

export const USAGE_GRANULARITY_LABELS: Record<UsageGranularity, string> = {
  day: "per day",
  week: "per week",
  month: "per month",
};

// --- Calendar helpers (UTC-anchored, no Date locale surprises) --------------

function dayStartUtc(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
}

/** "YYYY-MM-DD" for a UTC instant; null if the value is not a finite ms. */
export function isoDayUtc(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(dayStartUtc(ms));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse a strict `YYYY-MM-DD` calendar date into its UTC day-start ms.
 * Rejects non-padded formats, impossible months/days (2026-02-30), and
 * out-of-range years — invalid input must never silently shift a window.
 */
export function parseUtcDay(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 2000 || y > 2100) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return probe.getTime();
}

// --- Range resolution (untrusted searchParams → legal window) ---------------

export type ResolvedUsageRange = {
  /** Inclusive window start (UTC ms, day-aligned). */
  fromMs: number;
  /** Exclusive window end (UTC ms, day-aligned — end of the last day). */
  toMs: number;
  /** Inclusive calendar bounds for form echo / labels ("YYYY-MM-DD"). */
  fromDay: string;
  toDay: string;
  spanDays: number;
  granularity: UsageGranularity;
  /** The preset that produced this window, or null for an explicit range. */
  preset: UsagePresetDays | null;
  /** True when an over-long custom window was shortened to the cap. */
  clamped: boolean;
  /** True when inputs were missing/invalid and the default preset was used. */
  usedFallback: boolean;
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Resolve `?from=YYYY-MM-DD&to=YYYY-MM-DD` or `?preset=7|30|90` into a
 * UTC half-open window. Precedence: explicit valid from/to > preset >
 * default (last 30 days). Rules:
 *  - the window never extends past the end of the current UTC day;
 *  - inverted dates are swapped (forgiving but never invented);
 *  - spans beyond USAGE_MAX_RANGE_DAYS are clamped (flagged for the UI);
 *  - anything unparseable falls back to the default preset (flagged).
 */
export function resolveUsageRange(
  searchParams: {
    from?: string | string[];
    to?: string | string[];
    preset?: string | string[];
  },
  now: Date = new Date(),
): ResolvedUsageRange {
  const todayStart = dayStartUtc(now.getTime());
  // The window always ends at the END of the current UTC day, so "today" is
  // fully covered without leaking into tomorrow.
  const latestEnd = todayStart + MS_PER_DAY;

  const rawFrom = parseUtcDay(firstValue(searchParams.from));
  const rawTo = parseUtcDay(firstValue(searchParams.to));

  let fromMs: number;
  let toMs: number;
  let preset: UsagePresetDays | null = null;
  let clamped = false;
  let usedFallback = false;

  if (rawFrom !== null && rawTo !== null) {
    fromMs = Math.min(rawFrom, rawTo);
    toMs = Math.max(rawFrom, rawTo) + MS_PER_DAY; // inclusive of the `to` day
    if (toMs > latestEnd) toMs = latestEnd;
    if (fromMs >= toMs) fromMs = toMs - MS_PER_DAY; // degenerate → today only
    const spanMs = toMs - fromMs;
    if (spanMs > USAGE_MAX_RANGE_DAYS * MS_PER_DAY) {
      fromMs = toMs - USAGE_MAX_RANGE_DAYS * MS_PER_DAY;
      clamped = true;
    }
  } else {
    const rawPreset = Number.parseInt(firstValue(searchParams.preset), 10);
    const matched = (USAGE_RANGE_PRESETS as readonly number[]).includes(rawPreset)
      ? (rawPreset as UsagePresetDays)
      : null;
    preset = matched;
    usedFallback = matched === null;
    const days = matched ?? USAGE_DEFAULT_PRESET_DAYS;
    toMs = latestEnd;
    fromMs = todayStart - (days - 1) * MS_PER_DAY;
  }

  const spanDays = Math.round((toMs - fromMs) / MS_PER_DAY);
  return {
    fromMs,
    toMs,
    fromDay: isoDayUtc(fromMs) ?? "",
    toDay: isoDayUtc(toMs - MS_PER_DAY) ?? "",
    spanDays,
    granularity: granularityForSpanDays(spanDays),
    preset,
    clamped,
    usedFallback,
  };
}

// --- Buckets (contiguous UTC calendar series; gaps are real zeros) ---------

export type UsageBucket = {
  /** UTC ms of the bucket start (day / ISO-Monday / first-of-month). */
  startMs: number;
  endMs: number;
  /** "YYYY-MM-DD" of the bucket start — matches the SQL bucket key. */
  key: string;
  /** Short axis label (day/week: "5 Oct"; month: "Oct 2026"). */
  label: string;
};

/** Floor a UTC ms instant to the start of its week (Monday, ISO). */
function weekStartUtc(ms: number): number {
  const day = dayStartUtc(ms);
  const dow = new Date(day).getUTCDay(); // 0 = Sunday
  return day - ((dow + 6) % 7) * MS_PER_DAY;
}

function monthStartUtc(ms: number): number {
  const d = new Date(dayStartUtc(ms));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function floorToUnit(ms: number, granularity: UsageGranularity): number {
  if (granularity === "week") return weekStartUtc(ms);
  if (granularity === "month") return monthStartUtc(ms);
  return dayStartUtc(ms);
}

function nextUnit(ms: number, granularity: UsageGranularity): number {
  if (granularity === "week") return ms + 7 * MS_PER_DAY;
  if (granularity === "month") {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return ms + MS_PER_DAY;
}

function shortDayLabel(ms: number): string {
  const d = new Date(ms);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

function bucketLabel(ms: number, granularity: UsageGranularity): string {
  if (granularity === "month") {
    const d = new Date(ms);
    return shortDayLabel(ms).replace(/^\d+ /, "") + ` ${d.getUTCFullYear()}`;
  }
  return shortDayLabel(ms);
}

/**
 * Build the contiguous bucket series for a window. Buckets are aligned to UTC
 * day / ISO week / calendar month — exactly the boundaries used by
 * `date_trunc(... AT TIME ZONE 'UTC')` in the SQL function, so every event
 * counted by the database falls into the matching bucket here. A gap in the
 * data renders as a zero bar/point, never as a skipped bucket.
 */
export function buildUsageBuckets(
  fromMs: number,
  toMs: number,
  granularity: UsageGranularity,
): UsageBucket[] {
  const buckets: UsageBucket[] = [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return buckets;
  }
  let cursor = floorToUnit(fromMs, granularity);
  // Safety cap: presets/max range produce ≤ 366 day-buckets; refuse to build
  // an unbounded series if a caller passes a wild window.
  for (let guard = 0; cursor < toMs && guard < 500; guard += 1) {
    const endMs = nextUnit(cursor, granularity);
    buckets.push({
      startMs: cursor,
      endMs,
      key: isoDayUtc(cursor) ?? String(cursor),
      label: bucketLabel(cursor, granularity),
    });
    cursor = endMs;
  }
  return buckets;
}

// --- Series catalog & alignment ---------------------------------------------

/** The supported trend sources — every one has a real table today. */
export const USAGE_SERIES_KEYS = [
  "institutions",
  "accounts",
  "questions",
  "exams",
  "exam_attempts",
] as const;
export type UsageSeriesKey = (typeof USAGE_SERIES_KEYS)[number];

export const USAGE_SERIES_LABELS: Record<UsageSeriesKey, string> = {
  institutions: "New institutions",
  accounts: "New registered accounts",
  questions: "Questions created",
  exams: "Exams created",
  exam_attempts: "Exam attempts started",
};

/**
 * Sources that CANNOT be attributed to one institution: `profiles` has no
 * tenant column (accounts are platform-wide). When an institution filter is
 * active these series are dropped — never shown as an unfiltered platform
 * total that could be mistaken for the institution's own figure.
 */
export const PLATFORM_ONLY_SERIES: readonly UsageSeriesKey[] = ["accounts"];

export function applicableSeriesFor(institutionId: string | null): {
  sources: UsageSeriesKey[];
  omitted: UsageSeriesKey[];
} {
  if (!institutionId) return { sources: [...USAGE_SERIES_KEYS], omitted: [] };
  return {
    sources: USAGE_SERIES_KEYS.filter((key) => !PLATFORM_ONLY_SERIES.includes(key)),
    omitted: [...PLATFORM_ONLY_SERIES],
  };
}

/** One row of the time-series RPC result (PostgREST JSON shape). */
export type UsageSeriesRow = {
  source: string;
  /** "YYYY-MM-DD" UTC bucket start, as returned by the SQL function. */
  bucket_start: string;
  event_count: number | string;
};

export type UsageSeries = {
  source: UsageSeriesKey;
  label: string;
  /** One count per bucket, in bucket order. */
  points: number[];
  total: number;
  peak: number;
};

function toCount(value: number | string | null | undefined): number {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Align RPC rows onto the contiguous bucket series. Only rows whose source is
 * expected AND whose bucket_start matches a bucket key are counted; anything
 * else is dropped and surfaced via `droppedRows` so a caller/test can prove
 * nothing was silently fudged. A source with no matching rows is a REAL zero
 * series (the query succeeded) — unavailability is the data layer's call.
 */
export function alignUsageSeries(
  rows: readonly UsageSeriesRow[],
  buckets: readonly UsageBucket[],
  sources: readonly UsageSeriesKey[],
): { series: UsageSeries[]; droppedRows: number } {
  const keyIndex = new Map<string, number>();
  buckets.forEach((bucket, index) => keyIndex.set(bucket.key, index));

  const totals = new Map<UsageSeriesKey, number[]>();
  for (const source of sources) totals.set(source, buckets.map(() => 0));

  let dropped = 0;
  for (const row of rows) {
    const points = totals.get(row.source as UsageSeriesKey);
    const index = keyIndex.get(row.bucket_start);
    if (!points || index === undefined) {
      dropped += 1;
      continue;
    }
    points[index] += toCount(row.event_count);
  }

  const series = sources.map((source) => {
    const points = totals.get(source) ?? [];
    return {
      source,
      label: USAGE_SERIES_LABELS[source],
      points,
      total: points.reduce((sum, n) => sum + n, 0),
      peak: points.reduce((max, n) => (n > max ? n : max), 0),
    };
  });
  return { series, droppedRows: dropped };
}

/** True when every aligned series is all-zero (a successful empty window). */
export function seriesHaveNoActivity(series: readonly UsageSeries[]): boolean {
  return series.every((s) => s.total === 0);
}

// --- Activity categories (derived from the closed audit catalog) -----------

export const USAGE_ACTIVITY_CATEGORIES = [
  "platform",
  "institution",
  "membership",
  "application",
  "exam",
] as const;
export type UsageActivityCategory = (typeof USAGE_ACTIVITY_CATEGORIES)[number];

export const USAGE_ACTIVITY_CATEGORY_LABELS: Record<UsageActivityCategory, string> = {
  platform: "Platform security",
  institution: "Institution lifecycle",
  membership: "Membership & admin changes",
  application: "Registration applications",
  exam: "Exam operations",
};

/**
 * Map a catalog action to its category. Unknown/out-of-catalog strings yield
 * null — the UI then renders the raw stored action name and counts the row as
 * "Other" rather than guessing a category.
 */
export function categorizeAuditAction(action: string): UsageActivityCategory | null {
  if (!isPlatformAuditAction(action)) return null;
  if (action.startsWith("platform.")) return "platform";
  // Check the more specific prefix first: 'institution_application.*' also
  // starts with 'institution.'.
  if (action.startsWith("institution_application.")) return "application";
  if (action.startsWith("institution.")) return "institution";
  // membership.* — the prompt-33 sensitive role/access changes (teacher
  // grant & revoke), routed to their own category rather than diluted into
  // institution lifecycle.
  if (action.startsWith("membership.")) return "membership";
  if (action.startsWith("exam.")) return "exam";
  return null;
}

/** The action names belonging to one category — safe for an `.in()` filter
 *  because the names come from the catalog, never from the client. */
export function actionsForActivityCategory(
  category: UsageActivityCategory,
): PlatformAuditAction[] {
  return PLATFORM_AUDIT_ACTIONS.filter((action) => categorizeAuditAction(action) === category);
}

// --- Filter/query resolution for the whole screen ---------------------------

export const USAGE_ACTIVITY_PAGE_SIZE = 20;

/** institutions.id is a uuid (0001); anything else cannot match a tenant and
 *  would make the SQL uuid cast fail. The filter accepts ONLY this shape. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UsageFilters = {
  /** Institution id to filter by, or null for "all institutions".
   *  `rejectedInstitutionFilter` is true when the URL carried a value that
   *  is not a uuid — refused outright instead of silently widening or
   *  narrowing the view. */
  institution: string | null;
  rejectedInstitutionFilter: boolean;
  /** Activity category filter; unknown values fall back to "all". */
  category: UsageActivityCategory | null;
  page: number;
  pageSize: number;
};

export function resolveUsageFilters(searchParams: {
  institution?: string | string[];
  category?: string | string[];
  page?: string | string[];
}): UsageFilters {
  const rawInstitution = firstValue(searchParams.institution).trim();
  let institution: string | null = null;
  let rejectedInstitutionFilter = false;
  if (rawInstitution.length > 0) {
    if (UUID_PATTERN.test(rawInstitution)) {
      institution = rawInstitution.toLowerCase();
    } else {
      // Refuse the filter rather than apply a partial id, and never fall
      // back to "everything" silently — the UI shows the refusal.
      rejectedInstitutionFilter = true;
    }
  }

  const rawCategory = firstValue(searchParams.category).trim();
  const category = (USAGE_ACTIVITY_CATEGORIES as readonly string[]).includes(rawCategory)
    ? (rawCategory as UsageActivityCategory)
    : null;

  const parsed = Number.parseInt(firstValue(searchParams.page), 10);
  const page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;

  return { institution, rejectedInstitutionFilter, category, page, pageSize: USAGE_ACTIVITY_PAGE_SIZE };
}

// --- URL builders (filters survive pagination and range changes) ------------

export type UsageHrefState = {
  from: string | null;
  to: string | null;
  preset: number | null;
  institution: string | null;
  category: string | null;
  page: number;
};

/**
 * Build a /platform/usage URL from the current state plus a patch. Changing
 * the range or any filter resets the page to 1 unless a page is explicitly
 * part of the patch (pagination links pass it).
 */
export function usageHref(
  base: string,
  current: UsageHrefState,
  patch: Partial<UsageHrefState> = {},
): string {
  const merged: UsageHrefState = { ...current, ...patch };
  const rangeChanged =
    patch.from !== undefined ||
    patch.to !== undefined ||
    patch.preset !== undefined;
  const resetsPage =
    rangeChanged ||
    patch.institution !== undefined ||
    patch.category !== undefined;
  const page = patch.page ?? (resetsPage ? 1 : merged.page);

  const params = new URLSearchParams();
  if (merged.preset !== null) {
    params.set("preset", String(merged.preset));
  } else if (merged.from && merged.to) {
    params.set("from", merged.from);
    params.set("to", merged.to);
  }
  if (merged.institution) params.set("institution", merged.institution);
  if (merged.category) params.set("category", merged.category);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
