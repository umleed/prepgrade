/**
 * Institution lifecycle & directory tests — prompt 32.
 *
 * Pure modules only (lib/institutions.ts + the audit catalog), same Node
 * built-in runner as the rest of the suite — no Supabase, no Next. These pin
 * the rules the platform-admin status-change flow depends on:
 *   - the operational-status catalog and its fail-closed transition policy,
 *   - the untrusted-searchParams directory resolver (clamps/drops junk),
 *   - the URL builder that keeps filters linkable,
 *   - the search-pattern sanitiser,
 *   - that the new audited action is a recognised catalog member and
 *     normalises into a row.
 *
 * The database half (status/type CHECK constraints, defaults) is covered by
 * supabase/tests/institution_lifecycle_readiness.sql, and the SUPER_ADMIN gate
 * that guards the whole area by tests/platform/super-admin-access.test.mts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALLOWED_STATUS_TRANSITIONS,
  INSTITUTION_STATUSES,
  INSTITUTION_DIRECTORY_PAGE_SIZE,
  availableStatusTransitions,
  canTransitionInstitutionStatus,
  institutionDirectoryHref,
  institutionTypeLabel,
  isInstitutionStatus,
  isInstitutionType,
  normalizeInstitutionStatus,
  resolveInstitutionDirectoryQuery,
  toInstitutionContainsPattern,
} from "../../lib/institutions.ts";
import {
  PLATFORM_AUDIT_ACTIONS,
  buildAuditEntry,
  isPlatformAuditAction,
  platformAuditActionLabel,
} from "../../lib/audit/platform.ts";

// --- Status catalog ----------------------------------------------------------

describe("institution status catalog", () => {
  it("recognises exactly the three operational statuses", () => {
    for (const status of INSTITUTION_STATUSES) {
      assert.equal(isInstitutionStatus(status), true, status);
    }
    for (const value of ["deleted", "ACTIVE", "", null, undefined, 42]) {
      assert.equal(isInstitutionStatus(value), false, String(value));
    }
  });

  it("normalises case/whitespace but never guesses a default", () => {
    assert.equal(normalizeInstitutionStatus("  Suspended "), "suspended");
    assert.equal(normalizeInstitutionStatus("ARCHIVED"), "archived");
    // Unknown values fall to null rather than a permissive default.
    assert.equal(normalizeInstitutionStatus("root"), null);
    assert.equal(normalizeInstitutionStatus(""), null);
  });
});

// --- Approved transitions (the security-relevant policy) --------------------

describe("approved institution status transitions", () => {
  it("allows only the moves declared in the policy map", () => {
    // active
    assert.equal(canTransitionInstitutionStatus("active", "suspended"), true);
    assert.equal(canTransitionInstitutionStatus("active", "archived"), true);
    // suspended
    assert.equal(canTransitionInstitutionStatus("suspended", "active"), true);
    assert.equal(canTransitionInstitutionStatus("suspended", "archived"), true);
    // archived → active (restore)
    assert.equal(canTransitionInstitutionStatus("archived", "active"), true);
  });

  it("refuses self-transitions and disallowed moves (fail closed)", () => {
    for (const status of INSTITUTION_STATUSES) {
      // No-op / self-transition is never "approved".
      assert.equal(
        canTransitionInstitutionStatus(status, status),
        false,
        `${status} → ${status}`,
      );
    }
    // archived cannot jump straight to suspended.
    assert.equal(canTransitionInstitutionStatus("archived", "suspended"), false);
    // Every allowed target is itself a known status.
    for (const status of INSTITUTION_STATUSES) {
      for (const to of ALLOWED_STATUS_TRANSITIONS[status]) {
        assert.equal(isInstitutionStatus(to), true, to);
      }
    }
  });

  it("surfaces exactly the allowed targets for the UI to render", () => {
    const fromActive = availableStatusTransitions("active").map((o) => o.to);
    assert.deepEqual(fromActive, [...ALLOWED_STATUS_TRANSITIONS.active]);
    // Archived offers only restore.
    assert.deepEqual(
      availableStatusTransitions("archived").map((o) => o.to),
      ["active"],
    );
  });
});

// --- Type vocabulary ---------------------------------------------------------

describe("institution type is optional and never guessed", () => {
  it("accepts the controlled vocabulary only", () => {
    for (const type of ["school", "tutorial_centre", "cbt_centre"] as const) {
      assert.equal(isInstitutionType(type), true, type);
    }
    assert.equal(isInstitutionType("university"), false);
    assert.equal(isInstitutionType(null), false);
  });

  it("renders a truthful 'Not set' for null/unknown instead of a default", () => {
    assert.equal(institutionTypeLabel(null), "Not set");
    assert.equal(institutionTypeLabel(undefined), "Not set");
    assert.equal(institutionTypeLabel("ghost"), "Not set");
    assert.equal(institutionTypeLabel("school"), "School");
  });
});

// --- Directory query resolver (untrusted searchParams) ----------------------

describe("resolveInstitutionDirectoryQuery", () => {
  it("defaults to page 1, no search, no status filter, fixed page size", () => {
    assert.deepEqual(resolveInstitutionDirectoryQuery({}), {
      q: "",
      status: null,
      page: 1,
      pageSize: INSTITUTION_DIRECTORY_PAGE_SIZE,
    });
  });

  it("drops an unknown status filter rather than trusting it", () => {
    assert.equal(
      resolveInstitutionDirectoryQuery({ status: "drop_table" }).status,
      null,
    );
  });

  it("keeps a recognised status filter (case/space tolerant)", () => {
    assert.equal(
      resolveInstitutionDirectoryQuery({ status: " Suspended " }).status,
      "suspended",
    );
  });

  it("clamps non-positive and non-numeric pages to 1", () => {
    for (const raw of ["0", "-3", "abc", ""]) {
      assert.equal(resolveInstitutionDirectoryQuery({ page: raw }).page, 1, raw);
    }
    assert.equal(resolveInstitutionDirectoryQuery({ page: "4" }).page, 4);
  });

  it("trims and caps the search term, and reads the first of repeated params", () => {
    assert.equal(resolveInstitutionDirectoryQuery({ q: "  Aba " }).q, "Aba");
    assert.equal(resolveInstitutionDirectoryQuery({ page: ["7", "9"] }).page, 7);
    const long = resolveInstitutionDirectoryQuery({ q: "x".repeat(500) }).q;
    assert.ok(long.length <= 120, "search term must be capped");
  });
});

describe("institutionDirectoryHref", () => {
  it("omits the query string when unfiltered on page 1", () => {
    const query = resolveInstitutionDirectoryQuery({});
    assert.equal(
      institutionDirectoryHref("/platform/institutions", query, 1),
      "/platform/institutions",
    );
  });

  it("preserves search + status and adds the page", () => {
    const query = resolveInstitutionDirectoryQuery({ q: "Furan", status: "active" });
    assert.equal(
      institutionDirectoryHref("/platform/institutions", query, 3),
      "/platform/institutions?q=Furan&status=active&page=3",
    );
  });
});

describe("toInstitutionContainsPattern", () => {
  it("strips filter-breaking characters and wraps a contains-pattern", () => {
    assert.equal(toInstitutionContainsPattern("Aba"), "%Aba%");
    // Syntax characters are removed so the ilike filter cannot break.
    assert.equal(toInstitutionContainsPattern("a*,b%c()d"), "%abcd%");
    // Empty / noise-only terms produce no pattern.
    assert.equal(toInstitutionContainsPattern("   "), "");
    assert.equal(toInstitutionContainsPattern("*%(),"), "");
  });
});

// --- Audit catalog wiring ----------------------------------------------------

describe("institution.status_changed is an audited action", () => {
  it("is a recognised catalog member with a label", () => {
    assert.equal(PLATFORM_AUDIT_ACTIONS.includes("institution.status_changed"), true);
    assert.equal(isPlatformAuditAction("institution.status_changed"), true);
    assert.equal(
      platformAuditActionLabel("institution.status_changed"),
      "Changed an institution's operational status",
    );
  });

  it("normalises a successful status-change event into a row", () => {
    const entry = buildAuditEntry({
      actorId: "user_admin1",
      actorRole: "SUPER_ADMIN",
      action: "institution.status_changed",
      targetType: "institution",
      targetId: "inst_123",
      outcome: "success",
      detail: "Active → Suspended",
    });
    assert.ok(entry);
    assert.equal(entry.actor_role, "SUPER_ADMIN");
    assert.equal(entry.action, "institution.status_changed");
    assert.equal(entry.outcome, "success");
    assert.deepEqual(entry.detail, { summary: "Active → Suspended" });
  });

  it("refuses an unknown status-change style action instead of inventing one", () => {
    const entry = buildAuditEntry({
      actorId: "user_admin1",
      actorRole: "SUPER_ADMIN",
      action: "institution.delete_institution" as never,
      outcome: "success",
    });
    assert.equal(entry, null);
  });
});
