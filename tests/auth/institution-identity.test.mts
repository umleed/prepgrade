/**
 * Institution identity tests — run with `npm test` (Node's built-in runner).
 *
 * Covers the sidebar-name fix: which membership confirms the trusted tenant,
 * and what the navigation is allowed to display. The data-layer read itself
 * needs a database; everything that decides correctness — membership
 * selection and the display rule — lives in the pure module tested here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INSTITUTION_NAME_UNAVAILABLE,
  institutionDisplayText,
  selectTrustedAdminMembership,
} from "../../lib/auth/institution-identity.ts";
import { readTrustedPrincipal } from "../../lib/auth/principal.ts";

const TRUSTED_TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";

function membership(
  institutionId: string,
  role = "INSTITUTION_ADMIN",
  status = "active",
) {
  return { institutionId, role, status };
}

describe("selectTrustedAdminMembership", () => {
  it("confirms the active admin membership for the trusted tenant", () => {
    const row = selectTrustedAdminMembership(TRUSTED_TENANT, [
      membership(TRUSTED_TENANT),
    ]);
    assert.deepEqual(row, membership(TRUSTED_TENANT));
  });

  it("with multiple memberships, picks the trusted tenant — never the first row", () => {
    // The other institution's admin row comes first: selection must still
    // land on the tenant the server-resolved principal points at.
    const rows = [membership(OTHER_TENANT), membership(TRUSTED_TENANT)];
    const row = selectTrustedAdminMembership(TRUSTED_TENANT, rows);
    assert.equal(row?.institutionId, TRUSTED_TENANT);
  });

  it("never returns a row for another institution", () => {
    // Trusted tenant has no row at all; an admin row elsewhere must not be
    // borrowed — that would leak another institution's identity.
    const row = selectTrustedAdminMembership(TRUSTED_TENANT, [
      membership(OTHER_TENANT),
    ]);
    assert.equal(row, null);
  });

  it("rejects inactive memberships for the trusted tenant", () => {
    const row = selectTrustedAdminMembership(TRUSTED_TENANT, [
      membership(TRUSTED_TENANT, "INSTITUTION_ADMIN", "inactive"),
    ]);
    assert.equal(row, null);
  });

  it("rejects unknown membership statuses rather than defaulting to active", () => {
    const row = selectTrustedAdminMembership(TRUSTED_TENANT, [
      membership(TRUSTED_TENANT, "INSTITUTION_ADMIN", "pending-approval"),
    ]);
    assert.equal(row, null);
  });

  it("rejects non-admin roles at the trusted tenant", () => {
    for (const role of ["TEACHER", "STUDENT", "SUPER_ADMIN", "root", 42, null]) {
      const row = selectTrustedAdminMembership(TRUSTED_TENANT, [
        membership(TRUSTED_TENANT, role as string),
      ]);
      assert.equal(row, null, `role ${String(role)} must not confirm admin membership`);
    }
  });

  it("accepts the canonical role spelling in any case/padding, matching the auth normaliser", () => {
    const row = selectTrustedAdminMembership(TRUSTED_TENANT, [
      membership(TRUSTED_TENANT, " institution-admin "),
    ]);
    assert.ok(row, "normalised spellings confirm the membership");
  });

  it("fails closed on a missing or blank trusted tenant id", () => {
    assert.equal(selectTrustedAdminMembership(null, [membership(TRUSTED_TENANT)]), null);
    assert.equal(selectTrustedAdminMembership("", [membership(TRUSTED_TENANT)]), null);
    assert.equal(selectTrustedAdminMembership("   ", [membership(TRUSTED_TENANT)]), null);
  });

  it("ignores malformed rows without throwing", () => {
    const rows = [
      { institutionId: null as unknown as string, role: "INSTITUTION_ADMIN", status: "active" },
      { institutionId: 7 as unknown as string, role: "INSTITUTION_ADMIN", status: "active" },
      membership(TRUSTED_TENANT),
    ];
    assert.deepEqual(selectTrustedAdminMembership(TRUSTED_TENANT, rows), membership(TRUSTED_TENANT));
  });

  it("keys the lookup off the server-resolved principal, not a client value", () => {
    // Same flow the layout runs: privateMetadata -> principal -> lookup.
    // A Google-signed-in account is no different — the strategy never enters
    // this decision; only server-written membership does.
    const principal = readTrustedPrincipal({
      userId: "user_google",
      privateMetadata: { role: "INSTITUTION_ADMIN", institutionId: TRUSTED_TENANT },
    });
    assert.ok(principal?.hasMembership);
    const row = selectTrustedAdminMembership(principal!.institutionId, [
      membership(OTHER_TENANT),
      membership(TRUSTED_TENANT),
    ]);
    assert.equal(row?.institutionId, principal!.institutionId);
  });
});

describe("institutionDisplayText", () => {
  it("shows the real name, trimmed", () => {
    assert.equal(
      institutionDisplayText("  Greenfield Secondary School  "),
      "Greenfield Secondary School",
    );
  });

  it("falls back honestly when the name is missing — never an identifier", () => {
    const fallback = institutionDisplayText(null);
    assert.equal(fallback, INSTITUTION_NAME_UNAVAILABLE);
    // The UUID-shaped tenant id must never surface as the display name.
    assert.ok(!fallback.includes(TRUSTED_TENANT));
    assert.ok(!fallback.includes("-"));
  });

  it("treats blank and non-string names as unavailable, not as ''", () => {
    for (const value of [undefined, "", "   ", 42 as unknown as string]) {
      assert.equal(institutionDisplayText(value), INSTITUTION_NAME_UNAVAILABLE);
    }
  });

  it("does not substitute an email or a person's name for the institution", () => {
    // Guard by contract: the only accepted input is the institutions.name
    // read; the fallback constant is fixed copy, never derived from the user.
    assert.equal(INSTITUTION_NAME_UNAVAILABLE, "Institution name unavailable");
    assert.ok(!INSTITUTION_NAME_UNAVAILABLE.includes("@"));
  });
});
