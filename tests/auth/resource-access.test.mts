/**
 * Resource-level access tests — prompt 09's four attack classes, run through
 * the same `checkResourceAccess()` the guards call server-side:
 *
 *   1. cross-institution reads/writes
 *   2. role escalation (including the full client-tampering chain)
 *   3. ID tampering (record ids, tenant ids, owner ids)
 *   4. unauthorised answer-key access
 *
 * Every `ResourceDescriptor` here is shaped the way production must shape it:
 * built from a server-side read of the record, never from a request payload.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AccessSubject } from "../../lib/auth/access.ts";
import type { AuthPrincipal } from "../../lib/auth/principal.ts";
import { readTrustedPrincipal } from "../../lib/auth/principal.ts";
import type { UserRole } from "../../lib/auth/roles.ts";
import {
  ANSWER_KEY_FIELDS,
  canViewAnswerKey,
  checkResourceAccess,
  describeActor,
  redactRestrictedFields,
  type ResourceAccessRequest,
  type ResourceDescriptor,
} from "../../lib/auth/resource-access.ts";
import type { Permission, ResourceOperation } from "../../lib/auth/permissions.ts";

const INSTITUTION_A = "inst_1111aaaa";
const INSTITUTION_B = "inst_2222bbbb";

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
  userId = "user_1",
): AccessSubject {
  return { session: "active", principal: member(role, institutionId, userId) };
}

/** Shorthand for a request against a record in the caller's own tenant. */
function request(
  permission: Permission,
  operation: ResourceOperation,
  overrides: Partial<ResourceDescriptor> = {},
): ResourceAccessRequest {
  return {
    permission,
    operation,
    resource: { kind: "exam", institutionId: INSTITUTION_A, ...overrides },
  };
}

/** Assert denial and return the reason. */
function denialReason(subject: AccessSubject, req: ResourceAccessRequest) {
  const decision = checkResourceAccess(subject, req);
  if (decision.allowed) {
    assert.fail(
      `expected denial but access was granted to ${decision.principal.role ?? "unassigned"}`,
    );
  }
  return decision;
}

describe("session and membership come first", () => {
  it("denies an anonymous request before any resource fact is consulted", () => {
    const decision = denialReason(
      { session: "anonymous", principal: null },
      request("exam.manage", "update", { institutionId: INSTITUTION_B }),
    );
    assert.equal(decision.reason, "signedOut");
    assert.equal(decision.principal, null);
  });

  it("denies a signed-in account with no membership", () => {
    const decision = denialReason(signedIn(null, null), request("exam.manage", "read"));
    assert.equal(decision.reason, "noMembership");
  });
});

describe("cross-institution reads and writes", () => {
  it("denies a teacher reading another institution's exam", () => {
    const decision = denialReason(
      signedIn("TEACHER", INSTITUTION_A),
      request("exam.read_assigned", "read", { institutionId: INSTITUTION_B }),
    );
    assert.equal(decision.reason, "tenantMismatch");
  });

  it("denies an institution admin writing another institution's question", () => {
    const decision = denialReason(
      signedIn("INSTITUTION_ADMIN", INSTITUTION_A),
      request("question.manage", "update", {
        institutionId: INSTITUTION_B,
        kind: "question",
      }),
    );
    assert.equal(decision.reason, "tenantMismatch");
  });

  it("grants the same operation against the caller's own tenant", () => {
    const decision = checkResourceAccess(
      signedIn("TEACHER", INSTITUTION_A),
      request("question.manage", "update", { kind: "question" }),
    );
    assert.equal(decision.allowed, true);
  });

  it("keeps SUPER_ADMIN out of tenant records — no silent bypass", () => {
    // Platform rights are not tenant rights (AGENTS.md §5). A super admin
    // reaching tenant data must go through an audited platform screen, and
    // this engine is not that screen.
    const decision = denialReason(
      signedIn("SUPER_ADMIN", null),
      request("member.manage", "read"),
    );
    assert.equal(decision.reason, "permissionDenied");
  });
});

