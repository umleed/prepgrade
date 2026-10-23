/**
 * Platform users directory — SERVER-ONLY data access for the super-admin
 * "Users" section.
 *
 * Same posture as lib/data/platform-overview.ts / platform-usage.ts: every
 * figure is a live query against a table that actually exists, cross-tenant
 * reads are legitimate ONLY after the caller has passed `requireSuperAdmin()`
 * (nothing here enforces auth itself), and unavailable counts degrade to an
 * honest state instead of a fabricated zero.
 *
 * PRIVACY (AGENTS.md §7): the directory selects only the minimal operational
 * projection — name, email, roster code, tenant, role, status. No other
 * profile column ever leaves the database.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  USER_DIRECTORY_SCOPES,
  normalizeMembershipRows,
  normalizeProfileRows,
  normalizeRosterRows,
  toUserSearchOrClause,
  USER_SEARCH_PROFILE_CAP,
  type RawMembershipRow,
  type RawProfileRow,
  type RawRosterRow,
  type UserDirectoryQuery,
  type UserDirectoryRow,
  type UserDirectoryScope,
} from "@/lib/platform-users";

export type PlatformUserListResult = {
  rows: UserDirectoryRow[];
  total: number;
  /** True when a name/email search matched more profiles than the helper cap,
   *  so the accounts tab may miss some matches — reported, never hidden. */
  searchTruncated: boolean;
};

/** Tab counts: one live head count per scope under the tenant filter. A
 *  failing count degrades the whole map to null (never a partial set shown
 *  as complete). */
export type PlatformUserScopeCounts = Partial<Record<UserDirectoryScope, number>>;

const MEMBERSHIP_SELECT =
  "id, role, status, institution_id, user_id, institution:institutions(id, name), profile:profiles(id, full_name, email, is_active, created_at)";

const STUDENT_SELECT =
  "id, institution_id, class_id, student_code, full_name, status, created_at, institution:institutions(id, name), class:classes(id, name)";

const TEACHER_SELECT =
  "id, institution_id, employee_code, full_name, email, status, created_at, institution:institutions(id, name)";

const PROFILE_SELECT = "id, email, full_name, is_active, created_at";

/** Apply the tenant filter to a builder (fail-closed: only ever an eq on a
 *  validated UUID decided by the pure resolver upstream). */
function withInstitution<T extends { eq: (column: string, value: unknown) => T }>(
  builder: T,
  column: string,
  institutionId: string | null,
): T {
  return institutionId ? builder.eq(column, institutionId) : builder;
}

/**
 * Resolve the set of profile ids whose name/email matches the search term,
 * for the accounts scope (memberships carries no name columns of its own).
 * Returns null when there is no search term (no filter), or a (possibly
 * empty) id list plus a truncation flag when there is.
 */
async function searchProfileIds(
  supabase: SupabaseClient,
  term: string,
): Promise<{ ids: string[]; truncated: boolean } | null> {
  if (!term) return null;
  const or = toUserSearchOrClause(term, ["full_name", "email"]);
  if (!or) return { ids: [], truncated: false };
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .or(or)
    .order("created_at", { ascending: false })
    .range(0, USER_SEARCH_PROFILE_CAP - 1);
  if (error) throw error;
  const ids = (data ?? []).map((row) => (row as { id: string }).id);
  return { ids, truncated: ids.length >= USER_SEARCH_PROFILE_CAP };
}

/**
 * Paginated, searchable user directory for one scope. Caller must be an
 * authorised SUPER_ADMIN; every value in `query` must already have passed
 * `resolveUserDirectoryQuery` (clamped/dropped), but UUID-shape and role
 * checks are re-applied here fail-closed so a caller that skips the resolver
 * still cannot inject an arbitrary column value.
 */
