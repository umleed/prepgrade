/**
 * Platform usage & activity data access — SERVER-ONLY.
 *
 * Backs /platform/usage (the super-admin operational view). Same posture as
 * lib/data/platform-overview.ts (prompt 31): every figure is a live query
 * against a table/function that actually exists, each source degrades
 * INDEPENDENTLY, and "unavailable" is never flattened into 0 — a failed
 * count renders as "Not available", a successful zero renders as a real
 * zero. Cross-tenant reads are legitimate ONLY here, and only after the
 * caller has passed `requireSuperAdmin()`; nothing in this file enforces
 * auth itself.
 *
 * PRIVACY (AGENTS.md §7): counts and aggregates only. No learner rows, no
 * emails. The activity feed shows platform-audit rows (server operators'
 * actions), whose actor field is the Clerk id of the acting account — the
 * same minimal projection the audit screen already renders.
 */

import "server-only";
import { createAdminClient, DataSourceUnavailableError } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingTableError, type MetricState } from "@/lib/data/platform-overview";
import {
  AUDIT_SELECT,
  toEntry,
  type AuditRow,
  type PlatformAuditEntry,
} from "@/lib/data/audit";
import {
  actionsForActivityCategory,
  alignUsageSeries,
  type ResolvedUsageRange,
  type UsageActivityCategory,
  type UsageBucket,
  type UsageSeries,
  type UsageSeriesKey,
  type UsageSeriesRow,
} from "@/lib/platform-usage";
import { INSTITUTION_AUDIT_TARGET_TYPE } from "@/lib/audit/platform";

/** Postgres undefined_function (42883) / PostgREST schema-cache miss for a
 *  routine (PGRST202) — the time-series RPC has not been migrated in this
 *  environment. Same honest treatment as a missing table. */
function isMissingFunctionError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42883" || code === "PGRST202";
}

function isMissingSourceError(error: unknown): boolean {
  return isMissingTableError(error) || isMissingFunctionError(error);
}

function unavailable(error: unknown): MetricState<never> {
  return {
    state: "unavailable",
    reason: isMissingSourceError(error) ? "missing_table" : "error",
  };
}

/** Same classification for the richer series state shape. */
function seriesUnavailable(error: unknown): UsageSeriesState {
  return {
    state: "unavailable",
    reason: isMissingSourceError(error) ? "missing_table" : "error",
  };
}

/** Run one query, mapping thrown/errored results to a MetricState. */
async function probe<T>(
  run: (supabase: SupabaseClient) => Promise<MetricState<T>>,
): Promise<MetricState<T>> {
  try {
    return await run(createAdminClient());
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      return { state: "unavailable", reason: "error" };
    }
    return unavailable(error) as MetricState<T>;
  }
}

/** Head count with the few filters this screen needs (eq only). */
type CountBuilder = PromiseLike<{ count: number | null; error: { code?: string } | null }> & {
  eq: (column: string, value: unknown) => CountBuilder;
};

async function countRows(
  supabase: SupabaseClient,
  table: string,
  filters: (builder: CountBuilder) => CountBuilder = (b) => b,
): Promise<MetricState<number>> {
  try {
    const base = supabase
      .from(table)
      .select("*", { count: "exact", head: true }) as unknown as CountBuilder;
    const { count, error } = await filters(base);
    if (error) return unavailable(error);
    return { state: "available", value: count ?? 0 };
  } catch (error) {
    return unavailable(error);
  }
}

function eqIf(builder: CountBuilder, column: string, value: string | null): CountBuilder {
  return value ? builder.eq(column, value) : builder;
}

// --- Current usage snapshot (lifetime totals, as of now) --------------------

export type UsageSnapshot = {
  /** institutions with status='active' — the operational flag from 0008. */
  activeInstitutions: MetricState<number>;
  /** All institution rows (created tenants). */
  totalInstitutions: MetricState<number>;
  /**
   * Registered accounts — `profiles` rows PLATFORM-WIDE (profiles has no
   * tenant column, so under an institution filter this is intentionally
   * unavailable rather than a borrowed memberships number).
   */
  accounts: MetricState<number>;
  /** profiles.is_active = true — the honest "active account" definition. */
  activeAccounts: MetricState<number>;
  /** institution_memberships rows for the filtered tenant, else unavailable.
   *  This is the tenant-attributable user count (never called "users"
   *  platform-wide without its own definition). */
  members: MetricState<number>;
  /** Live (status='active') questions. */
  questions: MetricState<number>;
  exams: MetricState<number>;
  publishedExams: MetricState<number>;
  attempts: MetricState<number>;
  submittedAttempts: MetricState<number>;
};

