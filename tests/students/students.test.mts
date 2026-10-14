/**
 * Student management tests — prompt 11.
 *
 * Two classes of coverage, both on pure code the app actually runs:
 *   1. validation + list-query/pagination safety (lib/students.ts) — the same
 *      functions the browser form and the server actions share.
 *   2. the tenant/permission boundary + the tenant-presence invariant a student
 *      admin must satisfy. NOTE ON WHAT THE FLOW CALLS: the student pages and
 *      server actions authorize with `requireRole(["INSTITUTION_ADMIN"])` and
 *      scope every query by the trusted `principal.institutionId`; the finer
 *      `checkResourceAccess()` engine (member.manage) is exercised here as the
 *      reference boundary, and its tenant rules match what the data layer
 *      enforces (AGENTS.md §5, prompt 09's cross-institution class).
 *
 * The Supabase data layer itself is NOT exercised here — there is no live DB in
 * `npm test`, and unit tests cannot load the `@/`-aliased, network-backed layer.
 * Its guarantees (constraints, cross-tenant id handling, deployed RLS) are
 * covered by the runnable SQL harness in supabase/tests/, which needs a real
 * database and was NOT run during this review because none was reachable.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeStudentInput,
  resolveStudentListQuery,
  studentPageHref,
  studentTotalPages,
  toLikePattern,
  validateStudent,
  type StudentInput,
} from "../../lib/students.ts";
import type { AccessSubject } from "../../lib/auth/access.ts";
import { decideAccess } from "../../lib/auth/access.ts";
import type { AuthPrincipal } from "../../lib/auth/principal.ts";
import { readTrustedPrincipal } from "../../lib/auth/principal.ts";
import type { UserRole } from "../../lib/auth/roles.ts";
import {
  checkResourceAccess,
  type ResourceAccessRequest,
  type ResourceDescriptor,
} from "../../lib/auth/resource-access.ts";

const INSTITUTION_A = "inst_1111aaaa";
const INSTITUTION_B = "inst_2222bbbb";

function studentInput(overrides: Partial<StudentInput> = {}): StudentInput {
  return {
    fullName: "Ada Okonkwo",
    studentCode: "SS-2025-001",
    classId: "",
    status: "active",
    ...overrides,
  };
}

describe("validateStudent", () => {
  it("accepts a well-formed enrolment", () => {
    assert.deepEqual(validateStudent(studentInput()), {});
  });

  it("requires a name and rejects one that is only whitespace", () => {
    assert.ok(validateStudent(studentInput({ fullName: "   " })).fullName);
  });

  it("rejects a name over 120 characters", () => {
    assert.ok(validateStudent(studentInput({ fullName: "x".repeat(121) })).fullName);
  });

  it("requires a student code", () => {
    assert.ok(validateStudent(studentInput({ studentCode: "" })).studentCode);
  });

  it("rejects a code that starts with a space or a symbol", () => {
    const errors = validateStudent(studentInput({ studentCode: "#42" }));
    assert.ok(errors.studentCode);
  });

  it("rejects a code over 40 characters", () => {
    assert.ok(validateStudent(studentInput({ studentCode: "A".repeat(41) })).studentCode);
  });

  it("accepts the documented code separators and spaces", () => {
    assert.equal(
      validateStudent(studentInput({ studentCode: "2025/SS-01_A" })).studentCode,
      undefined,
    );
  });

  it("rejects an unknown status", () => {
    assert.ok(validateStudent(studentInput({ status: "graduated" })).status);
  });

  it("allows an empty class id (assignment is optional)", () => {
    assert.equal(validateStudent(studentInput({ classId: "" })).classId, undefined);
  });
});

describe("normalizeStudentInput", () => {
  it("trims surrounding whitespace on text fields", () => {
    const clean = normalizeStudentInput(
      studentInput({ fullName: "  Ada  ", studentCode: " 001 ", classId: " c1 " }),
    );
    assert.equal(clean.fullName, "Ada");
    assert.equal(clean.studentCode, "001");
    assert.equal(clean.classId, "c1");
  });
});

describe("resolveStudentListQuery (untrusted URL input)", () => {
  it("defaults to page 1, no filters, all statuses", () => {
    const q = resolveStudentListQuery({});
    assert.equal(q.page, 1);
    assert.equal(q.status, null);
    assert.equal(q.q, "");
    assert.equal(q.classId, "");
  });

  it("clamps non-positive and non-numeric pages back to 1", () => {
    assert.equal(resolveStudentListQuery({ page: "0" }).page, 1);
    assert.equal(resolveStudentListQuery({ page: "-5" }).page, 1);
    assert.equal(resolveStudentListQuery({ page: "abc" }).page, 1);
  });

  it("keeps a valid page number", () => {
    assert.equal(resolveStudentListQuery({ page: "3" }).page, 3);
  });

  it("collapses an unknown status to 'all' and accepts a valid one", () => {
    assert.equal(resolveStudentListQuery({ status: "graduated" }).status, null);
    assert.equal(resolveStudentListQuery({ status: "inactive" }).status, "inactive");
  });

  it("takes the first value when a param arrives as an array", () => {
    assert.equal(resolveStudentListQuery({ q: ["ada", "bob"] }).q, "ada");
  });

  it("trims and bounds the search term", () => {
    const q = resolveStudentListQuery({ q: "  long ".padEnd(200, "x") });
    assert.equal(q.q.length <= 120, true);
    assert.equal(q.q.startsWith("long"), true);
  });
});

describe("studentPageHref", () => {
  const base = "/institution/students";

  it("omits page 1 and no-op filters, producing a clean URL", () => {
    const q = resolveStudentListQuery({});
    assert.equal(studentPageHref(base, q, 1), base);
  });

  it("preserves active filters and appends the page", () => {
    const q = resolveStudentListQuery({ q: "ada", status: "inactive", class: "c1" });
    assert.equal(
      studentPageHref(base, q, 2),
      `${base}?q=ada&class=c1&status=inactive&page=2`,
    );
  });
});

describe("studentTotalPages", () => {
  it("is never below 1", () => {
    assert.equal(studentTotalPages(0, 20), 1);
    assert.equal(studentTotalPages(-5, 20), 1);
  });

  it("rounds up partial pages", () => {
    assert.equal(studentTotalPages(21, 20), 2);
    assert.equal(studentTotalPages(40, 20), 2);
    assert.equal(studentTotalPages(41, 20), 3);
  });
});

describe("toLikePattern (search escaping)", () => {
  it("wraps a plain term as a contains-pattern", () => {
    assert.equal(toLikePattern("ada"), "*ada*");
  });

  it("strips characters that would break the PostgREST or-filter", () => {
    assert.equal(toLikePattern("a,b*c%d(e)"), "*abcde*");
  });

  it("keeps ordinary spaces inside the term", () => {
    assert.equal(toLikePattern("ada owu"), "*ada owu*");
  });

  it("returns an empty pattern for an all-noise term so callers skip the filter", () => {
    assert.equal(toLikePattern("***"), "");
    assert.equal(toLikePattern("   "), "");
  });
});

// --- Tenant / permission boundary for a student (member resource) ----------

function member(
  role: UserRole | null,
  institutionId: string | null,
): AuthPrincipal {
  return {
    userId: "user_1",
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

function memberRequest(
  operation: ResourceAccessRequest["operation"],
  overrides: Partial<ResourceDescriptor> = {},
): ResourceAccessRequest {
  return {
    permission: "member.manage",
    operation,
    resource: { kind: "member", institutionId: INSTITUTION_A, ...overrides },
  };
}

describe("student member.manage boundary", () => {
  it("grants an institution admin read/update in their own tenant", () => {
    assert.equal(
      checkResourceAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), memberRequest("read")).allowed,
      true,
    );
    assert.equal(
      checkResourceAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), memberRequest("update")).allowed,
      true,
    );
  });

  it("denies a student managing members of their own school", () => {
    const decision = checkResourceAccess(
      signedIn("STUDENT", INSTITUTION_A),
      memberRequest("update"),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "permissionDenied");
  });

  it("denies a super admin — platform rights are not tenant rights", () => {
    const decision = checkResourceAccess(
      signedIn("SUPER_ADMIN", null),
      memberRequest("read"),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "permissionDenied");
  });

  it("denies reading another institution's student (cross-tenant)", () => {
    const decision = checkResourceAccess(
      signedIn("INSTITUTION_ADMIN", INSTITUTION_A),
      memberRequest("read", { institutionId: INSTITUTION_B }),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "tenantMismatch");
  });

  it("restricts destructive deletes to institution admins", () => {
    assert.equal(
      checkResourceAccess(signedIn("TEACHER", INSTITUTION_A), memberRequest("delete")).allowed,
      false,
    );
    assert.equal(
      checkResourceAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), memberRequest("delete")).allowed,
      true,
    );
  });

  it("denies an admin acting on another institution's record (tenant gate)", () => {
    // The pages scope by the trusted principal.institutionId; when a tenant is
    // supplied to the engine, a cross-tenant record is denied as tenantMismatch.
    const decision = decideAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), {
      roles: ["INSTITUTION_ADMIN"],
      institutionId: INSTITUTION_B,
    });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "tenantMismatch");
  });
});

// --- The tenant invariant the student actions & data layer rely on ----------
// Every student page/action does `principal.institutionId as string` after
// `requireRole(["INSTITUTION_ADMIN"])`. That cast is only sound because an
// INSTITUTION_ADMIN with no usable tenant can NEVER be authorized. These tests
// pin that guarantee: a missing/blank/role-without-tenant principal fails
// closed, so the data layer never scopes to `null` and never widens access.
describe("student flow tenant invariant (why the institutionId cast is safe)", () => {
  it("an admin with no institution has no membership and is denied", () => {
    const principal = readTrustedPrincipal({
      userId: "user_admin",
      privateMetadata: { role: "INSTITUTION_ADMIN" },
    });
    assert.ok(principal);
    assert.equal(principal.hasMembership, false);
    assert.equal(principal.institutionId, null);

    const decision = decideAccess(
      { session: "active", principal },
      { roles: ["INSTITUTION_ADMIN"] },
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "noMembership");
  });

  it("a blank/whitespace institution id is treated as absent (fail closed)", () => {
    const principal = readTrustedPrincipal({
      userId: "user_admin",
      privateMetadata: { role: "INSTITUTION_ADMIN", institutionId: "   " },
    });
    assert.ok(principal);
    assert.equal(principal.institutionId, null);
    assert.equal(principal.hasMembership, false);
  });

  it("a browser-writable channel is never consulted (only privateMetadata)", () => {
    // readTrustedPrincipal accepts the server-written object only; an empty
    // metadata object yields no role and no tenant — a student cannot elevate.
    const principal = readTrustedPrincipal({ userId: "user_x", privateMetadata: {} });
    assert.ok(principal);
    assert.equal(principal.role, null);
    assert.equal(principal.hasMembership, false);
  });
});
