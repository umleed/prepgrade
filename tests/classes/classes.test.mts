/**
 * Classes & academic-sessions tests — prompt 13.
 *
 * Two classes of coverage, both on pure code the app actually runs:
 *   1. validation + archive policy + list-query/pagination safety
 *      (lib/classes.ts) — the same functions the browser forms and the server
 *      actions share.
 *   2. the class permission + tenant/scope boundary the flows rely on. NOTE ON
 *      WHAT THE FLOW CALLS: the class/session pages and server actions authorize
 *      with `requireRole(["INSTITUTION_ADMIN"])` and scope every query by the
 *      trusted `principal.institutionId`; the finer `checkResourceAccess()`
 *      engine (class.manage / class.read_assigned) is exercised here as the
 *      reference boundary, and its tenant rules match what the data layer
 *      enforces (AGENTS.md §5, prompt 09's cross-institution class).
 *
 * The Supabase data layer itself is NOT exercised here — there is no live DB in
 * `npm test`, and unit tests cannot load the `@/`-aliased, network-backed layer.
 * Its guarantees (constraints, cross-tenant session/class id handling, the
 * student_class_history write, deployed RLS) are covered by the runnable SQL
 * harness in supabase/tests/, which needs a real database.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classArchiveBlocked,
  classHistoryTarget,
  classPageHref,
  classRestoreNameConflictMessage,
  isClassAttachable,
  isSessionAttachable,
  looksLikeSessionSpan,
  normalizeClassInput,
  normalizeSessionInput,
  orgTotalPages,
  resolveClassListQuery,
  resolveSessionListQuery,
  sessionPageHref,
  toOrgContainsPattern,
  validateClass,
  validateOrgName,
  validateSession,
  type ClassInput,
  type SessionInput,
} from "../../lib/classes.ts";
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

function classInput(overrides: Partial<ClassInput> = {}): ClassInput {
  return { name: "SS 101", academicSessionId: "", ...overrides };
}

function sessionInput(overrides: Partial<SessionInput> = {}): SessionInput {
  return { name: "2025/2026", ...overrides };
}

// --- Name validation (shared by classes and sessions) -----------------------

describe("validateOrgName", () => {
  it("accepts conventional class and session labels", () => {
    assert.equal(validateOrgName("SS 101"), null);
    assert.equal(validateOrgName("2025/2026"), null);
    assert.equal(validateOrgName("JAMB - WAEC"), null);
    assert.equal(validateOrgName("SS_101.A&B"), null);
  });

  it("rejects empty and whitespace-only names", () => {
    assert.ok(validateOrgName(""));
    assert.ok(validateOrgName("   "));
  });

  it("rejects a name over the 80-character limit", () => {
    assert.ok(validateOrgName("x".repeat(81)));
  });

  it("accepts a name at exactly the limit", () => {
    assert.equal(validateOrgName("x".repeat(80)), null);
  });

  it("rejects line breaks and tabs (single-line labels only)", () => {
    assert.ok(validateOrgName("SS 101\n2026"));
    assert.ok(validateOrgName("SS\t101"));
  });

  it("rejects a name that starts with a symbol", () => {
    assert.ok(validateOrgName("#101"));
  });

  it("rejects disallowed punctuation", () => {
    assert.ok(validateOrgName("SS 101!"));
    assert.ok(validateOrgName("Class@Room"));
  });
});

// --- Class + session input validation ---------------------------------------

describe("validateClass", () => {
  it("accepts a class with no session (assignment optional)", () => {
    assert.deepEqual(validateClass(classInput()), {});
  });

  it("surfaces a bad name on the name field", () => {
    assert.ok(validateClass(classInput({ name: "  " })).name);
  });

  it("rejects a non-string session id", () => {
    const errors = validateClass(
      classInput({ academicSessionId: 42 as unknown as string }),
    );
    assert.ok(errors.academicSessionId);
  });
});

describe("normalizeClassInput", () => {
  it("trims the name and session id", () => {
    const clean = normalizeClassInput(classInput({ name: "  SS 101  ", academicSessionId: " s1 " }));
    assert.equal(clean.name, "SS 101");
    assert.equal(clean.academicSessionId, "s1");
  });
});

describe("validateSession + normalizeSessionInput", () => {
  it("accepts a well-formed session and rejects a blank one", () => {
    assert.deepEqual(validateSession(sessionInput()), {});
    assert.ok(validateSession(sessionInput({ name: "" })).name);
  });

  it("trims the session name", () => {
    assert.equal(normalizeSessionInput(sessionInput({ name: " 2025/2026 " })).name, "2025/2026");
  });
});

describe("looksLikeSessionSpan (advisory only)", () => {
  it("recognises year spans and single years", () => {
    assert.equal(looksLikeSessionSpan("2025/2026"), true);
    assert.equal(looksLikeSessionSpan("2025 - 2026"), true);
    assert.equal(looksLikeSessionSpan("2026"), true);
  });

  it("returns false for non-year names it must never reject", () => {
    assert.equal(looksLikeSessionSpan("Batch A"), false);
    assert.equal(looksLikeSessionSpan("Weekend 2026"), false);
  });
});

// --- Archive policy (AGENTS.md §6) ------------------------------------------

describe("classArchiveBlocked", () => {
  it("allows archiving once no students are attached", () => {
    assert.equal(classArchiveBlocked({ attachedStudents: 0 }), null);
  });

  it("blocks archiving while students remain attached, singular wording", () => {
    const blocked = classArchiveBlocked({ attachedStudents: 1 });
    assert.ok(blocked);
    assert.equal(blocked?.reason, "studentsAttached");
    assert.match(blocked?.message ?? "", /1 student still/);
  });

  it("blocks archiving while students remain attached, plural wording", () => {
    const blocked = classArchiveBlocked({ attachedStudents: 4 });
    assert.match(blocked?.message ?? "", /4 students still/);
  });
});

describe("attachable lifecycle checks (fail closed)", () => {
  it("permits attaching only active classes and sessions", () => {
    assert.equal(isClassAttachable("active"), true);
    assert.equal(isSessionAttachable("active"), true);
  });

  it("refuses archived and unknown statuses", () => {
    assert.equal(isClassAttachable("archived"), false);
    assert.equal(isSessionAttachable("archived"), false);
    assert.equal(isClassAttachable("deleted"), false);
    assert.equal(isSessionAttachable(""), false);
  });
});

// --- Atomic move-history target (mirrors the 0004 DB function) ---------------
// The database records the class a student is LEAVING, atomically with the
// transfer. classHistoryTarget is the pure specification of that rule; these
// cases pin it so the SQL and the app can never drift apart.
describe("classHistoryTarget (which class the history row names)", () => {
  it("records nothing when the class is unchanged", () => {
    assert.equal(classHistoryTarget("class-1", "class-1"), null);
    assert.equal(classHistoryTarget(null, null), null);
  });

  it("records nothing when a previously-unassigned student gains a class", () => {
    // No past class existed to preserve, so there is no history row to write.
    assert.equal(classHistoryTarget(null, "class-2"), null);
  });

  it("records the class being LEFT on a real move between classes", () => {
    assert.equal(classHistoryTarget("class-1", "class-2"), "class-1");
  });

  it("records the class being LEFT when a student becomes unassigned", () => {
    assert.equal(classHistoryTarget("class-1", null), "class-1");
  });
});

// --- Archive / restore name conflict (partial unique index) ------------------
describe("classRestoreNameConflictMessage", () => {
  it("names the clashing class and tells the admin to rename first", () => {
    const message = classRestoreNameConflictMessage("SS 101");
    assert.match(message, /SS 101/);
    assert.match(message, /Rename one of them before restoring/);
  });
});

// --- List query resolution (untrusted URL input) ----------------------------

describe("resolveClassListQuery", () => {
  it("defaults to page 1, no filters, all statuses", () => {
    const q = resolveClassListQuery({});
    assert.equal(q.page, 1);
    assert.equal(q.status, null);
    assert.equal(q.q, "");
    assert.equal(q.sessionId, "");
  });

  it("clamps non-positive and non-numeric pages to 1", () => {
    assert.equal(resolveClassListQuery({ page: "0" }).page, 1);
    assert.equal(resolveClassListQuery({ page: "-3" }).page, 1);
    assert.equal(resolveClassListQuery({ page: "abc" }).page, 1);
  });

  it("collapses an unknown status to 'all' and accepts a valid one", () => {
    assert.equal(resolveClassListQuery({ status: "deleted" }).status, null);
    assert.equal(resolveClassListQuery({ status: "archived" }).status, "archived");
  });

  it("takes the first value when a param arrives as an array", () => {
    assert.equal(resolveClassListQuery({ q: ["ss1", "ss2"] }).q, "ss1");
  });

  it("bounds the search term length", () => {
    const q = resolveClassListQuery({ q: "x".repeat(300) });
    assert.equal(q.q.length <= 120, true);
  });
});

describe("resolveSessionListQuery", () => {
  it("defaults and clamps like the class query", () => {
    const q = resolveSessionListQuery({ page: "2", status: "active" });
    assert.equal(q.page, 2);
    assert.equal(q.status, "active");
  });
});

describe("classPageHref / sessionPageHref", () => {
  const base = "/institution/classes";

  it("omits page 1 and no-op filters, producing a clean URL", () => {
    const q = resolveClassListQuery({});
    assert.equal(classPageHref(base, q, 1), base);
  });

  it("preserves active class filters and appends the page", () => {
    const q = resolveClassListQuery({ q: "ss1", status: "archived", session: "s1" });
    assert.equal(
      classPageHref(base, q, 2),
      `${base}?q=ss1&session=s1&status=archived&page=2`,
    );
  });

  it("builds a session-list URL that carries no session filter", () => {
    const q = resolveSessionListQuery({ q: "2025", status: "active" });
    assert.equal(
      sessionPageHref("/institution/classes/sessions", q, 3),
      "/institution/classes/sessions?q=2025&status=active&page=3",
    );
  });
});

describe("orgTotalPages", () => {
  it("is never below 1", () => {
    assert.equal(orgTotalPages(0, 20), 1);
    assert.equal(orgTotalPages(-5, 20), 1);
  });

  it("rounds up partial pages", () => {
    assert.equal(orgTotalPages(21, 20), 2);
    assert.equal(orgTotalPages(40, 20), 2);
    assert.equal(orgTotalPages(41, 20), 3);
  });
});

describe("toOrgContainsPattern (single-column ilike escaping)", () => {
  it("wraps a plain term in SQL wildcards", () => {
    assert.equal(toOrgContainsPattern("ss1"), "%ss1%");
  });

  it("strips characters that would break the filter syntax", () => {
    assert.equal(toOrgContainsPattern("a,b*c%d(e)"), "%abcde%");
  });

  it("keeps ordinary spaces inside the term", () => {
    assert.equal(toOrgContainsPattern("ss 101"), "%ss 101%");
  });

  it("returns an empty pattern for an all-noise term so callers skip the filter", () => {
    assert.equal(toOrgContainsPattern("***"), "");
    assert.equal(toOrgContainsPattern("   "), "");
  });
});

// --- Tenant / permission boundary for a class -------------------------------

function member(role: UserRole | null, institutionId: string | null): AuthPrincipal {
  return {
    userId: "user_1",
    role,
    institutionId,
    hasMembership: role !== null && (role === "SUPER_ADMIN" || institutionId !== null),
  };
}

function signedIn(role: UserRole | null, institutionId: string | null): AccessSubject {
  return { session: "active", principal: member(role, institutionId) };
}

function classRequest(
  permission: ResourceAccessRequest["permission"],
  operation: ResourceAccessRequest["operation"],
  overrides: Partial<ResourceDescriptor> = {},
  callerScope?: ResourceAccessRequest["callerScope"],
): ResourceAccessRequest {
  return {
    permission,
    operation,
    resource: { kind: "class", institutionId: INSTITUTION_A, ...overrides },
    callerScope,
  };
}

describe("class.manage boundary", () => {
  it("grants an institution admin read/update in their own tenant", () => {
    assert.equal(
      checkResourceAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), classRequest("class.manage", "read")).allowed,
      true,
    );
    assert.equal(
      checkResourceAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), classRequest("class.manage", "update")).allowed,
      true,
    );
  });

  it("denies a teacher the manage permission (they only read assigned)", () => {
    const decision = checkResourceAccess(
      signedIn("TEACHER", INSTITUTION_A),
      classRequest("class.manage", "update"),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "permissionDenied");
  });

  it("denies a student managing classes", () => {
    const decision = checkResourceAccess(
      signedIn("STUDENT", INSTITUTION_A),
      classRequest("class.manage", "read"),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "permissionDenied");
  });

  it("denies a super admin — platform rights are not tenant rights", () => {
    const decision = checkResourceAccess(
      signedIn("SUPER_ADMIN", null),
      classRequest("class.manage", "read"),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "permissionDenied");
  });

  it("denies acting on another institution's class (cross-tenant)", () => {
    const decision = checkResourceAccess(
      signedIn("INSTITUTION_ADMIN", INSTITUTION_A),
      classRequest("class.manage", "read", { institutionId: INSTITUTION_B }),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "tenantMismatch");
  });
});

describe("class.read_assigned teacher scope", () => {
  it("allows a teacher to read a class they are assigned to", () => {
    const decision = checkResourceAccess(
      signedIn("TEACHER", INSTITUTION_A),
      classRequest("class.read_assigned", "read", { classId: "class-1" }, { teachingClassIds: ["class-1", "class-2"] }),
    );
    assert.equal(decision.allowed, true);
  });

  it("denies a class outside the teacher's assigned scope", () => {
    const decision = checkResourceAccess(
      signedIn("TEACHER", INSTITUTION_A),
      classRequest("class.read_assigned", "read", { classId: "class-9" }, { teachingClassIds: ["class-1"] }),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "scopeMismatch");
  });

  it("fails closed when the caller has no recorded teaching scope", () => {
    const decision = checkResourceAccess(
      signedIn("TEACHER", INSTITUTION_A),
      classRequest("class.read_assigned", "read", { classId: "class-1" }),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "scopeMismatch");
  });
});

// --- The tenant invariant the class/session actions & data layer rely on ------
// Every class/session page and action does `principal.institutionId as string`
// after `requireRole(["INSTITUTION_ADMIN"])`. That cast is only sound because an
// INSTITUTION_ADMIN with no usable tenant can NEVER be authorized. These tests
// pin that guarantee so the data layer never scopes to `null`.
describe("class flow tenant invariant (why the institutionId cast is safe)", () => {
  it("an admin with no institution has no membership and is denied", () => {
    const principal = readTrustedPrincipal({
      userId: "user_admin",
      privateMetadata: { role: "INSTITUTION_ADMIN" },
    });
    assert.ok(principal);
    assert.equal(principal.hasMembership, false);

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
});
