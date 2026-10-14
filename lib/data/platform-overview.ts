/**
 * Platform overview metrics — SERVER-ONLY data access for the super-admin
 * dashboard (prompt 31).
 *
 * HONEST DATA SOURCES ONLY. Every figure is a live count against a table that
 * actually exists in the current schema (migrations 0001–0006). Metrics whose
 * tables have not been built yet — exams, attempts, results, system health —
 * are reported as `missing_table` states, NOT as zero: on a dashboard, 0 and
 * "unavailable" must never be confused (the institution dashboard follows the
 * same rule). Each query is wrapped independently so one failing source
 * degrades to an `error` state instead of blanking the whole page.
 *
 * SERVICE-ROLE SCOPE (AGENTS.md §5, §7): these queries intentionally have no
 * `institution_id` filter — the platform overview is the one legitimate
 * cross-tenant read — so the caller MUST be an authorised SUPER_ADMIN (see
 * `requireSuperAdmin` in lib/auth/guards.ts). Reads are counts and minimal
 * lists only: no student or teacher personal rows are selected, and the
 * recent-institutions list carries institution names and member counts, not
 * learner-level data.
 */

import "server-only";
import { createAdminClient, DataSourceUnavailableError } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { USER_ROLES, type UserRole } from "@/lib/auth/roles";
import {
  canTransitionInstitutionStatus,
  isInstitutionStatus,
  toInstitutionContainsPattern,
  type InstitutionStatus,
} from "@/lib/institutions";

/**
 * A metric that may be genuinely unavailable. `value` is only meaningful for
 * `available` — a missing table or a failed query renders as "unavailable"
 * in the UI, never as 0.
 */
export type MetricState<T> =
  | { state: "available"; value: T }
  | { state: "unavailable"; reason: "missing_table" | "error" };

export type RoleCount = {
  role: UserRole;
  count: number;
};

export type RecentInstitution = {
  id: string;
  name: string;
  createdAt: string;
  /** Total memberships, or null when the count could not be resolved. */
  memberCount: number | null;
};

export type PlatformOverview = {
  /** Rows in `institutions` (the table has no lifecycle column yet, so this
   *  is "institutions created", stated as such in the UI). */
  institutions: MetricState<number>;
  /** Rows in `profiles` — accounts provisioned by the auth flow. */
  accounts: MetricState<number>;
  /** Active accounts (`profiles.is_active`). */
  activeAccounts: MetricState<number>;
  /** `institution_memberships` grouped by role — role distribution. */
  roleDistribution: MetricState<RoleCount[]>;
  /** Live (non-archived) rows in `questions`. */
  questions: MetricState<number>;
  /** Exams/assessments — the tables arrive with prompts 17–19. */
  assessments: MetricState<number>;
  /** The five most recently created institutions. */
  recentInstitutions: MetricState<RecentInstitution[]>;
};

/** Postgres 42P01 (undefined_table) or PostgREST PGRST205 (schema-cache miss
 *  for an unknown relation) — the relation does not exist yet, i.e. a
 *  migration that has not been applied or a subsystem not yet built. Distinct
 *  from a network/permission error so the UI can say "not yet available"
 *  truthfully instead of showing a fabricated zero. */
function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205";
}

function unavailable(error: unknown): MetricState<never> {
  return { state: "unavailable", reason: isMissingTableError(error) ? "missing_table" : "error" };
}

/** Head-count helper: exact count, no rows transferred. The builder type is
 *  the thenable result of a `select()` call, widened through `unknown` at the
 *  filter step because the helper accepts optional extra filters — the filters
 *  below only chain more `.eq()` calls, which every PostgREST builder has. */
type CountQuery = { count: number | null; error: { code?: string; message?: string } | null };
type CountBuilder = PromiseLike<CountQuery> & {
  eq: (column: string, value: unknown) => CountBuilder;
};

async function countRows(
  supabase: SupabaseClient,
  table: string,
  filters: (builder: CountBuilder) => CountBuilder = (builder) => builder,
): Promise<MetricState<number>> {
  try {
    const base = supabase
      .from(table)
      .select("*", { count: "exact", head: true }) as unknown as CountBuilder;
    const { count, error } = await filters(base);
    if (error) return unavailable(error);
    return { state: "available", value: count ?? 0 };
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      return { state: "unavailable", reason: "error" };
    }
    return unavailable(error);
  }
}

