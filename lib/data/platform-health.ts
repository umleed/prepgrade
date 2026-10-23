/**
 * System health probes — SERVER-ONLY data access for the platform health
 * screen (prompt 33).
 *
 * HONEST SIGNALS ONLY. Every check reads something that genuinely exists in
 * this deployment — the Supabase service-role connection, the append-only
 * audit table, and the server's own environment configuration. There is no
 * uptime percentage, no synthetic latency, no fabricated "All systems
 * operational": a signal we cannot measure renders as unavailable, never as
 * a green tick or a zero (same MetricState contract as prompt 31's dashboard).
 *
 * PRIVACY (AGENTS.md §7): probes return counts and booleans only. No row
 * content, no actor ids, no secrets — presence of an env var is reported as
 * a boolean, its value is never read into the result.
 *
 * AUTHORIZATION: callers MUST have passed `requireSuperAdmin()` before any
 * function here runs; the audit table is platform-wide.
 */

import "server-only";
import { createAdminClient, DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  isMissingTableError,
  type MetricState,
} from "@/lib/data/platform-overview";

/** A configuration signal is binary by construction: the server either has
 *  the variable or it does not — "unavailable" would mean the probe itself
 *  failed, which cannot happen for a synchronous env read. */
export type ConfigSignal = {
  /** Human-readable name of the capability the variable enables. */
  label: string;
  /** The environment variable checked (a NAME only — never a value). */
  variable: string;
  configured: boolean;
  /** What stops working when it is absent, in plain terms. */
  missingNote: string;
};

/** Log liveness, stated in three honest branches: a real newest event, a
 *  readable-but-empty table, or a check that could not run. "No events
 *  recorded" must never look like a failure, and a failure must never look
 *  like an empty log. */
export type AuditLogLiveness =
  | { state: "live"; newestEventAt: string }
  | { state: "empty" }
  | { state: "unavailable"; reason: "missing_table" | "error" };

export type SystemHealth = {
  /** Can the server reach/configure the Supabase service-role client? */
  dataSource: MetricState<"reachable">;
  /** Is the audit table readable (i.e. is migration 0007 applied)? */
  auditLog: MetricState<"readable">;
  /** Timestamp of the newest audit event — proof the log is live. */
  latestAuditEvent: AuditLogLiveness;
  /** Denied actions recorded in the last 24 hours. */
  deniedLast24h: MetricState<number>;
  /** Successful platform actions recorded in the last 24 hours. */
  actionsLast24h: MetricState<number>;
  /** Server-side configuration the app degrades gracefully without. */
  configuration: ConfigSignal[];
};

function unavailable(error: unknown): MetricState<never> {
  return {
    state: "unavailable",
    reason: isMissingTableError(error) ? "missing_table" : "error",
  };
}

function unavailableEvent(error: unknown): AuditLogLiveness {
  return {
    state: "unavailable",
    reason: isMissingTableError(error) ? "missing_table" : "error",
  };
}

/** Head-count helper for one outcome over a time window; each probe is
 *  wrapped independently so one failing signal degrades alone. */
async function countSince(
  hours: number,
  outcome: string,
): Promise<MetricState<number>> {
  try {
    const supabase = createAdminClient();
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from("platform_audit_log")
      .select("*", { count: "exact", head: true })
      .eq("outcome", outcome)
      .gte("created_at", since);
    if (error) return unavailable(error);
    return { state: "available", value: count ?? 0 };
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      return { state: "unavailable", reason: "error" };
    }
    return unavailable(error);
  }
}

/**
 * Run every health probe. Returns a full bundle even when sources fail —
 * each signal carries its own state so the UI can say exactly WHICH check
 * could not run instead of blanking the page.
 */
export async function getSystemHealth(): Promise<SystemHealth> {
  // 1. Data source + audit readability: one tiny real query answers both —
  //    if it round-trips, Supabase AND the audit table are working.
  let dataSource: MetricState<"reachable"> = { state: "available", value: "reachable" };
  let auditLog: MetricState<"readable"> = { state: "available", value: "readable" };
  let latestAuditEvent: AuditLogLiveness = { state: "unavailable", reason: "error" };

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("platform_audit_log")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      auditLog = unavailable(error);
      latestAuditEvent = unavailableEvent(error);
    } else {
      const newest = data?.[0]?.created_at;
      latestAuditEvent = newest
        ? { state: "live", newestEventAt: newest }
        : { state: "empty" };
    }
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      dataSource = { state: "unavailable", reason: "error" };
      auditLog = { state: "unavailable", reason: "error" };
      latestAuditEvent = { state: "unavailable", reason: "error" };
    } else {
      auditLog = unavailable(error);
      latestAuditEvent = unavailableEvent(error);
    }
  }

  // 2. Recent security signal (only meaningful when the table is readable).
  const tableReadable = auditLog.state === "available";
  const deniedLast24h = tableReadable
    ? await countSince(24, "denied")
    : { state: "unavailable", reason: "error" } as const satisfies MetricState<number>;
  const actionsLast24h = tableReadable
    ? await countSince(24, "success")
    : { state: "unavailable", reason: "error" } as const satisfies MetricState<number>;

  // 3. Environment configuration — presence checks only, never values.
  const configuration: ConfigSignal[] = [
    {
      label: "Supabase service-role connection",
      variable: "SUPABASE_SERVICE_ROLE_KEY",
      configured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      missingNote:
        "Without it no server data access works — dashboards, audit writes, and reads all degrade.",
    },
    {
      label: "Auth provider server keys (Clerk)",
      variable: "CLERK_SECRET_KEY",
      configured: Boolean(process.env.CLERK_SECRET_KEY),
      missingNote:
        "Trusted role writes and invitations (teacher access, applicant provisioning) are unavailable without it; the rest of the app still runs.",
    },
  ];

  return {
    dataSource,
    auditLog,
    latestAuditEvent,
    deniedLast24h,
    actionsLast24h,
    configuration,
  };
}
