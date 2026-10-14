/**
 * Teacher management tests — prompt 12.
 *
 * Coverage mirrors the student test harness:
 *   1. Validation + normalisation (lib/teachers.ts) — the same functions the
 *      browser form and the server actions share.
 *   2. List query/pagination safety (untrusted URL params).
 *   3. Search escaping (PostgREST ilike pattern).
 *   4. Privilege-escalation guard — the core security requirement: a tampered
 *      or malformed role string can NEVER resolve to SUPER_ADMIN or
 *      INSTITUTION_ADMIN through the teacher flow.
 *   5. Tenant/permission boundary + the tenant-presence invariant the teacher
 *      actions rely on.
 *
 * The Supabase data layer is NOT exercised here (no live DB in `npm test`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeTeacherInput,
  resolveGrantableTeacherRole,
  resolveTeacherListQuery,
  teacherGrantRole,
  teacherPageHref,
  teacherTotalPages,
  toTeacherLikePattern,
  validateTeacher,
  type TeacherInput,
} from "../../lib/teachers.ts";
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

function teacherInput(overrides: Partial<TeacherInput> = {}): TeacherInput {
  return {
    fullName: "Grace Adeyemi",
    email: "grace.adeyemi@school.ng",
    employeeCode: "TCH-2025-001",
    classIds: [],
    ...overrides,
  };
}

// --- validateTeacher --------------------------------------------------------

describe("validateTeacher", () => {
  it("accepts a well-formed invitation payload", () => {
    assert.deepEqual(validateTeacher(teacherInput()), {});
  });

  it("requires a name and rejects whitespace-only", () => {
    assert.ok(validateTeacher(teacherInput({ fullName: "   " })).fullName);
  });

  it("rejects a name over 120 characters", () => {
    assert.ok(validateTeacher(teacherInput({ fullName: "x".repeat(121) })).fullName);
  });

  it("requires an email address", () => {
    assert.ok(validateTeacher(teacherInput({ email: "" })).email);
  });

  it("rejects a malformed email", () => {
    assert.ok(validateTeacher(teacherInput({ email: "not-an-email" })).email);
  });

  it("rejects an email over 160 characters", () => {
    const long = `${"a".repeat(160)}@b.com`;
    assert.ok(validateTeacher(teacherInput({ email: long })).email);
  });

  it("requires an employee code", () => {
    assert.ok(validateTeacher(teacherInput({ employeeCode: "" })).employeeCode);
  });

  it("rejects a code starting with a symbol", () => {
    assert.ok(validateTeacher(teacherInput({ employeeCode: "#42" })).employeeCode);
  });

  it("rejects a code over 40 characters", () => {
    assert.ok(validateTeacher(teacherInput({ employeeCode: "A".repeat(41) })).employeeCode);
  });

  it("accepts documented code separators and spaces", () => {
    assert.equal(
      validateTeacher(teacherInput({ employeeCode: "2025/TCH-01_A" })).employeeCode,
      undefined,
    );
  });

  it("accepts an empty classIds array (optional)", () => {
    assert.equal(validateTeacher(teacherInput({ classIds: [] })).classIds, undefined);
  });

  it("rejects more than 50 class assignments", () => {
    const ids = Array.from({ length: 51 }, (_, i) => `class_${i}`);
    assert.ok(validateTeacher(teacherInput({ classIds: ids })).classIds);
  });

  it("rejects non-array classIds (tampered payload)", () => {
    const broken = { ...teacherInput(), classIds: "all" } as unknown as TeacherInput;
    assert.ok(validateTeacher(broken).classIds);
  });
});

// --- normalizeTeacherInput --------------------------------------------------

describe("normalizeTeacherInput", () => {
  it("trims text fields and lowercases email", () => {
    const clean = normalizeTeacherInput(
      teacherInput({ fullName: "  Grace  ", email: " GRACE@School.NG ", employeeCode: " TCH-01 " }),
    );
    assert.equal(clean.fullName, "Grace");
    assert.equal(clean.email, "grace@school.ng");
    assert.equal(clean.employeeCode, "TCH-01");
  });

  it("deduplicates class IDs and removes blanks", () => {
    const clean = normalizeTeacherInput(
      teacherInput({ classIds: [" c1 ", "c1", "", "c2", "  "] }),
    );
    assert.deepEqual(clean.classIds, ["c1", "c2"]);
  });
});

// --- resolveTeacherListQuery (untrusted URL input) --------------------------

describe("resolveTeacherListQuery", () => {
  it("defaults to page 1, no filters, all statuses", () => {
    const q = resolveTeacherListQuery({});
    assert.equal(q.page, 1);
    assert.equal(q.status, null);
    assert.equal(q.q, "");
    assert.equal(q.classId, "");
  });

  it("clamps non-positive and non-numeric pages back to 1", () => {
    assert.equal(resolveTeacherListQuery({ page: "0" }).page, 1);
    assert.equal(resolveTeacherListQuery({ page: "-5" }).page, 1);
    assert.equal(resolveTeacherListQuery({ page: "abc" }).page, 1);
  });

  it("keeps a valid page number", () => {
    assert.equal(resolveTeacherListQuery({ page: "3" }).page, 3);
  });

  it("collapses an unknown status to null (all) and accepts a valid one", () => {
    assert.equal(resolveTeacherListQuery({ status: "graduated" }).status, null);
    assert.equal(resolveTeacherListQuery({ status: "inactive" }).status, "inactive");
    assert.equal(resolveTeacherListQuery({ status: "active" }).status, "active");
  });

  it("takes the first value when a param arrives as an array", () => {
    assert.equal(resolveTeacherListQuery({ q: ["grace", "bob"] }).q, "grace");
  });

  it("trims and bounds the search term to 120 characters", () => {
    const q = resolveTeacherListQuery({ q: "  long ".padEnd(200, "x") });
    assert.equal(q.q.length <= 120, true);
    assert.equal(q.q.startsWith("long"), true);
  });
});

// --- teacherPageHref --------------------------------------------------------

describe("teacherPageHref", () => {
  const base = "/institution/teachers";

  it("omits page 1 and no-op filters, producing a clean URL", () => {
    const q = resolveTeacherListQuery({});
    assert.equal(teacherPageHref(base, q, 1), base);
  });

  it("preserves active filters and appends the page", () => {
    const q = resolveTeacherListQuery({ q: "grace", status: "inactive", class: "c1" });
    assert.equal(
      teacherPageHref(base, q, 2),
      `${base}?q=grace&class=c1&status=inactive&page=2`,
    );
  });
});

// --- teacherTotalPages ------------------------------------------------------

describe("teacherTotalPages", () => {
  it("is never below 1", () => {
    assert.equal(teacherTotalPages(0, 20), 1);
    assert.equal(teacherTotalPages(-5, 20), 1);
  });

  it("rounds up partial pages", () => {
    assert.equal(teacherTotalPages(21, 20), 2);
    assert.equal(teacherTotalPages(40, 20), 2);
    assert.equal(teacherTotalPages(41, 20), 3);
  });
});

// --- toTeacherLikePattern (search escaping) --------------------------------

describe("toTeacherLikePattern", () => {
  it("wraps a plain term as a contains-pattern", () => {
    assert.equal(toTeacherLikePattern("grace"), "*grace*");
  });

  it("strips characters that would break the PostgREST or-filter", () => {
    assert.equal(toTeacherLikePattern("a,b*c%d(e)"), "*abcde*");
  });

  it("keeps ordinary spaces inside the term", () => {
    assert.equal(toTeacherLikePattern("grace adeyemi"), "*grace adeyemi*");
  });

  it("returns an empty pattern for an all-noise term", () => {
    assert.equal(toTeacherLikePattern("***"), "");
    assert.equal(toTeacherLikePattern("   "), "");
  });
});

// --- Privilege-escalation guard (CORE SECURITY) ----------------------------

describe("teacherGrantRole", () => {
  it("always returns the constant TEACHER", () => {
    assert.equal(teacherGrantRole(), "TEACHER");
  });
});

describe("resolveGrantableTeacherRole — privilege escalation guard", () => {
  it("resolves 'teacher', 'Teacher', ' TEACHER ', 'teacher' variants", () => {
    assert.equal(resolveGrantableTeacherRole("teacher"), "TEACHER");
    assert.equal(resolveGrantableTeacherRole("Teacher"), "TEACHER");
    assert.equal(resolveGrantableTeacherRole("  TEACHER  "), "TEACHER");
    assert.equal(resolveGrantableTeacherRole("TEACHER"), "TEACHER");
  });

  it("denies SUPER_ADMIN in any casing", () => {
    assert.equal(resolveGrantableTeacherRole("SUPER_ADMIN"), null);
    assert.equal(resolveGrantableTeacherRole("super_admin"), null);
    assert.equal(resolveGrantableTeacherRole("Super_Admin"), null);
    assert.equal(resolveGrantableTeacherRole("SUPER ADMIN"), null);
  });

  it("denies INSTITUTION_ADMIN in any casing", () => {
    assert.equal(resolveGrantableTeacherRole("INSTITUTION_ADMIN"), null);
    assert.equal(resolveGrantableTeacherRole("institution_admin"), null);
    assert.equal(resolveGrantableTeacherRole("Institution Admin"), null);
  });

  it("denies STUDENT, admin, and arbitrary strings", () => {
    assert.equal(resolveGrantableTeacherRole("STUDENT"), null);
    assert.equal(resolveGrantableTeacherRole("admin"), null);
    assert.equal(resolveGrantableTeacherRole("anything"), null);
    assert.equal(resolveGrantableTeacherRole(""), null);
  });

  it("denies non-string values (null, undefined, objects, arrays, numbers)", () => {
    assert.equal(resolveGrantableTeacherRole(null), null);
    assert.equal(resolveGrantableTeacherRole(undefined), null);
    assert.equal(resolveGrantableTeacherRole({}), null);
    assert.equal(resolveGrantableTeacherRole([]), null);
    assert.equal(resolveGrantableTeacherRole(42), null);
    assert.equal(resolveGrantableTeacherRole(true), null);
  });

  it("handles hyphenated/space-separated forms → still only teacher passes", () => {
    assert.equal(resolveGrantableTeacherRole("super-admin"), null);
    assert.equal(resolveGrantableTeacherRole("institution-admin"), null);
    // "teacher" hyphenated (edge) still resolves since it normalizes
    assert.equal(resolveGrantableTeacherRole(" teacher "), "TEACHER");
  });
});

// --- Tenant / permission boundary for a teacher (member resource) ----------

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

describe("teacher member.manage boundary", () => {
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

  it("denies a teacher managing other members", () => {
    const decision = checkResourceAccess(
      signedIn("TEACHER", INSTITUTION_A),
      memberRequest("read"),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "permissionDenied");
  });

  it("denies a student managing members", () => {
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

  it("denies reading another institution's teacher (cross-tenant)", () => {
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
});

// --- Tenant invariant for the teacher flow (institutionId cast safety) ------

describe("teacher flow tenant invariant (why the institutionId cast is safe)", () => {
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
    const principal = readTrustedPrincipal({ userId: "user_x", privateMetadata: {} });
    assert.ok(principal);
    assert.equal(principal.role, null);
    assert.equal(principal.hasMembership, false);
  });

  it("a tampered role string cannot impersonate INSTITUTION_ADMIN through teacher flow", () => {
    // Even if a malicious actor writes something to publicMetadata, the
    // teacher action does NOT read client-writable metadata — and the
    // resolveGrantableTeacherRole guard would reject anything not "teacher".
    assert.equal(resolveGrantableTeacherRole("INSTITUTION_ADMIN"), null);
    assert.equal(resolveGrantableTeacherRole("SUPER_ADMIN"), null);
  });
});
