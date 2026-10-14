/**
 * Platform audit catalog tests — prompt 31.
 *
 * Pure module (lib/audit/platform.ts), same Node built-in runner as the rest
 * of the suite; no Supabase, no Next. Covers the closed action catalog, the
 * fail-safe normalisation (unknown action/outcome → no row), the privacy
 * bounds, and the untrusted-searchParams query resolver. The database half
 * (append-only trigger, RLS, CHECKs) is covered by
 * supabase/tests/platform_audit_readiness.sql, which needs a real instance.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUDIT_LIMITS,
  AUDIT_PAGE_SIZE,
  AUDIT_ANONYMOUS_ACTOR_ID,
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_AUDIT_OUTCOMES,
  buildAuditEntry,
  isPlatformAuditAction,
  isPlatformAuditOutcome,
  platformAuditActionLabel,
  resolvePlatformAuditQuery,
  auditPageHref,
  type AuditEventInput,
} from "../../lib/audit/platform.ts";

function denialEvent(
  overrides: Partial<AuditEventInput> = {},
): AuditEventInput {
  return {
    actorId: "user_abc123",
    actorRole: "INSTITUTION_ADMIN",
    action: "platform.access_denied",
    targetType: "area",
    targetId: "/platform",
    outcome: "denied",
    ...overrides,
  };
}

describe("platform audit action catalog", () => {
  it("accepts every declared action and rejects everything else", () => {
    for (const action of PLATFORM_AUDIT_ACTIONS) {
      assert.equal(isPlatformAuditAction(action), true, action);
    }
    for (const value of [
      undefined,
      null,
      "",
      "SUPER_ADMIN",
      "platform.delete_institution",
      "impersonate",
      42,
      ["platform.access_denied"],
    ]) {
      assert.equal(isPlatformAuditAction(value), false, String(value));
    }
  });

  it("recognises only the three declared outcomes", () => {
    for (const outcome of PLATFORM_AUDIT_OUTCOMES) {
      assert.equal(isPlatformAuditOutcome(outcome), true, outcome);
    }
    for (const value of ["ok", "DENIED", "granted", undefined]) {
      assert.equal(isPlatformAuditOutcome(value), false, String(value));
    }
  });
});

describe("buildAuditEntry normalisation", () => {
  it("produces a full row for a well-formed denial event", () => {
    const entry = buildAuditEntry(denialEvent(), new Date("2026-01-02T03:04:05Z"));
    assert.ok(entry);
    assert.equal(entry.created_at, "2026-01-02T03:04:05.000Z");
    assert.equal(entry.actor_id, "user_abc123");
    assert.equal(entry.actor_role, "INSTITUTION_ADMIN");
    assert.equal(entry.action, "platform.access_denied");
    assert.equal(entry.target_type, "area");
    assert.equal(entry.target_id, "/platform");
    assert.equal(entry.outcome, "denied");
    assert.deepEqual(entry.detail, {});
  });

  it("refuses an unknown action instead of guessing one", () => {
    const entry = buildAuditEntry(
      denialEvent({ action: "platform.delete_everything" as never }),
    );
    assert.equal(entry, null);
  });

  it("refuses an unknown outcome", () => {
    const entry = buildAuditEntry(
      denialEvent({ outcome: "granted" as never }),
    );
    assert.equal(entry, null);
  });

  it("degrades an anonymous actor to the unknown identity, not a drop", () => {
    const entry = buildAuditEntry(denialEvent({ actorId: null, actorRole: null }));
    assert.ok(entry);
    assert.equal(entry.actor_id, AUDIT_ANONYMOUS_ACTOR_ID);
    assert.equal(entry.actor_role, "unknown");
  });

  it("records a signed-in-but-unassigned actor distinctly from anonymous", () => {
    const entry = buildAuditEntry(denialEvent({ actorRole: null }));
    assert.ok(entry);
    assert.equal(entry.actor_id, "user_abc123");
    assert.equal(entry.actor_role, "unassigned");
  });

  it("keeps a trusted SUPER_ADMIN role verbatim on the row", () => {
    const entry = buildAuditEntry(
      denialEvent({ actorRole: "SUPER_ADMIN", outcome: "success" }),
    );
    assert.ok(entry);
    assert.equal(entry.actor_role, "SUPER_ADMIN");
    assert.equal(entry.outcome, "success");
  });

  it("bounds an over-long detail summary rather than rejecting the event", () => {
    const entry = buildAuditEntry(
      denialEvent({ detail: "x".repeat(AUDIT_LIMITS.detail + 500) }),
    );
    assert.ok(entry);
    assert.ok(entry.detail && "summary" in entry.detail);
    const summary = (entry.detail as { summary: string }).summary;
    assert.ok(summary.length <= AUDIT_LIMITS.detail);
    assert.equal(summary.endsWith("…"), true);
  });

  it("trims blank detail to an empty object (no fabricated summary)", () => {
    const entry = buildAuditEntry(denialEvent({ detail: "   " }));
    assert.ok(entry);
    assert.deepEqual(entry.detail, {});
  });

  it("trims and normalises whitespace-padded actor/target values", () => {
    const entry = buildAuditEntry(
      denialEvent({ actorId: "  user_pad  ", targetId: " /platform/audit " }),
    );
    assert.ok(entry);
    assert.equal(entry.actor_id, "user_pad");
    assert.equal(entry.target_id, "/platform/audit");
  });
});

describe("platform audit action labels", () => {
  it("describes a known action and falls back to the raw name otherwise", () => {
    assert.equal(
      platformAuditActionLabel("platform.access_denied"),
      "Attempted to open platform administration",
    );
    // A value that predates or bypasses the catalog is shown verbatim, never
    // given an invented description.
    assert.equal(platformAuditActionLabel("legacy.event"), "legacy.event");
  });
});

describe("resolvePlatformAuditQuery (untrusted searchParams)", () => {
  it("defaults to page 1, no filter, fixed page size", () => {
    assert.deepEqual(resolvePlatformAuditQuery({}), {
      action: null,
      page: 1,
      pageSize: AUDIT_PAGE_SIZE,
    });
  });

  it("drops an unknown action filter rather than trusting it", () => {
    const query = resolvePlatformAuditQuery({ action: "drop_table" });
    assert.equal(query.action, null);
  });

  it("keeps a recognised action filter", () => {
    const query = resolvePlatformAuditQuery({ action: "platform.access_denied" });
    assert.equal(query.action, "platform.access_denied");
  });

  it("clamps non-positive and non-numeric pages to 1", () => {
    for (const raw of ["0", "-3", "abc", ""]) {
      assert.equal(resolvePlatformAuditQuery({ page: raw }).page, 1, raw);
    }
    assert.equal(resolvePlatformAuditQuery({ page: "4" }).page, 4);
  });

  it("reads the first value of a repeated array param", () => {
    assert.equal(
      resolvePlatformAuditQuery({ page: ["7", "9"] }).page,
      7,
    );
  });
});

describe("auditPageHref", () => {
  it("omits the query string on page 1 with no filter", () => {
    const query = resolvePlatformAuditQuery({});
    assert.equal(auditPageHref("/platform/audit", query, 1), "/platform/audit");
  });

  it("preserves the action filter and adds the page", () => {
    const query = resolvePlatformAuditQuery({ action: "platform.access_denied" });
    assert.equal(
      auditPageHref("/platform/audit", query, 3),
      "/platform/audit?action=platform.access_denied&page=3",
    );
  });
});
