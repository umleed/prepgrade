/**
 * Platform audit data access — SERVER-ONLY (prompt 31).
 *
 * Writes go through the service-role client, which BYPASSES RLS, so the
 * append-only and privacy guarantees are NOT enforced here — they live in the
 * database (supabase/migrations/0007_platform_audit_log.sql: narrow grants,
 * mutation-refusing trigger) and in the pure catalog/normalisation layer
 * (`lib/audit/platform.ts`, which refuses unknown actions and bounds every
 * field). This module only moves normalised rows.
 *
 * Recording is deliberately non-throwing: an audit write failing must never
 * turn an authorized page into an error, and never block a DENIAL from being
 * enforced. Failures surface as a `false` result plus a server console line so
 * observability (prompt 33) can pick them up.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import {
  buildAuditEntry,
  institutionActivityFilter,
  applicationActivityFilter,
  isPlatformAuditAction,
  type AuditEventInput,
  type PlatformAuditAction,
  type PlatformAuditOutcome,
  type AuditActorRole,
} from "@/lib/audit/platform";

type AuditRow = {
  id: number;
  created_at: string;
  actor_id: string;
  actor_role: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: string;
  detail: unknown;
};
export type { AuditRow };

/** An audit entry as the UI reads it (row mapped, values guarded). */
export type PlatformAuditEntry = {
  id: number;
  createdAt: string;
  actorId: string;
  actorRole: AuditActorRole;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: PlatformAuditOutcome;
  /** Short trusted summary; null when the row carried none. */
  summary: string | null;
};

/** Mirror of the 0007 CHECK list; anything else degrades to `unassigned` in
 *  the UI rather than trusting a stray value. */
const KNOWN_ACTOR_ROLES: readonly string[] = [
  "SUPER_ADMIN",
  "INSTITUTION_ADMIN",
  "TEACHER",
  "STUDENT",
  "unassigned",
  "unknown",
];

function toActorRole(value: string): AuditActorRole {
  return (KNOWN_ACTOR_ROLES.includes(value)
    ? value
    : "unassigned") as AuditActorRole;
}

function toOutcome(value: string): PlatformAuditOutcome {
  return value === "success" || value === "failed" || value === "denied"
    ? value
    : "failed";
}

/** Row → UI entry mapping; shared with the usage/activity reads so every
 *  screen guards the stored values the same way (exported for reuse). */
export function toEntry(row: AuditRow): PlatformAuditEntry {
  // detail is jsonb written only by buildAuditEntry — read the summary key
  // defensively; a malformed value becomes null, never rendered raw.
  const detail = row.detail;
  const summary =
    detail && typeof detail === "object" && !Array.isArray(detail)
      ? (detail as Record<string, unknown>).summary
      : undefined;

  return {
    id: row.id,
    createdAt: row.created_at,
    actorId: row.actor_id,
    actorRole: toActorRole(row.actor_role),
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    outcome: toOutcome(row.outcome),
    summary: typeof summary === "string" && summary.trim() ? summary : null,
  };
}

export const AUDIT_SELECT =
  "id, created_at, actor_id, actor_role, action, target_type, target_id, outcome, detail";

/**
 * Record one platform audit event. Returns false (never throws) when the
 * event was rejected by the pure layer (unknown action/outcome) or when the
 * database write failed — callers enforce their decision regardless, and a
 * denial is enforced BEFORE this is called.
 */