/** Run one metric query, mapping thrown/errored results to a state. */
async function metric<T>(
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

/**
 * Collect the platform overview. Each metric degrades independently; the
 * page renders whatever came back honestly.
 */
export async function getPlatformOverview(): Promise<PlatformOverview> {
  const [institutions, accounts, activeAccounts, roleDistribution, questions, assessments, recentInstitutions] =
    await Promise.all([
      metric((supabase) => countRows(supabase, "institutions")),
      metric((supabase) => countRows(supabase, "profiles")),
      metric((supabase) =>
        countRows(supabase, "profiles", (b) => b.eq("is_active", true)),
      ),
      metric(async (supabase) => {
        // Membership rows are read to bucket counts by role; no personal
        // columns are selected.
        try {
          const { data, error } = await supabase
            .from("institution_memberships")
            .select("role");
          if (error) return unavailable(error);
          const counts = new Map<string, number>();
          for (const row of data ?? []) {
            const role = (row as { role: string }).role;
            counts.set(role, (counts.get(role) ?? 0) + 1);
          }
          const rows: RoleCount[] = (
            USER_ROLES as readonly UserRole[]
          ).map((role) => ({ role, count: counts.get(role) ?? 0 }));
          return { state: "available", value: rows };
        } catch (error) {
          return unavailable(error);
        }
      }),
      metric((supabase) =>
        countRows(supabase, "questions", (b) => b.eq("status", "active")),
      ),
      // Exams and attempts do not exist in the schema yet (prompts 17–24).
      // Attempting the query anyway keeps this honest: if the tables land
      // without this file being updated, the metric disappears rather than
      // lying — but today it reports the real missing-table state.
      metric((supabase) => countRows(supabase, "exams")),
      metric(async (supabase) => {
        try {
          const { data, error } = await supabase
            .from("institutions")
            .select("id, name, created_at")
            .order("created_at", { ascending: false })
            .limit(5);
          if (error) return unavailable(error);

          const rows = (data ?? []) as unknown as {
            id: string;
            name: string;
            created_at: string;
          }[];

          // One aggregate query for member counts of the listed institutions;
          // a failure here degrades member counts to null ("unavailable"),
          // never to a fabricated 0.
          const memberCounts = new Map<string, number>();
          let membershipCountsAvailable = true;
          if (rows.length > 0) {
            const { data: membershipRows, error: membershipError } = await supabase
              .from("institution_memberships")
              .select("institution_id")
              .in("institution_id", rows.map((row) => row.id));
            if (membershipError) {
              membershipCountsAvailable = false;
            } else {
              for (const row of membershipRows ?? []) {
                const id = (row as { institution_id: string }).institution_id;
                memberCounts.set(id, (memberCounts.get(id) ?? 0) + 1);
              }
            }
          }

          return {
            state: "available",
            value: rows.map((row) => ({
              id: row.id,
              name: row.name,
              createdAt: row.created_at,
              memberCount: membershipCountsAvailable
                ? (memberCounts.get(row.id) ?? 0)
                : null,
            })),
          } as MetricState<RecentInstitution[]>;
        } catch (error) {
          return unavailable(error);
        }
      }),
    ]);

  return {
    institutions,
    accounts,
    activeAccounts,
    roleDistribution,
    questions,
    assessments,
    recentInstitutions,
  };
}

// --- Institution directory (read-only, platform-scoped) --------------------

export type PlatformInstitutionRow = {
  id: string;
  name: string;
  createdAt: string;
  /** Operational status (0008). Never null: the column is NOT NULL with an
   *  'active' default, so pre-existing rows read back as 'active'. */
  status: InstitutionStatus;
  /** Coarse type (0008); null when never set — rendered "Not set", never a
   *  guess. */
  type: string | null;
  /** Member counts from `institution_memberships`; null when the count
   *  query failed (rendered as "unavailable", never as 0). SUPER_ADMIN is
   *  platform-scoped and never carries a tenant row, so it is not bucketed. */
  members: { total: number; admins: number; teachers: number; students: number } | null;
};

export type PlatformInstitutionList = {
  rows: PlatformInstitutionRow[];
  total: number;
};

/**
 * Paginated, searchable institution directory for the platform area. Names,
 * status, type, and counts only — no learner-level rows leave the tenant
 * tables. Caller must be an authorised SUPER_ADMIN (requireSuperAdmin), same
 * rule as the overview. `q` and `status` arrive from untrusted searchParams
 * and are already sanitised by resolveInstitutionDirectoryQuery, but the
 * status filter is re-checked here (fail-closed) so a caller that skips the
 * resolver still cannot inject an arbitrary column value.
 */
export async function listPlatformInstitutions(query: {
  page: number;
  pageSize: number;
  q?: string;
  status?: InstitutionStatus | null;
}): Promise<PlatformInstitutionList> {
  const supabase = createAdminClient();

  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  let builder = supabase
    .from("institutions")
    .select("id, name, created_at, status, institution_type", { count: "exact" });

  const pattern = query.q ? toInstitutionContainsPattern(query.q) : "";
  if (pattern) builder = builder.ilike("name", pattern);
  if (query.status && isInstitutionStatus(query.status)) {
    builder = builder.eq("status", query.status);
  }

  const { data, error, count } = await builder
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) throw error;

  const rows = (data ?? []) as unknown as {
    id: string;
    name: string;
    created_at: string;
    status: string;
    institution_type: string | null;
  }[];

  // Membership buckets for the listed ids in one query; failure degrades the
  // counts to null for the page rather than dropping the directory.
  const countsById = new Map<string, { admins: number; teachers: number; students: number }>();
  let countsAvailable = true;
  if (rows.length > 0) {
    const { data: membershipRows, error: membershipError } = await supabase
      .from("institution_memberships")
      .select("institution_id, role")
      .in("institution_id", rows.map((row) => row.id));

    if (membershipError) {
      countsAvailable = false;
    } else {
      for (const raw of membershipRows ?? []) {
        const row = raw as { institution_id: string; role: string };
        const current =
          countsById.get(row.institution_id) ?? { admins: 0, teachers: 0, students: 0 };
        if (row.role === "INSTITUTION_ADMIN") current.admins += 1;
        else if (row.role === "TEACHER") current.teachers += 1;
        else if (row.role === "STUDENT") current.students += 1;
        countsById.set(row.institution_id, current);
      }
    }
  }

  return {
    total: count ?? 0,
    rows: rows.map((row) => {
      const counts = countsAvailable
        ? (countsById.get(row.id) ?? { admins: 0, teachers: 0, students: 0 })
        : null;
      return {
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        // A stored value outside the catalog degrades to 'active' defensively
        // for rendering; the CHECK in 0008 makes that impossible in practice.
        status: isInstitutionStatus(row.status) ? row.status : "active",
        type: row.institution_type,
        members: counts
          ? {
              total: counts.admins + counts.teachers + counts.students,
              admins: counts.admins,
              teachers: counts.teachers,
              students: counts.students,
            }
          : null,
      };
    }),
  };
}

