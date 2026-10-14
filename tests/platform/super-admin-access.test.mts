/**
 * Platform (super-admin) gate tests — prompt 31.
 *
 * Exercises the exact `decideAccess(subject, { roles: ["SUPER_ADMIN"] })`
 * call that `requireSuperAdmin()` makes in guards.ts, so a green test means
 * the rule the /platform routes run in production behaves as claimed:
 *   - only SUPER_ADMIN is granted the platform area,
 *   - every tenant role is denied with roleNotAllowed (never a silent pass),
 *   - an unassigned account and an anonymous/expired session fail closed.
 *
 * The audit-on-denial wiring itself lives in guards.ts (needs Next's
 * redirect) and the DB guarantees in the readiness SQL; this file pins the
 * authorization decision that gates both.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideAccess,
  statusForDenial,
  type AccessDecision,
  type AccessDenial,
  type AccessSubject,
} from "../../lib/auth/access.ts";
import type { AuthPrincipal } from "../../lib/auth/principal.ts";
import type { UserRole } from "../../lib/auth/roles.ts";

const INSTITUTION_A = "inst_1111aaaa";

function member(
  role: UserRole | null,
  institutionId: string | null,
  userId = "user_1",
): AuthPrincipal {
  return {
    userId,
    role,
    institutionId,
    hasMembership:
      role !== null && (role === "SUPER_ADMIN" || institutionId !== null),
  };
}

function signedIn(
  role: UserRole | null,
  institutionId: string | null = null,
): AccessSubject {
  return { session: "active", principal: member(role, institutionId) };
}

function denialOf(decision: AccessDecision): AccessDenial {
  assert.equal(decision.allowed, false, "expected a denial");
  if (decision.allowed) throw new Error("unreachable");
  return decision.reason;
}

/** The platform requirement every /platform route applies. */
const PLATFORM = { roles: ["SUPER_ADMIN"] } as const;

describe("platform gate grants only SUPER_ADMIN", () => {
  it("admits a platform-scoped super admin with no tenant", () => {
    const decision = decideAccess(signedIn("SUPER_ADMIN", null), PLATFORM);
    assert.equal(decision.allowed, true);
    if (decision.allowed) {
      assert.equal(decision.principal.role, "SUPER_ADMIN");
    }
  });

  it("rejects every tenant role with roleNotAllowed (fail closed, not silent)", () => {
    for (const role of ["INSTITUTION_ADMIN", "TEACHER", "STUDENT"] as const) {
      const reason = denialOf(
        decideAccess(signedIn(role, INSTITUTION_A), PLATFORM),
      );
      assert.equal(reason, "roleNotAllowed", role);
    }
  });

  it("rejects a signed-in account with no trusted role", () => {
    assert.equal(
      denialOf(decideAccess(signedIn(null, null), PLATFORM)),
      "noMembership",
    );
  });

  it("rejects anonymous and expired sessions as session problems, not role ones", () => {
    assert.equal(
      denialOf(
        decideAccess({ session: "anonymous", principal: null }, PLATFORM),
      ),
      "signedOut",
    );
    assert.equal(
      denialOf(
        decideAccess({ session: "expired", principal: null }, PLATFORM),
      ),
      "sessionExpired",
    );
  });

  it("maps the role denial to 403 and the session denials to 401", () => {
    // A denied API probe from an authenticated tenant user is 403; an
    // anonymous one is 401 — the distinction the audit + HTTP layer rely on.
    assert.equal(statusForDenial("roleNotAllowed"), 403);
    assert.equal(statusForDenial("noMembership"), 403);
    assert.equal(statusForDenial("signedOut"), 401);
    assert.equal(statusForDenial("sessionExpired"), 401);
  });
});

describe("platform role does not leak tenant authority", () => {
  it("still requires an explicit tenant match for tenant-scoped reads", () => {
    // SUPER_ADMIN passes a tenant check by design (audited support reads), but
    // a tenant admin may NOT cross tenants — the platform gate must not
    // weaken that boundary anywhere else.
    const superAdmin = decideAccess(
      signedIn("SUPER_ADMIN", null),
      { roles: ["SUPER_ADMIN"], institutionId: INSTITUTION_A },
    );
    assert.equal(superAdmin.allowed, true);

    const otherTenantAdmin = denialOf(
      decideAccess(
        signedIn("INSTITUTION_ADMIN", "inst_other"),
        { roles: ["INSTITUTION_ADMIN"], institutionId: INSTITUTION_A },
      ),
    );
    assert.equal(otherTenantAdmin, "tenantMismatch");
  });
});
