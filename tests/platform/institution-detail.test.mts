/**
 * Institution detail dashboard tests — prompt 32 (detail view extended into a
 * tabbed dashboard).
 *
 * Pure modules only (lib/institutions.ts tab resolver + the audit activity
 * filter), same Node built-in runner as the rest of the suite — no Supabase,
 * no Next. These pin the rules the detail dashboard relies on:
 *   - the tab set exposes ONLY implemented capabilities, and an unknown or
 *     absent `?tab=` fails closed to the overview (never an arbitrary section),
 *   - the tab-link builder keeps the overview path clean,
 *   - the audit-activity filter can only ever target ONE institution — a blank
 *     or non-string id yields no filter (so the query returns nothing rather
 *     than the whole platform log), and the limit is clamped within the cap.
 *
 * Tenant isolation in the data layer (`.eq("institution_id", …)` on every
 * count, and the target_type/target_id scoping of the audit read) is enforced
 * server-side and verified against a real database by
 * supabase/tests/institution_lifecycle_readiness.sql; the SUPER_ADMIN gate that
 * guards the whole area is covered by tests/platform/super-admin-access.test.mts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_INSTITUTION_DETAIL_TAB,
  INSTITUTION_DETAIL_TABS,
  institutionDetailTabHref,
  isInstitutionDetailTab,
  resolveInstitutionDetailTab,
} from "../../lib/institutions.ts";
import {
  INSTITUTION_ACTIVITY_LIMIT,
  INSTITUTION_AUDIT_TARGET_TYPE,
  institutionActivityFilter,
} from "../../lib/audit/platform.ts";

// --- Tab resolver (untrusted searchParams) ----------------------------------

describe("institution detail tabs expose only implemented capabilities", () => {
  it("offers exactly overview, users, settings, activity", () => {
    assert.deepEqual([...INSTITUTION_DETAIL_TABS], [
      "overview",
      "users",
      "settings",
      "activity",
    ]);
  });

  it("does NOT offer a tab for an unimplemented system", () => {
    // No fake assessments / results / subscription / billing sections.
    for (const forbidden of [
      "assessments",
      "results",
      "subscription",
      "billing",
      "payments",
    ]) {
      assert.equal(
        isInstitutionDetailTab(forbidden),
        false,
        `${forbidden} must not be a tab`,
      );
    }
  });
});

describe("resolveInstitutionDetailTab", () => {
  it("falls back to the overview when no tab is given", () => {
    assert.equal(resolveInstitutionDetailTab({}), DEFAULT_INSTITUTION_DETAIL_TAB);
    assert.equal(resolveInstitutionDetailTab({ tab: "" }), "overview");
  });

  it("keeps a recognised tab, tolerant of case and whitespace", () => {
    assert.equal(resolveInstitutionDetailTab({ tab: "users" }), "users");
    assert.equal(resolveInstitutionDetailTab({ tab: " Activity " }), "activity");
    assert.equal(resolveInstitutionDetailTab({ tab: ["settings", "users"] }), "settings");
  });

  it("fails closed on an unknown tab rather than trusting it", () => {
    assert.equal(resolveInstitutionDetailTab({ tab: "drop_table" }), "overview");
    assert.equal(resolveInstitutionDetailTab({ tab: "billing" }), "overview");
  });
});

describe("institutionDetailTabHref", () => {
  it("keeps the default tab's path clean", () => {
    assert.equal(
      institutionDetailTabHref("/platform/institutions/inst_1", "overview"),
      "/platform/institutions/inst_1",
    );
  });

  it("appends the tab query for non-default sections", () => {
    assert.equal(
      institutionDetailTabHref("/platform/institutions/inst_1", "activity"),
      "/platform/institutions/inst_1?tab=activity",
    );
  });
});

// --- Audit activity filter (cross-institution isolation) --------------------

describe("institutionActivityFilter", () => {
  it("scopes to a single institution via the trusted target pair", () => {
    const filter = institutionActivityFilter("inst_123");
    assert.ok(filter);
    assert.equal(filter.target_type, INSTITUTION_AUDIT_TARGET_TYPE);
    assert.equal(filter.target_id, "inst_123");
    assert.equal(filter.limit, INSTITUTION_ACTIVITY_LIMIT);
  });

  it("trims surrounding whitespace from the id", () => {
    const filter = institutionActivityFilter("  inst_9  ");
    assert.equal(filter?.target_id, "inst_9");
  });

  it("refuses a blank or non-string id so the query never reads the whole log", () => {
    assert.equal(institutionActivityFilter(""), null);
    assert.equal(institutionActivityFilter("   "), null);
    assert.equal(institutionActivityFilter(null), null);
    assert.equal(institutionActivityFilter(undefined), null);
    assert.equal(institutionActivityFilter(42), null);
  });

  it("clamps the limit to a positive integer within the cap", () => {
    assert.equal(institutionActivityFilter("inst_1", 3)?.limit, 3);
    assert.equal(institutionActivityFilter("inst_1", 999)?.limit, INSTITUTION_ACTIVITY_LIMIT);
    assert.equal(institutionActivityFilter("inst_1", 0)?.limit, 1);
    assert.equal(institutionActivityFilter("inst_1", -5)?.limit, 1);
    assert.equal(institutionActivityFilter("inst_1", Number.NaN)?.limit, 1);
  });
});
