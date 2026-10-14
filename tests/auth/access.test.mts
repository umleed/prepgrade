/**
 * Access decision tests — the security boundaries prompt 07 asks for:
 * unauthenticated access, each of the four roles, a missing membership, and
 * cross-tenant access attempts.
 *
 * These call `decideAccess()`, the same function `guards.ts` uses for pages and
 * (via `inspectAccess()`) for route handlers — so a passing test means the rule
 * that actually runs in production behaves this way.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACCESS_NOTICES,
  accessNotice,
  decideAccess,
  loginUrlFor,
  type AccessDecision,
  type AccessDenial,
  type AccessSubject,
} from "../../lib/auth/access.ts";
import type { AuthPrincipal } from "../../lib/auth/principal.ts";
import type { UserRole } from "../../lib/auth/roles.ts";

const INSTITUTION_A = "inst_1111aaaa";
const INSTITUTION_B = "inst_2222bbbb";

/** Build a membership-shaped principal (mirrors what prompt 08 will return). */
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
  institutionId: string | null,
): AccessSubject {
  return { session: "active", principal: member(role, institutionId) };
}

/** Assert the decision denied access, and return it narrowed to the denial. */
function denial(decision: AccessDecision): {
  reason: AccessDenial;
  principal: AuthPrincipal | null;
} {
  if (decision.allowed) {
    assert.fail(
      `expected a denial but access was granted to ${decision.principal.role ?? "unassigned"}`,
    );
  }
  return decision;
}

/** Assert the decision granted access, and return it narrowed to the grant. */
function granted(decision: AccessDecision): { principal: AuthPrincipal } {
  if (!decision.allowed) {
    assert.fail(`expected access to be granted but it was denied: ${decision.reason}`);
  }
  return decision;
}

describe("unauthenticated access", () => {
  it("is denied for every requirement, with no principal leaked", () => {
    const anonymous: AccessSubject = { session: "anonymous", principal: null };

    const decision = denial(
      decideAccess(anonymous, {
        roles: ["TEACHER"],
        institutionId: INSTITUTION_A,
      }),
    );

    assert.equal(decision.reason, "signedOut");
    assert.equal(decision.principal, null);
  });

  it("distinguishes an expired session, but denies it exactly the same way", () => {
    const expired = denial(
      decideAccess(
        { session: "expired", principal: null },
        { institutionId: INSTITUTION_A },
      ),
    );

    assert.equal(expired.reason, "sessionExpired");
    // The expired case must never fall through to a tenant/role evaluation.
    assert.equal(
      accessNotice({ allowed: false, reason: expired.reason, principal: null })
        ?.title,
      ACCESS_NOTICES.sessionExpired.title,
    );
  });

  it("still denies an expired session that carries a stale, privileged principal", () => {
    // Guards against trusting a principal cached from a previous session.
    const decision = denial(
      decideAccess(
        { session: "expired", principal: member("INSTITUTION_ADMIN", INSTITUTION_A) },
        { roles: ["INSTITUTION_ADMIN"], institutionId: INSTITUTION_A },
      ),
    );

    assert.equal(decision.reason, "sessionExpired");
  });
});

describe("missing membership", () => {
  it("denies a signed-in account with no role assigned", () => {
    const decision = denial(decideAccess(signedIn(null, null), {}));

    assert.equal(decision.reason, "noMembership");
    // The principal is returned so the page can explain what is missing.
    assert.equal(decision.principal?.role, null);
  });

  it("denies a signed-in account whose role has no institution attached", () => {
    for (const role of ["STUDENT", "TEACHER", "INSTITUTION_ADMIN"] as const) {
      const decision = denial(decideAccess(signedIn(role, null), {}));
      assert.equal(decision.reason, "noMembership", `${role} without a tenant`);
    }
  });

  it("grants SUPER_ADMIN without a tenant, because it is platform-scoped", () => {
    granted(decideAccess(signedIn("SUPER_ADMIN", null), {}));
  });

  it("reports noMembership before roleNotAllowed when both would apply", () => {
    // Ordering matters: an account with no membership must not learn that the
    // page it knocked on is a teacher page.
    const decision = denial(decideAccess(signedIn(null, null), { roles: ["TEACHER"] }));
    assert.equal(decision.reason, "noMembership");
  });
});

