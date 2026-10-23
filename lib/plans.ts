/**
 * Pure view-model for the Super Admin "Subscription Plans" screen.
 *
 * WHY THIS SCREEN IS READ-ONLY TODAY: the schema (migrations 0001–0017) has
 * no subscription-plan table, no entitlement/quota model, no subscriber
 * links, and no payment integration exists (no provider, no env keys).
 * Billing and subscriptions are an explicitly deferred future phase
 * (prompt 46; see also the scope notes in migrations 0008 and 0015). So the
 * screen shows the database's real state instead of the design reference's
 * invented prices, limits, and subscriber counts — and the states below are
 * deliberately distinct because "nothing stored yet" and "no data model"
 * are different truths the UI must never conflate (same rule as
 * unavailable ≠ zero on the platform overview).
 *
 * This module is pure (no server-only imports) so the state mapping is
 * unit-testable with the Node runner — the probe itself lives in
 * lib/data/platform-plans.ts.
 */

/** Canonical route for the screen (sidebar + dashboard cross-links). */
export const SUBSCRIPTION_PLANS_ROUTE = "/platform/subscription-plans";

/**
 * Result of a head-count probe against `subscription_plans`. Structurally
 * identical to `MetricState<number>` in lib/data/platform-overview.ts —
 * re-declared here so this pure layer stays free of server-only imports.
 */
export type PlansProbe =
  | { state: "available"; value: number }
  | { state: "unavailable"; reason: "missing_table" | "error" };

/**
 * What the screen renders, one variant per distinct truth:
 *  - `notImplemented`    — no plan table exists; billing is a future phase.
 *                          This is UNAVAILABLE, not an empty list.
 *  - `dataSourceError`   — the table may exist but could not be read; the
 *                          count is unknown, never guessed.
 *  - `noPlans`           — the plan catalogue exists and genuinely holds
 *                          zero rows (a real empty state).
 *  - `storedNotManaged`  — plan rows exist in the database, but create/edit/
 *                          archive actions are not offered until the schema,
 *                          entitlement rules, and owner sign-off land.
 */
export type PlansViewState =
  | { kind: "notImplemented" }
  | { kind: "dataSourceError" }
  | { kind: "noPlans" }
  | { kind: "storedNotManaged"; planCount: number };

/**
 * Map a probe result to a view state. A count that is not a non-negative
 * integer fails closed to `dataSourceError`: the screen refuses to render a
 * number it cannot trust (defensive — PostgREST counts are exact or null —
 * but this function is the last pure gate before the UI).
 */
export function resolvePlansViewState(probe: PlansProbe): PlansViewState {
  if (probe.state === "unavailable") {
    return probe.reason === "missing_table"
      ? { kind: "notImplemented" }
      : { kind: "dataSourceError" };
  }
  if (!Number.isInteger(probe.value) || probe.value < 0) {
    return { kind: "dataSourceError" };
  }
  if (probe.value === 0) {
    return { kind: "noPlans" };
  }
  return { kind: "storedNotManaged", planCount: probe.value };
}
