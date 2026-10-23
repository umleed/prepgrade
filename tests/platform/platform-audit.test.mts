/**
 * Platform audit catalog tests — prompts 31 and 33.
 *
 * Pure module (lib/audit/platform.ts), same Node built-in runner as the rest
 * of the suite; no Supabase, no Next. Covers the closed action catalog, the
 * fail-safe normalisation (unknown action/outcome → no row), the privacy
 * bounds, and the untrusted-searchParams query resolver — including the
 * prompt-33 operational filters (date range, actor, institution, outcome,
 * entity) and the sensitive membership-change catalog entries. The database
 * half (append-only trigger, RLS, CHECKs) is covered by
 * supabase/tests/platform_audit_readiness.sql, which needs a real instance.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUDIT_ENTITY_TYPES,
  AUDIT_LIMITS,
  AUDIT_PAGE_SIZE,
  AUDIT_ANONYMOUS_ACTOR_ID,
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_AUDIT_OUTCOMES,
  buildAuditEntry,
  isPlatformAuditAction,
  isPlatformAuditOutcome,
  platformAuditActionLabel,
  platformAuditHasFilters,
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

/** Expected UI labels for the prompt-33 additions, pinned here so a label
 *  drift (or a missing catalog entry) fails the suite deliberately. */
const PROMPT33_LABELS = {
  "membership.teacher_access_changed":
    "Granted a teacher access to the institution",
  "membership.teacher_access_revoked":
    "Revoked a teacher's access to the institution",
  "institution.settings_updated": "Updated the institution's settings",
} as const;

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

  it("includes the prompt-33 sensitive actions, each with a label", () => {
    // Membership/role changes and administrative tenant changes must be in
    // the closed catalog before any action can write them.
    for (const action of [
      "membership.teacher_access_changed",
      "membership.teacher_access_revoked",
      "institution.settings_updated",
    ] as const) {
      assert.equal(isPlatformAuditAction(action), true, action);
      assert.equal(
        platformAuditActionLabel(action),
        PROMPT33_LABELS[action],
        action,
      );
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
  it("normalises a teacher-access event targeted at the actor's tenant", () => {
    const entry = buildAuditEntry(
      denialEvent({
        actorRole: "INSTITUTION_ADMIN",
        action: "membership.teacher_access_changed",
        targetType: "institution",
        targetId: "inst_123",
        outcome: "success",
        detail: "Teacher roster row t_9: access granted (was `invited`)",
      }),
    );
    assert.ok(entry);
    assert.equal(entry.action, "membership.teacher_access_changed");
    assert.equal(entry.target_type, "institution");
    assert.equal(entry.target_id, "inst_123");
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
      outcome: null,
      actor: null,
      institutionId: null,
      entityType: null,
      from: null,
      to: null,
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

  it("keeps a valid date range and pins it to UTC day boundaries", () => {
    const query = resolvePlatformAuditQuery({
      from: "2026-01-05",
      to: "2026-01-12",
    });
    assert.equal(query.from, "2026-01-05T00:00:00.000Z");
    assert.equal(query.to, "2026-01-12T23:59:59.999Z");
    assert.equal(platformAuditHasFilters(query), true);
  });

  it("drops malformed, impossible-day, and free-text date values", () => {
    for (const raw of ["01-05-2026", "2026-13-45", "yesterday", "", "2026-1-5"]) {
      const query = resolvePlatformAuditQuery({ from: raw, to: raw });
      assert.equal(query.from, null, raw);
      assert.equal(query.to, null, raw);
    }
  });

  it("trims actor and institution filters and drops blanks/over-long values", () => {
    const query = resolvePlatformAuditQuery({
      actor: "  user_abc  ",
      institution: " inst_1 ",
    });
    assert.equal(query.actor, "user_abc");
    assert.equal(query.institutionId, "inst_1");

    const blank = resolvePlatformAuditQuery({ actor: "   ", institution: "" });
    assert.equal(blank.actor, null);
    assert.equal(blank.institutionId, null);

    const padded = resolvePlatformAuditQuery({
      actor: "x".repeat(AUDIT_LIMITS.actorId + 1),
      institution: "y".repeat(AUDIT_LIMITS.targetId + 1),
    });
    assert.equal(padded.actor, null);
    assert.equal(padded.institutionId, null);
  });

  it("accepts only the controlled outcome and entity vocabularies", () => {
    assert.equal(
      resolvePlatformAuditQuery({ outcome: "denied" }).outcome,
      "denied",
    );
    assert.equal(resolvePlatformAuditQuery({ outcome: "ok" }).outcome, null);

    for (const entity of AUDIT_ENTITY_TYPES) {
      assert.equal(
        resolvePlatformAuditQuery({ entity }).entityType,
        entity,
        entity,
      );
    }
    // An invented target type drops the filter — it never becomes a column
    // value, which is what keeps the log from being an injection-shaped
    // read path.
    assert.equal(resolvePlatformAuditQuery({ entity: "secret_table" }).entityType, null);
  });

  it("reports no active filters when only pagination is present", () => {
    assert.equal(platformAuditHasFilters(resolvePlatformAuditQuery({ page: "2" })), false);
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

  it("round-trips every prompt-33 filter through the URL", () => {
    const query = resolvePlatformAuditQuery({
      action: "membership.teacher_access_changed",
      outcome: "success",
      actor: "user_abc",
      institution: "inst_1",
      entity: "institution",
      from: "2026-01-05",
      to: "2026-01-12",
    });
    const href = auditPageHref("/platform/audit", query, 2);
    const revived = resolvePlatformAuditQuery(
      Object.fromEntries(new URL(href, "http://x").searchParams),
    );
    assert.equal(revived.page, 2);
    // Compare the filter half only — `page` is asserted above.
    const auditFilters = (q: typeof query) => ({
      action: q.action,
      outcome: q.outcome,
      actor: q.actor,
      institutionId: q.institutionId,
      entityType: q.entityType,
      from: q.from,
      to: q.to,
    });
    assert.deepEqual(auditFilters(revived), auditFilters(query));
  });

  it("keeps the 'none' entity sentinel in the URL (distinct from no filter)", () => {
    const query = resolvePlatformAuditQuery({ entity: "none" });
    const href = auditPageHref("/platform/audit", query, 1);
    assert.equal(href, "/platform/audit?entity=none");
    assert.equal(resolvePlatformAuditQuery({ entity: "none" }).entityType, "none");
  });
});
