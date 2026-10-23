/**
 * Notification decision tests — prompt 35 (Clerk-only delivery path).
 *
 * Pure modules only, the same Node built-in runner as the rest of the suite:
 * no Clerk, no Supabase, no Next. The live network send in
 * lib/auth/provisioning.ts is SERVER-ONLY and is verified end-to-end against a
 * real project, NOT here. What this file pins is the two decisions the
 * invitation notification depends on, so the prompt's "handle failed delivery
 * without losing the record" and "do not leak private information" rules are
 * covered by an assertion instead of prose.
 *
 *   1. isDuplicateInvitationError — the ONLY failure we swallow as a normal
 *      "already invited/registered" branch. Everything else stays fatal so the
 *      admin is told the email was not sent (and the roster row is kept by the
 *      caller). Both the 422 status AND the duplicate message must agree.
 *   2. invitationRedirectUrl — the shared, bare /login link. No trailing-slash
 *      duplication, undefined when no base URL, and never carrying any
 *      tenant/exam/personal data.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  invitationRedirectUrl,
  isDuplicateInvitationError,
  type InvitationDeliveryError,
} from "../../lib/notifications.ts";

/** Build a Clerk-shaped error fixture: a numeric status + an errorsText(). */
function clerkError(status: number, text: string): InvitationDeliveryError {
  return { status, errorsText: () => text };
}

// --- isDuplicateInvitationError (failed-delivery classification) ------------

describe("isDuplicateInvitationError", () => {
  it("treats a 422 'already invited/exists' as the expected duplicate branch", () => {
    assert.equal(
      isDuplicateInvitationError(clerkError(422, "Invitation already exists")),
      true,
    );
    assert.equal(
      isDuplicateInvitationError(clerkError(422, "The email address exists")),
      true,
    );
    assert.equal(
      isDuplicateInvitationError(clerkError(422, "already invited this member")),
      true,
    );
  });

  it("matches case-insensitively", () => {
    assert.equal(isDuplicateInvitationError(clerkError(422, "ALREADY EXISTS")), true);
    assert.equal(isDuplicateInvitationError(clerkError(422, "Exists")), true);
  });

  it("does NOT swallow a 422 for a different validation reason (stays fatal)", () => {
    // e.g. an invalid email or missing field — a real failure the admin must see.
    assert.equal(isDuplicateInvitationError(clerkError(422, "Invalid email address")), false);
    assert.equal(isDuplicateInvitationError(clerkError(422, "")), false);
  });

  it("does NOT treat a duplicate-looking message under another status as benign", () => {
    assert.equal(isDuplicateInvitationError(clerkError(500, "already exists")), false);
    assert.equal(isDuplicateInvitationError(clerkError(401, "user exists")), false);
    assert.equal(isDuplicateInvitationError(clerkError(429, "too many already")), false);
  });

  it("is defensive about a malformed/absent error (never a false duplicate)", () => {
    assert.equal(isDuplicateInvitationError(undefined), false);
    assert.equal(isDuplicateInvitationError(null), false);
    assert.equal(isDuplicateInvitationError({}), false);
    assert.equal(isDuplicateInvitationError("some raw string"), false);
    // status present but no errorsText() accessor → empty message → not duplicate.
    assert.equal(isDuplicateInvitationError({ status: 422 }), false);
    // errorsText present but no status → not duplicate.
    assert.equal(isDuplicateInvitationError({ errorsText: () => "already exists" }), false);
  });
});

// --- invitationRedirectUrl (link shape & non-leak) --------------------------

describe("invitationRedirectUrl", () => {
  it("appends /login to a clean base URL", () => {
    assert.equal(
      invitationRedirectUrl("https://app.prepgrade.ng"),
      "https://app.prepgrade.ng/login",
    );
  });

  it("collapses one or more trailing slashes without doubling", () => {
    assert.equal(
      invitationRedirectUrl("https://app.prepgrade.ng/"),
      "https://app.prepgrade.ng/login",
    );
    assert.equal(
      invitationRedirectUrl("https://app.prepgrade.ng///"),
      "https://app.prepgrade.ng/login",
    );
  });

  it("trims surrounding whitespace before building", () => {
    assert.equal(
      invitationRedirectUrl("  http://localhost:3000  "),
      "http://localhost:3000/login",
    );
  });

  it("returns undefined for an absent/blank/whitespace base (no fabricated link)", () => {
    assert.equal(invitationRedirectUrl(undefined), undefined);
    assert.equal(invitationRedirectUrl(null), undefined);
    assert.equal(invitationRedirectUrl(""), undefined);
    assert.equal(invitationRedirectUrl("   "), undefined);
  });

  it("produces a shared bare path that carries no tenant, exam, or personal data", () => {
    const url = invitationRedirectUrl("https://app.prepgrade.ng");
    assert.ok(url);
    // The invitation link is the SAME for every invitee — nothing identifying
    // or institution-specific leaks through it (AGENTS.md §7).
    assert.equal(url, "https://app.prepgrade.ng/login");
    assert.equal(url.includes("institution"), false);
    assert.equal(url.includes("exam"), false);
    assert.equal(url.includes("@"), false);
  });
});
