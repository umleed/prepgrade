/**
 * Trusted principal tests — the client-editability boundary.
 *
 * `readTrustedPrincipal()` is the only place PrepGrade turns provider data into
 * a role and a tenant. These tests pin the fail-closed behaviour: an unassigned
 * account gets no permissions, and a value that is unknown, blank, or the wrong
 * type is treated as absent rather than as a default.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PRINCIPAL_INSTITUTION_KEY,
  PRINCIPAL_ROLE_KEY,
  missingMembershipReason,
  readTrustedPrincipal,
} from "../../lib/auth/principal.ts";

describe("readTrustedPrincipal", () => {
  it("resolves a fully assigned membership from server-written metadata", () => {
    const principal = readTrustedPrincipal({
      userId: "user_1",
      privateMetadata: { [PRINCIPAL_ROLE_KEY]: "teacher", [PRINCIPAL_INSTITUTION_KEY]: "inst_a" },
    });

    assert.deepEqual(principal, {
      userId: "user_1",
      role: "TEACHER",
      institutionId: "inst_a",
      hasMembership: true,
    });
  });

  it("treats a missing or non-object metadata payload as no role and no tenant", () => {
    for (const metadata of [undefined, null, "inst_a", 7, []]) {
      const principal = readTrustedPrincipal({
        userId: "user_1",
        privateMetadata: metadata as never,
      });

      assert.equal(principal?.role, null);
      assert.equal(principal?.institutionId, null);
      assert.equal(principal?.hasMembership, false);
    }
  });

  it("returns null for an anonymous caller so no code can read a fake principal", () => {
    for (const userId of [undefined, null, "", "   "]) {
      assert.equal(
        readTrustedPrincipal({
          userId,
          privateMetadata: { [PRINCIPAL_ROLE_KEY]: "SUPER_ADMIN" },
        }),
        null,
      );
    }
  });

  it("ignores an unrecognised role instead of falling back to a permissive default", () => {
    // A student who somehow got `role: "admin"` written, or a stale value from an
    // older spelling, must resolve to no permissions at all.
    const principal = readTrustedPrincipal({
      userId: "user_1",
      privateMetadata: {
        [PRINCIPAL_ROLE_KEY]: "admin",
        [PRINCIPAL_INSTITUTION_KEY]: "inst_a",
      },
    });

    assert.equal(principal?.role, null);
    assert.equal(principal?.hasMembership, false);
  });

  it("rejects non-string and blank tenant ids", () => {
    for (const institutionId of [42, { id: "inst_a" }, "", "  ", true]) {
      const principal = readTrustedPrincipal({
        userId: "user_1",
        privateMetadata: {
          [PRINCIPAL_ROLE_KEY]: "STUDENT",
          [PRINCIPAL_INSTITUTION_KEY]: institutionId,
        },
      });

      assert.equal(principal?.institutionId, null);
      assert.equal(principal?.hasMembership, false);
    }
  });

  it("requires a tenant for every role except SUPER_ADMIN", () => {
    const noTenant = { [PRINCIPAL_ROLE_KEY]: "INSTITUTION_ADMIN" };
    assert.equal(
      readTrustedPrincipal({ userId: "user_1", privateMetadata: noTenant })
        ?.hasMembership,
      false,
    );

    const superAdmin = readTrustedPrincipal({
      userId: "user_1",
      privateMetadata: { [PRINCIPAL_ROLE_KEY]: "SUPER_ADMIN" },
    });
    assert.equal(superAdmin?.institutionId, null);
    assert.equal(superAdmin?.hasMembership, true);
  });

  it("never lets a role be inferred from a tenant id alone", () => {
    const principal = readTrustedPrincipal({
      userId: "user_1",
      privateMetadata: { [PRINCIPAL_INSTITUTION_KEY]: "inst_a" },
    });

    assert.equal(principal?.role, null);
    assert.equal(principal?.hasMembership, false);
  });
});

describe("missingMembershipReason", () => {
  it("names the missing field so the UI can point at the real fix", () => {
    const noRole = readTrustedPrincipal({ userId: "user_1", privateMetadata: {} });
    const noTenant = readTrustedPrincipal({
      userId: "user_1",
      privateMetadata: { [PRINCIPAL_ROLE_KEY]: "student" },
    });
    const complete = readTrustedPrincipal({
      userId: "user_1",
      privateMetadata: {
        [PRINCIPAL_ROLE_KEY]: "student",
        [PRINCIPAL_INSTITUTION_KEY]: "inst_a",
      },
    });

    assert.equal(missingMembershipReason(noRole!), "role");
    assert.equal(missingMembershipReason(noTenant!), "institution");
    assert.equal(missingMembershipReason(complete!), "none");
  });
});
