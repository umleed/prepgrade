/**
 * Subjects & topics tests — prompt 14.
 *
 * Two classes of coverage, both on pure code the app actually runs:
 *   1. validation + archive policy + origin/writability + list-query safety
 *      (lib/subjects.ts) — the same functions the browser forms and the server
 *      actions share.
 *   2. the subject.manage permission + tenant boundary the flows rely on. NOTE
 *      ON WHAT THE FLOW CALLS: the subject/topic pages and server actions
 *      authorize with `requireRole(["INSTITUTION_ADMIN"])` and scope every
 *      query by the trusted `principal.institutionId`; the finer
 *      `checkResourceAccess()` engine (subject.manage) is exercised here as the
 *      reference boundary, and the platform-read-only rule lives in the pure
 *      `isCatalogueRowWritable` guard the data layer applies on every write
 *      (AGENTS.md §5, §6).
 *
 * The Supabase data layer itself is NOT exercised here — there is no live DB in
 * `npm test`. Its guarantees (constraints, per-scope name uniqueness, the
 * one-level depth trigger, cross-tenant id handling, deployed RLS) are covered
 * by the runnable SQL harness in supabase/tests/, which needs a real database.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isCatalogueItemSelectable,
  isCatalogueRowWritable,
  normalizeSubjectCode,
  normalizeSubjectInput,
  normalizeTopicInput,
  originOf,
  resolveSubjectListQuery,
  subjectArchiveBlocked,
  subjectPageHref,
  topicArchiveBlocked,
  validateSubject,
  validateSubjectCode,
  validateTopic,
  type SubjectInput,
  type TopicInput,
} from "../../lib/subjects.ts";
import type { AccessSubject } from "../../lib/auth/access.ts";
import { decideAccess } from "../../lib/auth/access.ts";
import type { AuthPrincipal } from "../../lib/auth/principal.ts";
import { readTrustedPrincipal } from "../../lib/auth/principal.ts";
import { hasPermission } from "../../lib/auth/permissions.ts";
import type { UserRole } from "../../lib/auth/roles.ts";
import {
  checkResourceAccess,
  type ResourceAccessRequest,
  type ResourceDescriptor,
} from "../../lib/auth/resource-access.ts";

const INSTITUTION_A = "inst_1111aaaa";
const INSTITUTION_B = "inst_2222bbbb";

function subjectInput(overrides: Partial<SubjectInput> = {}): SubjectInput {
  return { name: "Mathematics", code: "MTH", categoryIds: [], ...overrides };
}

function topicInput(overrides: Partial<TopicInput> = {}): TopicInput {
  return { subjectId: "subj-1", name: "Algebra", parentId: "", ...overrides };
}

// --- Subject validation ------------------------------------------------------

describe("validateSubject", () => {
  it("accepts a plain subject with no code or categories", () => {
    assert.deepEqual(validateSubject(subjectInput({ code: "" })), {});
  });

  it("surfaces a bad name on the name field", () => {
    assert.ok(validateSubject(subjectInput({ name: "  " })).name);
    assert.ok(validateSubject(subjectInput({ name: "Maths!" })).name);
  });

  it("rejects a non-array categoryIds payload", () => {
    const errors = validateSubject(
      subjectInput({ categoryIds: "cat-1" as unknown as string[] }),
    );
    assert.ok(errors.categoryIds);
  });

  it("rejects category ids outside the authoritative list when one is given", () => {
    assert.deepEqual(
      validateSubject(subjectInput({ categoryIds: ["cat-1"] }), ["cat-1", "cat-2"]),
      {},
    );
    const errors = validateSubject(
      subjectInput({ categoryIds: ["cat-9"] }),
      ["cat-1", "cat-2"],
    );
    assert.ok(errors.categoryIds);
  });

  it("ignores empty-string category ids (the 'none selected' marker)", () => {
    assert.deepEqual(validateSubject(subjectInput({ categoryIds: [""] }), []), {});
  });
});

describe("validateSubjectCode + normalizeSubjectCode", () => {
  it("treats the code as optional", () => {
    assert.equal(validateSubjectCode(""), null);
    assert.equal(validateSubjectCode("   "), null);
  });

  it("accepts conventional short codes", () => {
    assert.equal(validateSubjectCode("MTH"), null);
    assert.equal(validateSubjectCode("SS-SCI"), null);
  });

  it("rejects over-long, symbol-led, and multi-line codes", () => {
    assert.ok(validateSubjectCode("X".repeat(13)));
    assert.ok(validateSubjectCode("#MTH"));
    assert.ok(validateSubjectCode("M\nTH"));
  });

  it("uppercases and trims before persisting", () => {
    assert.equal(normalizeSubjectCode("  mth "), "MTH");
  });
});

describe("normalizeSubjectInput", () => {
  it("trims, dedupes, and drops empty category ids", () => {
    const clean = normalizeSubjectInput(
      subjectInput({ name: "  Mathematics ", categoryIds: ["c1", "", "c1", "c2"] }),
    );
    assert.equal(clean.name, "Mathematics");
    assert.deepEqual(clean.categoryIds, ["c1", "c2"]);
  });
});

// --- Topic validation ----------------------------------------------------------

describe("validateTopic", () => {
  it("accepts a top-level topic", () => {
    assert.deepEqual(validateTopic(topicInput()), {});
  });

  it("surfaces a bad name on the name field", () => {
    assert.ok(validateTopic(topicInput({ name: "" })).name);
  });

  it("requires a subject id", () => {
    assert.ok(validateTopic(topicInput({ subjectId: "  " })).subjectId);
  });

  it("rejects a topic parented to its own subject id (structural sanity)", () => {
    // The real depth rule needs the DB and lives in the data layer + a trigger;
    // this only pins the payload-level guard.
    assert.ok(validateTopic(topicInput({ parentId: "subj-1" })).parentId);
  });
});

describe("normalizeTopicInput", () => {
  it("trims all three fields", () => {
    const clean = normalizeTopicInput(
      topicInput({ subjectId: " s1 ", name: " Algebra ", parentId: " p1 " }),
    );
    assert.deepEqual(clean, { subjectId: "s1", name: "Algebra", parentId: "p1" });
  });
});

// --- Origin + writability (platform catalogue is read-only for tenants) --------

describe("originOf / isCatalogueRowWritable", () => {
  it("classifies a null-tenant row as platform content", () => {
    assert.equal(originOf({ institutionId: null }), "platform");
    assert.equal(originOf({ institutionId: INSTITUTION_A }), "institution");
  });

  it("never lets a tenant write platform content", () => {
    assert.equal(isCatalogueRowWritable(INSTITUTION_A, { institutionId: null }), false);
  });

  it("never lets a tenant write another tenant's row", () => {
    assert.equal(isCatalogueRowWritable(INSTITUTION_A, { institutionId: INSTITUTION_B }), false);
  });

  it("lets a tenant write its own row", () => {
    assert.equal(isCatalogueRowWritable(INSTITUTION_A, { institutionId: INSTITUTION_A }), true);
  });
});

// --- Archive + lifecycle policy (AGENTS.md §6) ---------------------------------

describe("subjectArchiveBlocked", () => {
  it("allows archiving once no active topics remain", () => {
    assert.equal(subjectArchiveBlocked({ activeTopics: 0 }), null);
  });

  it("blocks archiving while active topics are attached", () => {
    const blocked = subjectArchiveBlocked({ activeTopics: 2 });
    assert.ok(blocked);
    assert.equal(blocked?.reason, "topicsAttached");
    assert.match(blocked?.message, /2 active topics/);
  });
});

describe("topicArchiveBlocked", () => {
  it("allows archiving once no active subtopics remain", () => {
    assert.equal(topicArchiveBlocked({ activeChildTopics: 0 }), null);
  });

  it("blocks archiving while active subtopics are attached", () => {
    const blocked = topicArchiveBlocked({ activeChildTopics: 1 });
    assert.ok(blocked);
    assert.equal(blocked?.reason, "subtopicsAttached");
  });
});

describe("isCatalogueItemSelectable", () => {
  it("only offers active rows to pickers; anything else fails closed", () => {
    assert.equal(isCatalogueItemSelectable("active"), true);
    assert.equal(isCatalogueItemSelectable("archived"), false);
    assert.equal(isCatalogueItemSelectable(""), false);
    assert.equal(isCatalogueItemSelectable("unknown"), false);
  });
});

// --- List query resolution (search / filter / pagination safety) ---------------

describe("resolveSubjectListQuery", () => {
  it("defaults to an unfiltered first page", () => {
    const query = resolveSubjectListQuery({});
    assert.deepEqual(query, {
      q: "",
      categoryId: "",
      status: null,
      origin: null,
      page: 1,
      pageSize: 20,
    });
  });

  it("clamps hostile or stale values from the URL", () => {
    const query = resolveSubjectListQuery({
      q: "  maths  ",
      category: "cat-1",
      status: "deleted",
      origin: "PLATFORM",
      page: "-4",
    });
    assert.equal(query.q, "maths");
    assert.equal(query.categoryId, "cat-1");
    assert.equal(query.status, null); // unknown status → all
    assert.equal(query.origin, null); // wrong case is not a known origin
    assert.equal(query.page, 1);
  });

  it("narrows to a known status and origin", () => {
    const query = resolveSubjectListQuery({ status: "archived", origin: "institution" });
    assert.equal(query.status, "archived");
    assert.equal(query.origin, "institution");
  });

  it("length-bounds the search term", () => {
    const query = resolveSubjectListQuery({ q: "x".repeat(500) });
    assert.equal(query.q.length, 120);
  });

  it("takes the first value of repeated params", () => {
    assert.equal(resolveSubjectListQuery({ page: ["3", "9"] }).page, 3);
  });
});

describe("subjectPageHref", () => {
  it("omits filters and page 1 from the URL", () => {
    const query = resolveSubjectListQuery({});
    assert.equal(subjectPageHref("/institution/subjects", query, 1), "/institution/subjects");
  });

  it("preserves every active filter across pages", () => {
    const query = resolveSubjectListQuery({
      q: "math",
      category: "cat-1",
      status: "active",
      origin: "platform",
    });
    assert.equal(
      subjectPageHref("/institution/subjects", query, 2),
      "/institution/subjects?q=math&category=cat-1&status=active&origin=platform&page=2",
    );
  });
});

// --- Permission catalog wiring ---------------------------------------------------

describe("subject.manage catalog entry", () => {
  it("is held by institution admins only, never by teachers/students/super-admin", () => {
    assert.equal(hasPermission("INSTITUTION_ADMIN", "subject.manage"), true);
    assert.equal(hasPermission("TEACHER", "subject.manage"), false);
    assert.equal(hasPermission("STUDENT", "subject.manage"), false);
    assert.equal(hasPermission("SUPER_ADMIN", "subject.manage"), false);
    assert.equal(hasPermission(null, "subject.manage"), false);
  });
});

// --- Tenant boundary via the resource engine --------------------------------

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

function subjectRequest(
  permission: ResourceAccessRequest["permission"],
  operation: ResourceAccessRequest["operation"],
  overrides: Partial<ResourceDescriptor> = {},
): ResourceAccessRequest {
  return {
    permission,
    operation,
    resource: { kind: "subject", institutionId: INSTITUTION_A, ...overrides },
  };
}

describe("subject.manage boundary", () => {
  it("grants an institution admin read/update in their own tenant", () => {
    assert.equal(
      checkResourceAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), subjectRequest("subject.manage", "read")).allowed,
      true,
    );
    assert.equal(
      checkResourceAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), subjectRequest("subject.manage", "update")).allowed,
      true,
    );
  });

  it("denies a teacher managing the catalogue", () => {
    const decision = checkResourceAccess(
      signedIn("TEACHER", INSTITUTION_A),
      subjectRequest("subject.manage", "update"),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "permissionDenied");
  });

  it("denies a student the catalogue entirely", () => {
    const decision = checkResourceAccess(
      signedIn("STUDENT", INSTITUTION_A),
      subjectRequest("subject.manage", "read"),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "permissionDenied");
  });

  it("denies acting on another institution's subject (cross-tenant)", () => {
    const decision = checkResourceAccess(
      signedIn("INSTITUTION_ADMIN", INSTITUTION_A),
      subjectRequest("subject.manage", "update", { institutionId: INSTITUTION_B }),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "tenantMismatch");
  });
});

// --- The tenant invariant the subject/topic actions rely on ---------------------
// Every subject/topic page and action does `principal.institutionId as string`
// after `requireRole(["INSTITUTION_ADMIN"])`. That cast is only sound because an
// INSTITUTION_ADMIN with no usable tenant can NEVER be authorized. These tests
// pin that guarantee so the data layer never scopes to `null`.
describe("subject flow tenant invariant (why the institutionId cast is safe)", () => {
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