describe("each role against the areas it owns", () => {
  it("routes and grants the four roles per the matrix", () => {
    const cases: Array<{
      role: UserRole;
      institutionId: string | null;
      allowedRoles: readonly UserRole[];
    }> = [
      { role: "SUPER_ADMIN", institutionId: null, allowedRoles: ["SUPER_ADMIN"] },
      {
        role: "INSTITUTION_ADMIN",
        institutionId: INSTITUTION_A,
        allowedRoles: ["INSTITUTION_ADMIN", "TEACHER"],
      },
      { role: "TEACHER", institutionId: INSTITUTION_A, allowedRoles: ["TEACHER"] },
      { role: "STUDENT", institutionId: INSTITUTION_A, allowedRoles: ["STUDENT"] },
    ];

    for (const { role, institutionId, allowedRoles } of cases) {
      const { principal } = granted(
        decideAccess(signedIn(role, institutionId), { roles: allowedRoles }),
      );
      assert.equal(principal.role, role, `${role} principal is returned`);
    }
  });

  it("denies a student who knocks on a teacher-only surface", () => {
    const decision = denial(
      decideAccess(signedIn("STUDENT", INSTITUTION_A), {
        roles: ["TEACHER", "INSTITUTION_ADMIN"],
      }),
    );

    assert.equal(decision.reason, "roleNotAllowed");
  });

  it("denies a teacher on an institution-admin surface", () => {
    const decision = denial(
      decideAccess(signedIn("TEACHER", INSTITUTION_A), { roles: ["INSTITUTION_ADMIN"] }),
    );
    assert.equal(decision.reason, "roleNotAllowed");
  });

  it("denies a school admin on the platform surface", () => {
    const decision = denial(
      decideAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), {
        roles: ["SUPER_ADMIN"],
      }),
    );
    assert.equal(decision.reason, "roleNotAllowed");
  });

  it("treats an empty role list as 'any signed-in member', not 'nobody'", () => {
    granted(decideAccess(signedIn("STUDENT", INSTITUTION_A), { roles: [] }));
  });
});

describe("cross-tenant access", () => {
  it("denies a teacher reading another institution's record", () => {
    const decision = denial(
      decideAccess(signedIn("TEACHER", INSTITUTION_A), {
        roles: ["TEACHER"],
        institutionId: INSTITUTION_B,
      }),
    );

    assert.equal(decision.reason, "tenantMismatch");
    // The denial notice must not name the other institution.
    assert.doesNotMatch(
      ACCESS_NOTICES[decision.reason].message,
      new RegExp(INSTITUTION_B),
    );
  });

  it("denies an institution admin managing another institution's data", () => {
    const decision = denial(
      decideAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), {
        roles: ["INSTITUTION_ADMIN"],
        institutionId: INSTITUTION_B,
      }),
    );
    assert.equal(decision.reason, "tenantMismatch");
  });

  it("denies a student enrolled in another institution's exam", () => {
    const decision = denial(
      decideAccess(signedIn("STUDENT", INSTITUTION_A), {
        roles: ["STUDENT"],
        institutionId: INSTITUTION_B,
      }),
    );
    assert.equal(decision.reason, "tenantMismatch");
  });

  it("grants access when the record belongs to the caller's own institution", () => {
    granted(
      decideAccess(signedIn("TEACHER", INSTITUTION_A), {
        roles: ["TEACHER"],
        institutionId: INSTITUTION_A,
      }),
    );
  });

  it("applies the role rule first, so a cross-role attempt leaks nothing", () => {
    // A student reaching for another school's teacher analytics is denied on role
    // grounds before the tenant comparison is ever consulted.
    const decision = denial(
      decideAccess(signedIn("STUDENT", INSTITUTION_A), {
        roles: ["TEACHER"],
        institutionId: INSTITUTION_B,
      }),
    );
    assert.equal(decision.reason, "roleNotAllowed");
  });

  it("lets SUPER_ADMIN pass a tenant check (support reads) without granting it tenant areas", () => {
    // Tenant *area* entry is still refused by canAccessArea; this bypass exists
    // only for explicitly audited platform screens (prompts 31 and 33).
    granted(decideAccess(signedIn("SUPER_ADMIN", null), { institutionId: INSTITUTION_B }));
  });

  it("ignores an absent tenant constraint", () => {
    for (const institutionId of [undefined, null]) {
      granted(
        decideAccess(signedIn("TEACHER", INSTITUTION_A), {
          roles: ["TEACHER"],
          institutionId,
        }),
      );
    }
  });

  it("denies against an empty tenant string rather than treating it as absent", () => {
    // A caller that resolves a record's tenant to "" has not supplied a
    // constraint of "none"; it is a mismatch and must be denied.
    const decision = denial(
      decideAccess(signedIn("TEACHER", INSTITUTION_A), { institutionId: "" }),
    );
    assert.equal(decision.reason, "tenantMismatch");
  });
});

describe("sign-in redirect targets", () => {
  it("preserves the intended path and reason", () => {
    assert.equal(
      loginUrlFor("/dashboard", "sessionExpired"),
      "/login?next=%2Fdashboard&reason=expired",
    );
    assert.equal(loginUrlFor("/onboarding"), "/login?next=%2Fonboarding");
  });

  it("falls back to the dashboard when no path is known", () => {
    assert.equal(loginUrlFor(""), "/login?next=%2Fdashboard");
  });
});
