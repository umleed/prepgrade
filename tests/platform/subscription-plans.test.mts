/**
 * Subscription-plans screen tests — Super Admin plan management (read-only
 * unavailable state).
 *
 * Pure modules only (lib/plans.ts), same Node built-in runner as the rest of
 * the suite — no Supabase, no Next. These pin the acceptance rules for the
 * screen:
 *   - UNAVAILABLE (no plan table yet) and EMPTY (catalogue exists, zero rows)
 *     are distinct states and never collapse into one another or into a
 *     fabricated zero;
 *   - a failed read is its own state — contents unknown, not "no plans";
 *   - an untrusted count (non-integer, negative, NaN) fails closed to the
 *     error state rather than rendering a number the UI cannot vouch for;
 *   - a real positive count surfaces as "stored but not managed", keeping
 *     the promise that no create/edit/archive action exists yet;
 *   - the route lives under /platform, so the layout-level
 *     `requireSuperAdmin` gate applies to it in addition to the page's own
 *     guard call.
 *
 * The SUPER_ADMIN gate itself (only SUPER_ADMIN passes
 * `decideAccess(…, { roles: ["SUPER_ADMIN"] })`, every tenant role and
 * anonymous session fails closed) is pinned by
 * tests/platform/super-admin-access.test.mts, which exercises the exact call
 * requireSuperAdmin makes on this page. Plan-change, subscriber-transition,
 * and quota rules have no implementation to test yet — the schema has no
 * plan tables — so no such tests are claimed; they ship with the billing
 * migration (prompt 46) once approved.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SUBSCRIPTION_PLANS_ROUTE,
  resolvePlansViewState,
  type PlansProbe,
} from "../../lib/plans.ts";

describe("resolvePlansViewState keeps unavailable and empty distinct", () => {
  it("maps a missing plan table to notImplemented, never to an empty list", () => {
    const probe: PlansProbe = { state: "unavailable", reason: "missing_table" };
    assert.deepEqual(resolvePlansViewState(probe), { kind: "notImplemented" });
  });

  it("maps a failed read to its own error state, not to zero plans", () => {
    const probe: PlansProbe = { state: "unavailable", reason: "error" };
    assert.deepEqual(resolvePlansViewState(probe), {
      kind: "dataSourceError",
    });
  });

  it("treats a genuine zero as the empty state only when the read succeeded", () => {
    assert.deepEqual(resolvePlansViewState({ state: "available", value: 0 }), {
      kind: "noPlans",
    });
  });

  it("reports a real positive count as stored-but-unmanaged, value preserved", () => {
    assert.deepEqual(
      resolvePlansViewState({ state: "available", value: 4 }),
      { kind: "storedNotManaged", planCount: 4 },
    );
  });
});

describe("resolvePlansViewState fails closed on untrusted counts", () => {
  for (const value of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`refuses to render ${String(value)} as a plan count`, () => {
      assert.deepEqual(
        resolvePlansViewState({ state: "available", value }),
        { kind: "dataSourceError" },
      );
    });
  }
});

describe("subscription-plans route sits behind the platform gate", () => {
  it("lives under /platform so the layout's requireSuperAdmin applies", () => {
    // The platform layout guards every /platform route server-side; a route
    // outside that prefix would silently lose its first defense layer.
    assert.ok(SUBSCRIPTION_PLANS_ROUTE.startsWith("/platform/"));
    assert.equal(SUBSCRIPTION_PLANS_ROUTE, "/platform/subscription-plans");
  });
});