// --- Institution status counts (directory summary cards, prompt 32 UI) ------

export type InstitutionStatusCounts = {
  total: number;
  byStatus: Record<InstitutionStatus, number>;
};

/**
 * Head-count of institutions per operational status, used by the directory
 * summary cards and status tabs. Every number is a live filtered count over
 * `institutions` (no lifecycle history exists, so no deltas are invented).
 * Any failing count degrades the whole result to an unavailable state — a
 * partial breakdown is never rendered as if it were complete.
 */
export async function getInstitutionStatusCounts(): Promise<
  MetricState<InstitutionStatusCounts>
> {
  return metric(async (supabase) => {
    const [total, active, suspended, archived] = await Promise.all([
      countRows(supabase, "institutions"),
      countRows(supabase, "institutions", (b) => b.eq("status", "active")),
      countRows(supabase, "institutions", (b) => b.eq("status", "suspended")),
      countRows(supabase, "institutions", (b) => b.eq("status", "archived")),
    ]);

    const parts = [total, active, suspended, archived];
    const failed = parts.find((part) => part.state === "unavailable");
    if (failed && failed.state === "unavailable") {
      return { state: "unavailable", reason: failed.reason };
    }

    return {
      state: "available",
      value: {
        total: total.state === "available" ? total.value : 0,
        byStatus: {
          active: active.state === "available" ? active.value : 0,
          suspended: suspended.state === "available" ? suspended.value : 0,
          archived: archived.state === "available" ? archived.value : 0,
        },
      },
    };
  });
}

// --- Institution detail (single tenant, minimal personal data) --------------

export type PlatformInstitutionDetail = {
  id: string;
  name: string;
  type: string | null;
  status: InstitutionStatus;
  createdAt: string;
  /** Membership rows bucketed by trusted role for THIS tenant; unavailable
   *  (never a fabricated zero) if the read failed. */
  members: MetricState<RoleCount[]>;
  /** Classes defined for this tenant (migration 0004). */
  classes: MetricState<number>;
  /** Active questions authored in this tenant's bank (content activity). */
  questions: MetricState<number>;
  /** Exams/assessments — tables arrive with prompts 17–19, so today this is
   *  a genuine missing-table state, shown as "not yet available". */
  assessments: MetricState<number>;
};