/**
 * Collect the current-usage snapshot. `institutionId` (already resolved to a
 * real uuid by the pure layer) narrows every tenant-attributable count; the
 * account counts stay platform-wide by definition and report unavailable
 * under a tenant filter instead of pretending attribution.
 */
export async function getUsageSnapshot(
  institutionId: string | null,
): Promise<UsageSnapshot> {
  const [
    activeInstitutions,
    totalInstitutions,
    accounts,
    activeAccounts,
    members,
    questions,
    exams,
    publishedExams,
    attempts,
    submittedAttempts,
  ] = await Promise.all([
    probe((s) =>
      countRows(s, "institutions", (b) =>
        eqIf(b.eq("status", "active"), "id", institutionId),
      ),
    ),
    probe((s) => countRows(s, "institutions", (b) => eqIf(b, "id", institutionId))),
    institutionId
      ? Promise.resolve({
          state: "unavailable",
          reason: "missing_table",
        } as MetricState<number>)
      : probe((s) => countRows(s, "profiles")),
    institutionId
      ? Promise.resolve({
          state: "unavailable",
          reason: "missing_table",
        } as MetricState<number>)
      : probe((s) => countRows(s, "profiles", (b) => b.eq("is_active", true))),
    institutionId
      ? probe((s) =>
          countRows(s, "institution_memberships", (b) =>
            b.eq("institution_id", institutionId),
          ),
        )
      : Promise.resolve({
          state: "unavailable",
          reason: "missing_table",
        } as MetricState<number>),
    probe((s) =>
      countRows(s, "questions", (b) =>
        eqIf(b.eq("status", "active"), "institution_id", institutionId),
      ),
    ),
    probe((s) => countRows(s, "exams", (b) => eqIf(b, "institution_id", institutionId))),
    probe((s) =>
      countRows(s, "exams", (b) =>
        eqIf(b.eq("status", "published"), "institution_id", institutionId),
      ),
    ),
    probe((s) =>
      countRows(s, "exam_attempts", (b) => eqIf(b, "institution_id", institutionId)),
    ),
    probe((s) =>
      countRows(s, "exam_attempts", (b) =>
        eqIf(b.eq("status", "submitted"), "institution_id", institutionId),
      ),
    ),
  ]);

  return {
    activeInstitutions,
    totalInstitutions,
    accounts,
    activeAccounts,
    members,
    questions,
    exams,
    publishedExams,
    attempts,
    submittedAttempts,
  };
}

// --- Activity over time (UTC buckets from the SQL aggregate) ----------------

export type UsageSeriesState =
  | { state: "available"; series: UsageSeries[]; droppedRows: number }
  | { state: "unavailable"; reason: "missing_table" | "error" };

/**
 * Fetch and align the time-series for the resolved window. A successful call
 * with no rows yields REAL zero series (nothing happened in the period); a
 * failed call yields `unavailable` — the two must never be confused in the
 * UI. `sources`/`omitted` come from `applicableSeriesFor` in the pure layer
 * (platform-only series are dropped under an institution filter).
 */
export async function getUsageTimeSeries(
  range: ResolvedUsageRange,
  buckets: UsageBucket[],
  sources: UsageSeriesKey[],
  institutionId: string | null,
): Promise<UsageSeriesState> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("platform_usage_time_series", {
      p_from: new Date(range.fromMs).toISOString(),
      // The SQL window is half-open, exactly like the bucket series.
      p_to: new Date(range.toMs).toISOString(),
      p_granularity: range.granularity,
      p_institution_id: institutionId,
    });
    if (error) return seriesUnavailable(error);

    const aligned = alignUsageSeries(
      (data ?? []) as unknown as UsageSeriesRow[],
      buckets,
      sources,
    );
    return { state: "available", series: aligned.series, droppedRows: aligned.droppedRows };
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      return { state: "unavailable", reason: "error" };
    }
    return seriesUnavailable(error);
  }
}

// --- Institution filter options ---------------------------------------------

export type InstitutionOption = { id: string; name: string };

export type InstitutionOptionsResult = {
  options: InstitutionOption[];
  total: number;
  /** True when more institutions exist than options listed (cap applied). */
  truncated: boolean;
};

