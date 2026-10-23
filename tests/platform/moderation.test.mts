/**
 * Platform moderation presentation tests — Super Admin read-only "Moderation".
 *
 * Pure modules only (lib/platform-moderation.ts) — no Supabase, no Next.
 * These pin the rules that keep the screen honest:
 *   - the status tabs are EXACTLY the two states the schema stores
 *     (active/archived) plus an "all" view, and an untrusted tab fails closed
 *     to "all" — never to a column value or an invented review state,
 *   - the tab maps to the shared question reader's `status` filter, and the
 *     href builder never smuggles a cross-tenant bypass into the URL,
 *   - an audit row is presented with the trusted catalog label (raw name for
 *     an unknown action), a fixed outcome tone, and a compact target — as a
 *     governance/security event, never as a moderation "report".
 *
 * The SUPER_ADMIN gate and tenant-boundary rules are covered by
 * tests/platform/super-admin-access.test.mts (the page calls requireSuperAdmin
 * and reads questions through the shared, institution-filtered reader).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MODERATION_STATUS_TABS,
  moderationTabHref,
  moderationTabToStatusFilter,
  presentAuditEvent,
  resolveModerationTab,
  shortId,
  type AuditEventLike,
} from "../../lib/platform-moderation.ts";

// --- Status tabs -------------------------------------------------------------------

describe("moderation status tabs", () => {
  it("offers only all/active/archived — the real stored lifecycle", () => {
    assert.deepEqual([...MODERATION_STATUS_TABS], ["all", "active", "archived"]);
  });

  it("resolves a valid tab and fails closed to 'all' on anything else", () => {
    assert.equal(resolveModerationTab("active"), "active");
    assert.equal(resolveModerationTab("archived"), "archived");
    assert.equal(resolveModerationTab("all"), "all");
    // Junk, casing drift, arrays, and empty all collapse to the honest default.
    assert.equal(resolveModerationTab("pending_review"), "all");
    assert.equal(resolveModerationTab("Active"), "all");
    assert.equal(resolveModerationTab(["active", "archived"]), "active");
    assert.equal(resolveModerationTab(undefined), "all");
    assert.equal(resolveModerationTab(""), "all");
  });

  it("maps a tab to the reader's status filter (all => no filter)", () => {
    assert.equal(moderationTabToStatusFilter("all"), null);
    assert.equal(moderationTabToStatusFilter("active"), "active");
    assert.equal(moderationTabToStatusFilter("archived"), "archived");
  });

  it("builds a clean tab URL that only ever sets the status param", () => {
    const base = "/platform/moderation";
    assert.equal(moderationTabHref(base, "all"), base);
    assert.equal(moderationTabHref(base, "active"), `${base}?status=active`);
    // No institution/bypass parameter is ever introduced by the tab builder.
    assert.equal(moderationTabHref(base, "archived").includes("institution"), false);
  });
});

// --- Audit event presentation -------------------------------------------------------

describe("presentAuditEvent", () => {
  const base: AuditEventLike = {
    id: 1,
    createdAt: "2026-01-02T03:04:05.000Z",
    actorId: "user_1",
    actorRole: "SUPER_ADMIN",
    action: "institution.status_changed",
    targetType: "institution",
    targetId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    outcome: "success",
    summary: "Active → suspended",
  };

  it("labels a known action from the trusted catalog and tones its outcome", () => {
    const view = presentAuditEvent(base);
    assert.equal(view.actionLabel, "Changed an institution's operational status");
    assert.equal(view.actionRaw, "institution.status_changed");
    assert.equal(view.outcomeTone, "success");
    assert.equal(view.summary, "Active → suspended");
  });

  it("falls back to the raw name for an action it cannot name (never invents)", () => {
    const view = presentAuditEvent({ ...base, action: "mystery.report" });
    assert.equal(view.actionLabel, "mystery.report");
  });

  it("tones the three recorded outcomes distinctly and neutralises the rest", () => {
    assert.equal(presentAuditEvent({ ...base, outcome: "denied" }).outcomeTone, "danger");
    assert.equal(presentAuditEvent({ ...base, outcome: "failed" }).outcomeTone, "warning");
    assert.equal(presentAuditEvent({ ...base, outcome: "weird" }).outcomeTone, "neutral");
  });

  it("formats a compact target and drops it when there is none", () => {
    const view = presentAuditEvent(base);
    assert.match(view.target ?? "", /^institution · 3f2504e0/);
    assert.equal(presentAuditEvent({ ...base, targetType: null }).target, null);
    assert.equal(
      presentAuditEvent({ ...base, targetId: null }).target,
      "institution",
    );
  });

  it("shortens long id references without overflowing the column", () => {
    assert.equal(shortId("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), "3f2504e0…");
    assert.equal(shortId("abc"), "abc");
  });
});