export async function recordPlatformAudit(
  event: AuditEventInput,
): Promise<boolean> {
  const entry = buildAuditEntry(event);
  if (!entry) return false;

  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from("platform_audit_log").insert(entry);
    if (error) {
      console.error("[platform-audit] write failed:", error.message);
      return false;
    }
    return true;
  } catch (error) {
    // DataSourceUnavailableError or network failure — honest, non-fatal.
    console.error(
      "[platform-audit] write failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

export type PlatformAuditListQuery = {
  page: number;
  pageSize: number;
  /** Optional action filter; unknown names are ignored (fail open to "all"). */
  action?: PlatformAuditAction | null;
  /** Outcome filter — only the three stored values ever reach here. */
  outcome?: PlatformAuditOutcome | null;
  /** Exact actor id (trimmed server-side by the pure resolver). */
  actor?: string | null;
  /** Institution id — matches rows TARGETED at this tenant. Deliberately
   *  narrow: the audit table has no tenant column, and inventing a broader
   *  tenant attribution would be a leakage risk, not a feature. */
  institutionId?: string | null;
  /** Entity (`target_type`) filter from the controlled vocabulary. */
  entityType?: string | null;
  /** Inclusive ISO lower bound on created_at. */
  from?: string | null;
  /** ISO upper bound on created_at (end of the selected day). */
  to?: string | null;
};

export type PlatformAuditListResult = {
  rows: PlatformAuditEntry[];
  total: number;
};

/**
 * Read audit entries, newest first. The whole table is platform-scoped by
 * design (no tenant column), so the authorization requirement is absolute:
 * ONLY call this after `requireSuperAdmin()` (or an equivalent server-side
 * SUPER_ADMIN check) has passed for the current request.
 */
export async function listPlatformAuditEntries(
  query: PlatformAuditListQuery,
): Promise<PlatformAuditListResult> {
  const supabase = createAdminClient();

  let builder = supabase
    .from("platform_audit_log")
    .select(AUDIT_SELECT, { count: "exact" });

  // Every filter is an equality/range on a real column, fed only by values
  // the PURE resolver already validated and bounded — an unrecognised URL
  // value never reaches this layer as a column filter.
  if (query.action && isPlatformAuditAction(query.action)) {
    builder = builder.eq("action", query.action);
  }
  if (query.outcome) builder = builder.eq("outcome", query.outcome);
  if (query.actor) builder = builder.eq("actor_id", query.actor);
  if (query.institutionId) {
    builder = builder
      .eq("target_type", "institution")
      .eq("target_id", query.institutionId);
  } else if (query.entityType !== null && query.entityType !== undefined) {
    // "none" is the pure layer's sentinel for rows with no recorded target.
    if (query.entityType === "none") {
      builder = builder.is("target_type", null);
    } else {
      builder = builder.eq("target_type", query.entityType);
    }
  }
  if (query.from) builder = builder.gte("created_at", query.from);
  if (query.to) builder = builder.lte("created_at", query.to);

  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  const { data, error, count } = await builder
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) throw error;
  return {
    rows: (data ?? []).map((row) => toEntry(row as unknown as AuditRow)),
    total: count ?? 0,
  };
}

/**
 * Read the most recent platform-audit activity attributable to ONE institution,
 * newest first. The audit table is platform-wide with no tenant column, so the
 * only correct scoping is the `target_type`/`target_id` pair the server wrote
 * when it acted on that tenant — never a client-supplied filter. The pure
 * `institutionActivityFilter` refuses a blank id (returns no rows) so this can
 * never degrade into a whole-log read.
 *
 * Authorization is the caller's responsibility: ONLY call after a server-side
 * SUPER_ADMIN check (`requireSuperAdmin`) has passed for this request.
 */
export async function listInstitutionAuditActivity(
  institutionId: string,
  limit?: number,
): Promise<PlatformAuditEntry[]> {
  const filter = institutionActivityFilter(institutionId, limit);
  if (!filter) return [];

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("platform_audit_log")
    .select(AUDIT_SELECT)
    .eq("target_type", filter.target_type)
    .eq("target_id", filter.target_id)
    .order("created_at", { ascending: false })
    .limit(filter.limit);

  if (error) throw error;
  return (data ?? []).map((row) => toEntry(row as unknown as AuditRow));
}

/**
 * Read the most recent platform-audit decisions attributable to ONE institution
 * application, newest first — the review drawer's decision history. Same
 * scoping guarantee as the institution activity read: the pure
 * `applicationActivityFilter` refuses a blank id (returns no rows), so this can
 * never degrade into a whole-log read. Authorization is the caller's
 * responsibility: ONLY call after a server-side SUPER_ADMIN check has passed.
 */
export async function listApplicationDecisionActivity(
  applicationId: string,
  limit?: number,
): Promise<PlatformAuditEntry[]> {
  const filter = applicationActivityFilter(applicationId, limit);
  if (!filter) return [];

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("platform_audit_log")
    .select(AUDIT_SELECT)
    .eq("target_type", filter.target_type)
    .eq("target_id", filter.target_id)
    .order("created_at", { ascending: false })
    .limit(filter.limit);

  if (error) throw error;
  return (data ?? []).map((row) => toEntry(row as unknown as AuditRow));
}