/**
 * Read one institution's operational detail for the platform directory.
 * Counts and tenant-level metadata only — no learner rows are selected, so a
 * super-admin inspection never exfiltrates personal data (AGENTS.md §7). The
 * caller MUST be an authorised SUPER_ADMIN; the id comes from the URL and is
 * used only to filter a platform-scoped read, never to bypass the guard.
 * Returns null when no such institution exists (a bad/removed id).
 */
export async function getPlatformInstitutionDetail(
  id: string,
): Promise<PlatformInstitutionDetail | null> {
  // Top-level read throws DataSourceUnavailableError when Supabase is not
  // configured, so the page can render an honest "not configured" state
  // rather than a false "not found".
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("institutions")
    .select("id, name, created_at, status, institution_type")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as {
    id: string;
    name: string;
    created_at: string;
    status: string;
    institution_type: string | null;
  };

  const [members, classes, questions, assessments] = await Promise.all([
    metric(async (client) => {
      try {
        const { data: roleRows, error: roleError } = await client
          .from("institution_memberships")
          .select("role")
          .eq("institution_id", row.id);
        if (roleError) return unavailable(roleError);
        const counts = new Map<string, number>();
        for (const r of roleRows ?? []) {
          const role = (r as { role: string }).role;
          counts.set(role, (counts.get(role) ?? 0) + 1);
        }
        const buckets: RoleCount[] = (USER_ROLES as readonly UserRole[]).map(
          (role) => ({ role, count: counts.get(role) ?? 0 }),
        );
        return { state: "available", value: buckets };
      } catch (e) {
        return unavailable(e);
      }
    }),
    metric((client) =>
      countRows(client, "classes", (b) => b.eq("institution_id", row.id)),
    ),
    metric((client) =>
      countRows(client, "questions", (b) =>
        b.eq("institution_id", row.id).eq("status", "active"),
      ),
    ),
    // Exams do not exist yet (prompts 17–19); querying anyway reports the
    // real missing-table state rather than a fabricated 0.
    metric((client) =>
      countRows(client, "exams", (b) => b.eq("institution_id", row.id)),
    ),
  ]);

  return {
    id: row.id,
    name: row.name,
    type: row.institution_type,
    status: isInstitutionStatus(row.status) ? row.status : "active",
    createdAt: row.created_at,
    members,
    classes,
    questions,
    assessments,
  };
}

// --- Approved status change (the one sensitive write in this area) ----------

export type SetInstitutionStatusResult =
  | { ok: true; from: InstitutionStatus; to: InstitutionStatus }
  | {
      ok: false;
      reason: "notFound" | "invalidTransition" | "noChange" | "conflict";
    };

/**
 * Apply an APPROVED operational-status change to one institution.
 *
 * The current status is read server-side and the transition is validated
 * against the stored value via the pure policy in lib/institutions.ts — a
 * client-supplied "from" is never trusted (AGENTS.md §5). Only legal moves
 * write; an illegal or no-op transition returns a reason and changes nothing.
 * The caller MUST be an authorised SUPER_ADMIN (the server action enforces
 * this before calling); this data-layer function performs no auth itself.
 *
 * CONCURRENCY (compare-and-swap): the read and the write are two round-trips,
 * so a plain `.eq("id")` update would let two racing requests both pass
 * validation and silently clobber each other (a lost update). The write is
 * therefore made CONDITIONAL on the status we just read (`.eq("status",
 * current)`) with an exact affected-row count: if another request committed a
 * change in between, zero rows match and we report `conflict` rather than
 * applying a transition that is no longer legal from the real current state.
 * This is optimistic concurrency without needing a transaction/RPC; a true
 * read-modify-write transaction would additionally make the change and its
 * audit record atomic (see the completion notes).
 */
export async function setInstitutionStatus(
  id: string,
  next: InstitutionStatus,
): Promise<SetInstitutionStatusResult> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("institutions")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, reason: "notFound" };

  const currentRaw = (data as unknown as { status: string }).status;
  // A stored value outside the catalog is treated as not-found rather than
  // acted on: refuse to transition from a state we cannot name.
  if (!isInstitutionStatus(currentRaw)) return { ok: false, reason: "notFound" };
  const current = currentRaw;

  if (current === next) return { ok: false, reason: "noChange" };
  if (!canTransitionInstitutionStatus(current, next)) {
    return { ok: false, reason: "invalidTransition" };
  }

  // Conditional (compare-and-swap) write: only succeeds if the status is still
  // the value we validated against. A concurrent change matches 0 rows.
  const { error: updateError, count } = await supabase
    .from("institutions")
    .update({ status: next }, { count: "exact" })
    .eq("id", id)
    .eq("status", current);
  if (updateError) throw updateError;
  if (!count) return { ok: false, reason: "conflict" };

  return { ok: true, from: current, to: next };
}