export async function listPlatformUsers(
  query: UserDirectoryQuery,
): Promise<PlatformUserListResult> {
  const supabase = createAdminClient();
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;
  let searchTruncated = false;

  if (query.scope === "accounts") {
    let builder = supabase.from("institution_memberships").select(MEMBERSHIP_SELECT, {
      count: "exact",
    });
    builder = withInstitution(builder, "institution_id", query.institutionId);
    if (query.role) builder = builder.eq("role", query.role);
    const matches = await searchProfileIds(supabase, query.q);
    if (matches) {
      searchTruncated = matches.truncated;
      // An empty match set must yield an empty page, not an unfiltered one.
      if (matches.ids.length === 0) return { rows: [], total: 0, searchTruncated };
      builder = builder.in("user_id", matches.ids);
    }
    const { data, error, count } = await builder
      .order("created_at", { ascending: false })
      .range(from, to);
    if (error) throw error;
    return {
      rows: normalizeMembershipRows((data ?? []) as unknown as RawMembershipRow[]),
      total: count ?? 0,
      searchTruncated,
    };
  }

  if (query.scope === "unassigned") {
    // "Unassigned" is derived, not stored: subtract every profile id that
    // appears in ANY membership from the profile set server-side. Bounded by
    // the assigned-id read; a failure there degrades the tab to an error
    // (thrown) rather than showing assigned accounts as unassigned.
    const [profilesRes, assignedRes] = await Promise.all([
      supabase
        .from("profiles")
        .select(PROFILE_SELECT, { count: "exact" })
        .order("created_at", { ascending: false }),
      supabase.from("institution_memberships").select("user_id").range(0, 4999),
    ]);
    if (profilesRes.error) throw profilesRes.error;
    if (assignedRes.error) throw assignedRes.error;

    const assigned = new Set(
      (assignedRes.data ?? []).map((row) => (row as { user_id: string }).user_id),
    );
    let candidates = ((profilesRes.data ?? []) as unknown as RawProfileRow[]).filter(
      (row) => !assigned.has(row.id),
    );
    const or = toUserSearchOrClause(query.q, ["full_name", "email"]);
    if (query.q && or) {
      candidates = candidates.filter(
        (row) =>
          (row.full_name ?? "").toLowerCase().includes(query.q.toLowerCase()) ||
          (row.email ?? "").toLowerCase().includes(query.q.toLowerCase()),
      );
    } else if (query.q) {
      candidates = [];
    }
    const total = candidates.length;
    const page = candidates.slice(from, to + 1);
    // The assigned-id read is capped; if it saturated, some unassigned rows
    // may be misattributed — report the cap as a truncation flag.
    return {
      rows: normalizeProfileRows(page),
      total,
      searchTruncated: (assignedRes.data ?? []).length >= 5000,
    };
  }

  if (query.scope === "students") {
    let builder = supabase.from("students").select(STUDENT_SELECT, { count: "exact" });
    builder = withInstitution(builder, "institution_id", query.institutionId);
    builder = builder.is("deleted_at", null);
    const or = toUserSearchOrClause(query.q, ["full_name", "student_code"]);
    if (query.q && or) builder = builder.or(or);
    else if (query.q) return { rows: [], total: 0, searchTruncated: false };
    const { data, error, count } = await builder
      .order("created_at", { ascending: false })
      .range(from, to);
    if (error) throw error;
    return {
      rows: normalizeRosterRows(
        (data ?? []) as unknown as RawRosterRow[],
        "STUDENT",
      ),
      total: count ?? 0,
      searchTruncated: false,
    };
  }

  // teachers
  let builder = supabase.from("teachers").select(TEACHER_SELECT, { count: "exact" });
  builder = withInstitution(builder, "institution_id", query.institutionId);
  builder = builder.is("deleted_at", null);
  const or = toUserSearchOrClause(query.q, ["full_name", "email", "employee_code"]);
  if (query.q && or) builder = builder.or(or);
  else if (query.q) return { rows: [], total: 0, searchTruncated: false };
  const { data, error, count } = await builder
    .order("created_at", { ascending: false })
    .range(from, to);
  if (error) throw error;
  return {
    rows: normalizeRosterRows((data ?? []) as unknown as RawRosterRow[], "TEACHER"),
    total: count ?? 0,
    searchTruncated: false,
  };
}

/**
 * Live head count per scope for the tab badges, narrowed by the tenant
 * filter (the one filter the badges honour). Any failing count degrades the
 * ENTIRE map to null — a partial breakdown is never rendered as complete.
 */
export async function countUsersByScope(
  institutionId: string | null,
): Promise<PlatformUserScopeCounts | null> {
  const supabase = createAdminClient();
  const counts = {} as PlatformUserScopeCounts;

  const headCount = async (
    table: string,
    column: string,
  ): Promise<number | null> => {
    let builder = supabase
      .from(table)
      .select("*", { count: "exact", head: true });
    if (institutionId) builder = builder.eq(column, institutionId);
    const { count, error } = await builder;
    return error ? null : (count ?? 0);
  };

  // accounts: memberships for the tenant (or all tenants platform-wide).
  const memberships = await headCount("institution_memberships", "institution_id");
  if (memberships === null) return null;
  counts.accounts = memberships;

  // students / teachers: live roster rows (soft-deleted excluded).
  const rosterCount = async (
    table: string,
  ): Promise<number | null> => {
    let builder = supabase
      .from(table)
      .select("*", { count: "exact", head: true })
      .is("deleted_at", null);
    if (institutionId) builder = builder.eq("institution_id", institutionId);
    const { count, error } = await builder;
    return error ? null : (count ?? 0);
  };
  const students = await rosterCount("students");
  const teachers = await rosterCount("teachers");
  if (students === null || teachers === null) return null;
  counts.students = students;
  counts.teachers = teachers;

  // unassigned: profiles minus the assigned id set (bounded read; a failure
  // or a saturated read makes the badge unavailable rather than wrong).
  const profilesRes = await supabase
    .from("profiles")
    .select("id")
    .range(0, 4999);
  const assignedRes = await supabase
    .from("institution_memberships")
    .select("user_id")
    .range(0, 4999);
  if (profilesRes.error || assignedRes.error) return null;
  if (
    (profilesRes.data ?? []).length >= 5000 ||
    (assignedRes.data ?? []).length >= 5000
  ) {
    // Over the derive cap: omit the badge count rather than show a wrong one.
    return counts;
  }
  const assigned = new Set(
    (assignedRes.data ?? []).map((row) => (row as { user_id: string }).user_id),
  );
  counts.unassigned = ((profilesRes.data ?? []) as unknown as { id: string }[]).filter(
    (row) => !assigned.has(row.id),
  ).length;

  return counts;
}

/** Guard used by tests and callers: the scope list is the pure catalog. */
export { USER_DIRECTORY_SCOPES };
