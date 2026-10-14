/**
 * Resource-level access engine — pure, dependency-free, unit-testable.
 *
 * Prompt 09's validation chain in one function: for every sensitive request,
 * validate
 *   1. the authenticated user          (session — via `decideAccess`),
 *   2. institution membership          (`hasMembership` — via `decideAccess`),
 *   3. the role                        (permission catalog `hasPermission`),
 *   4. the requested resource          (tenant comparison — cross-institution
 *                                      boundary; `decideAccess` alone cannot
 *                                      see the record),
 *   5. the operation                   (read / update / delete on a permission),
 * plus two integrity rules AGENTS.md §6 adds on top:
 *   6. ownership                       (students only ever reach rows that are
 *                                      their own — assigned exams, attempts,
 *                                      results), and
 *   7. answer-key field policy         (restricted fields are redacted from any
 *                                      record the caller may see, unless the
 *                                      key has been released server-side).
 *
 * TRUST RULE (non-negotiable): every `ResourceDescriptor` field must come from
 * a server-side read of the record being opened — never from a request body,
 * query param, or client metadata. A tampered `institutionId` in a payload is
 * meaningless here because the caller passes the *loaded record's* tenant, and
 * the actor's own tenant comes from the trusted principal.
 *
 * `SUPER_ADMIN` deliberately cannot satisfy tenant permission checks: its one
 * catalog permission (`platform.audit`) is platform-scoped, so reaching tenant
 * data requires audited super-admin screens (prompts 31, 33), not a silent
 * bypass of this engine.
 */

import { decideAccess, type AccessDenial, type AccessSubject } from "./access.ts";
import type { AuthPrincipal } from "./principal.ts";
import type { UserRole } from "./roles.ts";
import { hasPermission, type Permission, type ResourceOperation } from "./permissions.ts";

export type ResourceKind =
  | "member"
  | "class"
  | "subject"
  | "question"
  | "exam"
  | "assignment"
  | "attempt"
  | "result"
  | "analytics";

/**
 * The server-read facts about the record the request targets. Optional fields
 * mean "the record has no such dimension", not "skip the check" — checks only
 * run when the descriptor supplies the field.
 */
export type ResourceDescriptor = {
  kind: ResourceKind;
  /** Tenant that owns the record — read server-side, never from the client. */
  institutionId: string | null;
  /** The user the row belongs to (attempt/result/assignment). */
  ownerId?: string | null;
  /** Only rows belonging to the caller may be opened. */
  requiresOwner?: boolean;
  /** Class the record is tied to, for teacher scope checks. */
  classId?: string | null;
  /** Answer key already released to students for this record. */
  answerKeyReleased?: boolean;
};

/**
 * The caller's own server-read scope. Today only class assignments matter;
 * prompt 13 fills `teachingClassIds` from the schema. An absent list means the
 * caller teaches no classes, so class-scoped requests deny — fail closed.
 */
export type CallerScope = {
  teachingClassIds?: readonly string[];
};

export type ResourceAccessRequest = {
  permission: Permission;
  operation: ResourceOperation;
  resource: ResourceDescriptor;
  callerScope?: CallerScope;
};

export type ResourceAccessDecision =
  | { allowed: true; principal: AuthPrincipal }
  | { allowed: false; reason: AccessDenial; principal: AuthPrincipal | null };

/**
 * Fields that must never leave the server in a student-facing (or any
 * non-released) payload. Name your key columns exactly this so redaction is
 * automatic; anything not listed passes through as-is.
 */
export const ANSWER_KEY_FIELDS = [
  "answerKey",
  "correctAnswer",
  "correctOptionIndex",
  "isCorrect",
  "solution",
] as const;

/** Roles that may ever see answer-key fields — still only once released. */
const ANSWER_KEY_READER_ROLES: readonly UserRole[] = [
  "TEACHER",
  "INSTITUTION_ADMIN",
];