const INSTITUTION_OPTIONS_LIMIT = 500;

/**
 * id/name list for the server-side institution filter dropdown. Names only —
 * no contact or profile fields leave the tenant table (AGENTS.md §7). The
 * cap is reported, never hidden: the UI says when the list is partial.
 */
export async function listInstitutionOptions(): Promise<InstitutionOptionsResult> {
  const supabase = createAdminClient();
  const { data, error, count } = await supabase
    .from("institutions")
    .select("id, name", { count: "exact" })
    .order("name", { ascending: true })
    .range(0, INSTITUTION_OPTIONS_LIMIT - 1);
  if (error) throw error;
  const rows = (data ?? []) as unknown as InstitutionOption[];
  const total = count ?? 0;
  return { options: rows, total, truncated: total > rows.length };
}

// --- Server-filtered activity table (platform_audit_log) --------------------

export type UsageActivityQuery = {
  range: ResolvedUsageRange;
  institution: string | null;
  category: UsageActivityCategory | null;
  page: number;
  pageSize: number;
};

export type UsageActivityRow = PlatformAuditEntry & {
  /** Display name for the attributed institution, null when the row is not
   *  institution-attributed or the name lookup failed (rendered "—", never
   *  a guess). */
  institutionName: string | null;
  /** True when the row carries an institution target (drill-down link). */
  linksToInstitution: boolean;
};

export type UsageActivityResult = {
  rows: UsageActivityRow[];
  total: number;
  /** True when the audit read succeeded but the optional name enrichment
   *  failed — the table still shows ids, just not names. */
  namesUnavailable: boolean;
};

/**
 * Read the activity window from the append-only audit log with ALL filters
 * applied server-side (date range, category → catalog action list,
 * institution → trusted target pair). Attribution follows the same rule as
 * institutionActivityFilter: only rows the SERVER tagged with
 * target_type='institution' belong to a tenant — there is no tenant column.
 * Caller must be an authorised SUPER_ADMIN.
 */
export async function listUsageActivity(
  query: UsageActivityQuery,
): Promise<UsageActivityResult> {
  const supabase = createAdminClient();

  let builder = supabase
    .from("platform_audit_log")
    .select(AUDIT_SELECT, { count: "exact" })
    .gte("created_at", new Date(query.range.fromMs).toISOString())
    .lt("created_at", new Date(query.range.toMs).toISOString());

  if (query.category) {
    // Values come from the closed catalog, never from the request body.
    builder = builder.in("action", actionsForActivityCategory(query.category));
  }
  if (query.institution) {
    builder = builder
      .eq("target_type", INSTITUTION_AUDIT_TARGET_TYPE)
      .eq("target_id", query.institution);
  }

  const from = (query.page - 1) * query.pageSize;
  const { data, error, count } = await builder
    .order("created_at", { ascending: false })
    .range(from, from + query.pageSize - 1);
  if (error) throw error;

  const entries = (data ?? []).map((row) => toEntry(row as unknown as AuditRow));
  const total = count ?? 0;

  // Name enrichment for the institution-attributed rows on THIS page. A
  // failure degrades names to null — the ids and links still render, and
  // the page states that names are unavailable.
  const institutionIds = Array.from(
    new Set(
      entries
        .filter(
          (entry) =>
            entry.targetType === INSTITUTION_AUDIT_TARGET_TYPE && entry.targetId,
        )
        .map((entry) => entry.targetId as string),
    ),
  );

  const namesById = new Map<string, string>();
  let namesUnavailable = false;
  if (institutionIds.length > 0) {
    const { data: nameRows, error: nameError } = await supabase
      .from("institutions")
      .select("id, name")
      .in("id", institutionIds);
    if (nameError) {
      namesUnavailable = true;
    } else {
      for (const raw of (nameRows ?? []) as unknown as InstitutionOption[]) {
        namesById.set(raw.id, raw.name);
      }
    }
  }

  return {
    total,
    namesUnavailable,
    rows: entries.map((entry) => {
      const linksToInstitution =
        entry.targetType === INSTITUTION_AUDIT_TARGET_TYPE &&
        entry.targetId !== null;
      return {
        ...entry,
        linksToInstitution,
        institutionName:
          linksToInstitution && entry.targetId
            ? (namesById.get(entry.targetId) ?? null)
            : null,
      };
    }),
  };
}