describe("role escalation", () => {
  it("denies a student asking to manage members of their own school", () => {
    const decision = denialReason(
      signedIn("STUDENT", INSTITUTION_A),
      request("member.manage", "update", { kind: "member" }),
    );
    assert.equal(decision.reason, "permissionDenied");
  });

  it("denies a teacher publishing outside their granted permissions", () => {
    // `analytics.read_institution` is admin-only even inside the correct tenant.
    const decision = denialReason(
      signedIn("TEACHER", INSTITUTION_A),
      request("analytics.read_institution", "read", { kind: "analytics" }),
    );
    assert.equal(decision.reason, "permissionDenied");
  });

  it("runs the full tamper chain: client-written role claim → no principal role → denial", () => {
    // The strongest escalation available pre-08: a hostile browser writes
    // role/institution claims into `unsafeMetadata` (the channel it CAN write)
    // and calls a sensitive endpoint. The principal reader only consults
    // `privateMetadata`, so the claim never lands; the engine then fails on
    // membership before the permission is even considered.
    const hostile = readTrustedPrincipal({
      userId: "user_student",
      privateMetadata: null, // what the attacker's unsafeMetadata resolves to here
    });
    assert.ok(hostile);
    assert.equal(hostile.role, null);

    const decision = denialReason(
      { session: "active", principal: hostile },
      request("exam.manage", "update"),
    );
    assert.equal(decision.reason, "noMembership");
  });

  it("denies delete to teachers even though they hold the manage permission", () => {
    // Operation-level rule: destructive deletes are admin-only.
    const decision = denialReason(
      signedIn("TEACHER", INSTITUTION_A),
      request("question.manage", "delete", { kind: "question" }),
    );
    assert.equal(decision.reason, "permissionDenied");

    const admin = checkResourceAccess(
      signedIn("INSTITUTION_ADMIN", INSTITUTION_A),
      request("question.manage", "delete", { kind: "question" }),
    );
    assert.equal(admin.allowed, true);
  });
});

describe("ID tampering on owned rows", () => {
  // A student swapping ids in a URL/body to reach another account's rows.

  it("grants a student their own result", () => {
    const decision = checkResourceAccess(
      signedIn("STUDENT", INSTITUTION_A, "user_me"),
      request("result.read_own", "read", {
        kind: "result",
        ownerId: "user_me",
        requiresOwner: true,
      }),
    );
    assert.equal(decision.allowed, true);
  });

  it("denies a student opening another student's result by tampered id", () => {
    const decision = denialReason(
      signedIn("STUDENT", INSTITUTION_A, "user_me"),
      request("result.read_own", "read", {
        kind: "result",
        ownerId: "user_classmate",
        requiresOwner: true,
      }),
    );
    assert.equal(decision.reason, "ownerMismatch");
  });

  it("denies a tampered attempt id even when the tenant matches", () => {
    const decision = denialReason(
      signedIn("STUDENT", INSTITUTION_A, "user_me"),
      request("result.read_own", "read", {
        kind: "attempt",
        ownerId: null,
        requiresOwner: true,
      }),
    );
    assert.equal(decision.reason, "ownerMismatch");
  });

  it("applies ownership before the class-scope rule, denying on the tightest ground", () => {
    const decision = denialReason(
      signedIn("STUDENT", INSTITUTION_A, "user_me"),
      request("analytics.read_own", "read", {
        kind: "analytics",
        ownerId: "user_other",
        requiresOwner: true,
        classId: "class_1",
      }),
    );
    assert.equal(decision.reason, "ownerMismatch");
  });
});

describe("teacher class scope", () => {
  it("grants work inside an assigned class", () => {
    const decision = checkResourceAccess(
      signedIn("TEACHER", INSTITUTION_A),
      {
        ...request("result.read_class", "read", { kind: "result", classId: "class_1" }),
        callerScope: { teachingClassIds: ["class_1", "class_2"] },
      },
    );
    assert.equal(decision.allowed, true);
  });

  it("denies work in a class the teacher isn't assigned to", () => {
    const decision = denialReason(
      signedIn("TEACHER", INSTITUTION_A),
      {
        ...request("exam.manage", "update", { kind: "exam", classId: "class_9" }),
        callerScope: { teachingClassIds: ["class_1"] },
      },
    );
    assert.equal(decision.reason, "scopeMismatch");
  });

  it("fails closed when no scope has been resolved yet", () => {
    // Before prompt 13 lands assignments, `teachingClassIds` is absent — which
    // must mean "teaches nothing", never "scope check skipped".
    const decision = denialReason(
      signedIn("TEACHER", INSTITUTION_A),
      request("result.read_class", "read", { kind: "result", classId: "class_1" }),
    );
    assert.equal(decision.reason, "scopeMismatch");
  });

  it("does not scope institution admins to assigned classes — they hold the tenant", () => {
    const decision = checkResourceAccess(
      signedIn("INSTITUTION_ADMIN", INSTITUTION_A),
      request("analytics.read_class", "read", { kind: "analytics", classId: "class_9" }),
    );
    assert.equal(decision.allowed, true);
  });
});