/**
 * Evaluate a resource request for a subject. Order matters and each step fails
 * closed: session/membership first (so an unauthenticated or unassigned caller
 * learns nothing about the record), then the permission grant (role), then the
 * tenant comparison (so a role violation never confirms or denies another
 * institution's data), then the finer-grained integrity checks.
 */
export function checkResourceAccess(
  subject: AccessSubject,
  request: ResourceAccessRequest,
): ResourceAccessDecision {
  // Steps 1–2: session and membership, reusing the single decision engine so
  // page-level and resource-level rules can never drift apart.
  const base = decideAccess(subject, {});
  if (!base.allowed) return base;

  const { principal } = base;

  // Step 3: the role must hold the named permission for this area.
  if (!hasPermission(principal.role, request.permission)) {
    return { allowed: false, reason: "permissionDenied", principal };
  }

  const { resource } = request;

  // Step 4: the record must belong to the caller's institution. SUPER_ADMIN
  // does not bypass here by design — see the module header.
  if (
    resource.institutionId !== null &&
    principal.institutionId !== resource.institutionId
  ) {
    return { allowed: false, reason: "tenantMismatch", principal };
  }

  // Step 6: owned rows are reachable only by their owner (ID tampering against
  // another student's attempt or result is denied here, not hidden in the UI).
  if (resource.requiresOwner && resource.ownerId !== principal.userId) {
    return { allowed: false, reason: "ownerMismatch", principal };
  }

  // Step 7: class-scoped work is limited to the caller's assigned classes for
  // teachers. Institution admins hold `class.manage` institution-wide.
  if (
    principal.role === "TEACHER" &&
    resource.classId !== undefined &&
    resource.classId !== null
  ) {
    const teaching = request.callerScope?.teachingClassIds ?? [];
    if (!teaching.includes(resource.classId)) {
      return { allowed: false, reason: "scopeMismatch", principal };
    }
  }

  // Step 5: delete is the most destructive operation in the MVP catalog and is
  // reserved for institution admins; teachers hold the manage permission for
  // create/update work but must never destroy shared tenant data.
  if (request.operation === "delete" && principal.role !== "INSTITUTION_ADMIN") {
    return { allowed: false, reason: "permissionDenied", principal };
  }

  return { allowed: true, principal };
}

/**
 * Whether the caller may see answer-key fields of a record *they are otherwise
 * allowed to open*. The answer key is released server-side (`answerKeyReleased`
 * on the loaded record) — a student request can never flip that by passing a
 * flag, because descriptors are built from database rows, not payloads.
 */
export function canViewAnswerKey(
  principal: AuthPrincipal,
  resource: Pick<ResourceDescriptor, "answerKeyReleased">,
): boolean {
  if (principal.role === null) return false;
  return (
    ANSWER_KEY_READER_ROLES.includes(principal.role) &&
    resource.answerKeyReleased === true
  );
}

/**
 * Produce a payload-safe copy of a record for this principal. Answer-key
 * fields are stripped unless `canViewAnswerKey` grants them. Returns a new
 * object; the input is never mutated.
 */
export function redactRestrictedFields<T extends Record<string, unknown>>(
  record: T,
  principal: AuthPrincipal,
  resource: Pick<ResourceDescriptor, "answerKeyReleased">,
): Partial<T> {
  if (canViewAnswerKey(principal, resource)) return record;

  const restricted = new Set<string>(ANSWER_KEY_FIELDS);
  const allowed = Object.fromEntries(
    Object.entries(record).filter(([key]) => !restricted.has(key)),
  );
  return allowed as Partial<T>;
}

/**
 * Short, audit-log-safe description of the actor: role and tenant only. It
 * deliberately omits the user id — audit consumers join identities themselves,
 * and log copy must not accumulate raw identifiers beyond what's needed.
 */
export function describeActor(principal: AuthPrincipal): string {
  return `role=${principal.role ?? "unassigned"} tenant=${principal.institutionId ?? "platform"}`;
}
