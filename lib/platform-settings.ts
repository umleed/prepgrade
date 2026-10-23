/**
 * Platform settings presentation — pure, dependency-free, unit-testable.
 *
 * WHY THIS EXISTS
 * The Super Admin "Settings" screen is READ-ONLY: it surfaces configuration
 * metadata and system-health posture that an existing server source can safely
 * establish (lib/data/platform-health.ts). This module owns only the
 * presentation DECISIONS — how a real signal maps to a status word and a badge
 * tone, and the privacy rule that a configuration row shows a variable NAME and
 * never a value. Keeping those decisions here means the page and `npm test`
 * share one contract and cannot drift (the same layering as lib/plans.ts).
 *
 * TYPES ARE RE-DECLARED, NOT IMPORTED FROM THE SERVER MODULE
 * lib/data/platform-health.ts imports `server-only`; importing even its types
 * would couple this pure layer to a runtime the Node test runner cannot load
 * (the identical choice as lib/plans.ts re-declaring PlansProbe). The shapes
 * below are structurally compatible with `ConfigSignal`, `AuditLogLiveness`,
 * and `MetricState`, so a value produced by the server probe satisfies them.
 *
 * PRIVACY (AGENTS.md §7)
 * A configuration signal carries `variable` (a NAME such as
 * "SUPABASE_SERVICE_ROLE_KEY") and a boolean `configured`. There is no `value`
 * field anywhere in this layer, and `configurationRows` never invents one —
 * so a secret can neither be requested nor rendered. This is a structural
 * guarantee, reinforced by a runtime guard the page passes every row through.
 */

/** Structural mirror of the server `ConfigSignal`. */
export type ConfigSignalLike = {
  label: string;
  variable: string;
  configured: boolean;
  missingNote: string;
};

/** Structural mirror of the server `MetricState<T>` (only `state`/`reason`
 *  are needed for presentation here). */
export type MetricLike = {
  state: "available" | "unavailable";
  reason?: "missing_table" | "error";
};

/** Structural mirror of the server `AuditLogLiveness`. */
export type AuditLivenessLike =
  | { state: "live"; newestEventAt: string }
  | { state: "empty" }
  | { state: "unavailable"; reason: "missing_table" | "error" };

export type BadgeToneLike = "success" | "warning" | "info" | "neutral";

// --- Configuration signal → row -------------------------------------------------

/**
 * A rendered configuration row: the display fields, and NO value. `status` and
 * `tone` are derived from the boolean the server already established; the
 * `missingNote` is shown only when the capability is absent (a configured row
 * needs no warning text).
 */
export type ConfigurationRow = {
  label: string;
  /** Environment variable NAME — never its value. */
  variable: string;
  configured: boolean;
  status: "Configured" | "Not configured";
  tone: BadgeToneLike;
  /** Present only when not configured. */
  missingNote: string | null;
};

/**
 * Map one configuration signal to a safe display row. Fail-closed on the
 * variable name: a signal whose name is missing degrades to an "Unknown"
 * placeholder rather than rendering a blank identity — but the value is STILL
 * never read, because this function has no access to one.
 */
export function configurationRow(signal: ConfigSignalLike): ConfigurationRow {
  return {
    label: signal.label,
    variable: signal.variable?.trim() ? signal.variable : "Unknown variable",
    configured: signal.configured,
    status: signal.configured ? "Configured" : "Not configured",
    tone: signal.configured ? "success" : "warning",
    missingNote: signal.configured ? null : signal.missingNote,
  };
}

/**
 * Guard that a row is safe to render. Returns the row unchanged when it carries
 * no value-bearing field, and THROWS otherwise. The page pipes every row
 * through this before rendering, so a future edit that added a secret field to
 * ConfigurationRow would fail loudly in the request AND in `npm test`, not
 * silently leak. Only the known-safe keys are permitted.
 */
const ALLOWED_ROW_KEYS: readonly (keyof ConfigurationRow)[] = [
  "label",
  "variable",
  "configured",
  "status",
  "tone",
  "missingNote",
];

export function assertConfigurationRowSafe(row: ConfigurationRow): ConfigurationRow {
  for (const key of Object.keys(row)) {
    if (!(ALLOWED_ROW_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `configuration row carries an unexpected field "${key}" — settings must never render secret values`,
      );
    }
  }
  return row;
}

// --- Health posture → status ----------------------------------------------------

/**
 * Binary reachability/readability signal → tone + label. `unavailable` is its
 * own honest state (the check could not run), never a failing green tick or a
 * zero — the same rule the health screen applies.
 */
export function healthSignalPresentation(
  metric: MetricLike,
  goodLabel: string,
  badLabel: string,
): { tone: BadgeToneLike; label: string } {
  if (metric.state !== "available") {
    return { tone: "neutral", label: "Unavailable" };
  }
  return { tone: "success", label: goodLabel ?? badLabel };
}

/**
 * Audit-pipeline liveness → tone + label + one-line detail. "empty" (readable
 * but no events) is `info`, NOT a failure — a green-but-broken log and a
 * red-but-empty log are different truths the UI must keep apart (mirrors the
 * LivenessCard on the health screen).
 */
export function auditLivenessPresentation(liveness: AuditLivenessLike): {
  tone: BadgeToneLike;
  label: string;
  detail: string;
} {
  switch (liveness.state) {
    case "live":
      return { tone: "success", label: "Live", detail: "Recording" };
    case "empty":
      return {
        tone: "info",
        label: "No events yet",
        detail: "Readable but empty",
      };
    case "unavailable":
      return {
        tone: "warning",
        label: "Unavailable",
        detail:
          liveness.reason === "missing_table"
            ? "Audit table not migrated here"
            : "Audit table could not be read",
      };
  }
}

/**
 * Whether the overall platform posture is degraded, so the page badge can say
 * "some checks degraded" truthfully. A data source or audit table that is not
 * available degrades the posture; configuration gaps are surfaced per-row, not
 * folded into this banner (a missing optional key is not a system failure).
 */
export function isPostureDegraded(signals: readonly MetricLike[]): boolean {
  return signals.some((signal) => signal.state !== "available");
}