describe("answer-key access", () => {
  const question = (released: boolean) => ({
    kind: "question" as const,
    institutionId: INSTITUTION_A,
    answerKeyReleased: released,
  });

  it("never lets a student view the key, released or not", () => {
    assert.equal(
      canViewAnswerKey(member("STUDENT", INSTITUTION_A), question(true)),
      false,
    );
    assert.equal(
      canViewAnswerKey(member("STUDENT", INSTITUTION_A), question(false)),
      false,
    );
  });

  it("denies an unassigned account the key", () => {
    assert.equal(
      canViewAnswerKey(member(null, null), question(true)),
      false,
    );
  });

  it("withholds the key from staff until it is released server-side", () => {
    assert.equal(
      canViewAnswerKey(member("TEACHER", INSTITUTION_A), question(false)),
      false,
    );
    assert.equal(
      canViewAnswerKey(member("INSTITUTION_ADMIN", INSTITUTION_A), question(true)),
      true,
    );
  });

  it("redacts every key field from a student-facing payload", () => {
    const record = {
      id: "q_1",
      prompt: "What is 2 + 2?",
      options: ["1", "2", "3", "4"],
      answerKey: "B",
      correctOptionIndex: 1,
      isCorrect: true,
      solution: "Basic addition.",
    };

    const redacted = redactRestrictedFields(
      record,
      member("STUDENT", INSTITUTION_A),
      question(false),
    );

    for (const field of ANSWER_KEY_FIELDS) {
      assert.ok(!(field in redacted), `${field} must be stripped`);
    }
    // Non-sensitive content survives — redaction is surgical, not blanket.
    assert.equal(redacted.prompt, record.prompt);
    assert.deepEqual(redacted.options, record.options);
  });

  it("keeps the payload redacted even before an admin views a released record", () => {
    // The student path is redacted regardless of release; a released record
    // only unlocks staff readers.
    const studentView = redactRestrictedFields(
      { answerKey: "B", prompt: "Q" },
      member("STUDENT", INSTITUTION_A),
      question(true),
    );
    assert.ok(!("answerKey" in studentView));

    const staffView = redactRestrictedFields(
      { answerKey: "B", prompt: "Q" },
      member("TEACHER", INSTITUTION_A),
      question(true),
    );
    assert.equal(staffView.answerKey, "B");
  });

  it("denies the answer-key permission to a student through the engine too", () => {
    // Defence in depth: even if a screen forgot `redactRestrictedFields`, the
    // permission check itself refuses.
    const decision = denialReason(
      signedIn("STUDENT", INSTITUTION_A),
      request("question.read_answer_key", "read", { kind: "question" }),
    );
    assert.equal(decision.reason, "permissionDenied");
  });
});

describe("platform-scoped records", () => {
  it("grants SUPER_ADMIN a platform audit read (no tenant on the record)", () => {
    const decision = checkResourceAccess(
      signedIn("SUPER_ADMIN", null),
      request("platform.audit", "read", { institutionId: null, kind: "analytics" }),
    );
    assert.equal(decision.allowed, true);
  });

  it("describes the actor for audit logs without the raw user id", () => {
    const line = describeActor(member("TEACHER", INSTITUTION_A, "user_secret_id"));
    assert.match(line, /role=TEACHER/);
    assert.match(line, /tenant=inst_1111aaaa/);
    assert.doesNotMatch(line, /user_secret_id/);
  });
});
