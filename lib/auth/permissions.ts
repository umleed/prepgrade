/**
 * Permission catalog — explicit, named capabilities per role.
 * Pure, dependency-free, and unit-testable (like roles.ts and access.ts).
 *
 * WHY THIS EXISTS (prompt 09)
 * `decideAccess()` answers coarse questions: "is this a teacher?", "is this
 * your institution?". A real request asks sharper ones: "may this account
 * *delete* this *exam*, which belongs to that *class*?" A permission name is
 * the smallest unit that answers it, so rule wording lives once in
 * `ROLE_PERMISSIONS` and every call site asks `hasPermission(role, …)`
 * instead of re-deriving role comparisons ad hoc.
 *
 * ORIGINALITY GUARD — the catalog is a union type, so an unknown string never
 * becomes a permission; `isPermission()` exists to vet values that arrive from
 * outside TypeScript (request payloads, fixtures, future API surfaces).
 *
 * LEAST PRIVILEGE (AGENTS.md §5)
 * - STUDENT holds only own-scope read permissions; the record-level rule in
 *   `resource-access.ts` narrows those further to rows the student owns.
 * - TEACHER holds institution permissions for teaching work, but class-scoped
 *   ones only ever apply to assigned classes (caller scope, prompt 13).
 * - INSTITUTION_ADMIN manages its own tenant only — tenant comparison is
 *   enforced in `resource-access.ts`, never here.
 * - SUPER_ADMIN holds exactly one permission: `platform.audit`. Platform
 *   rights are not tenant rights, so no tenant permission is granted here;
 *   super-admin surfaces (prompts 31/33) read through audited screens only.
 */

import type { UserRole } from "./roles.ts";

export const PERMISSIONS = [
  // Institution membership (prompts 11, 12)
  "member.manage",
  // Classes and academic sessions (prompt 13)
  "class.manage",
  "class.read_assigned",
  // Subject/topic catalogue (prompt 14) — managing institution additions.
  // Selection inside question/exam workflows is covered by question.manage
  // and exam.manage; reading the catalogue needs no grant.
  "subject.manage",
  // Question bank (prompts 15, 16) — the answer key is gated separately by
  // `resource-access.ts`, so holding this never exposes key fields.
  "question.manage",
  "question.read_answer_key",
  // Exams (prompts 17–19)
  "exam.manage",
  "exam.publish",
  "exam.read_assigned",
  "exam.monitor",
  // Results (prompts 25, 42)
  "result.read_own",
  "result.read_class",
  // Analytics (prompts 27, 28)
  "analytics.read_own",
  "analytics.read_class",
  "analytics.read_institution",
  // Platform (prompts 31, 33) — SUPER_ADMIN only.
  "platform.audit",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Operations a resource request can perform. Write is deliberately granular. */
export const RESOURCE_OPERATIONS = ["read", "update", "delete"] as const;

export type ResourceOperation = (typeof RESOURCE_OPERATIONS)[number];

/** Runtime guard for permission strings arriving from any external source. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" &&
    (PERMISSIONS as readonly string[]).includes(value);
}

/** Runtime guard for operation strings arriving from any external source. */
export function isResourceOperation(value: unknown): value is ResourceOperation {
  return typeof value === "string" &&
    (RESOURCE_OPERATIONS as readonly string[]).includes(value);
}

/**
 * Authoritative role → permission matrix. Adding a capability here is the only
 * way a role gains one; nothing in this module reads sessions, tenants, or
 * browser-writable data, so a client cannot widen these sets.
 */
export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  STUDENT: new Set<Permission>([
    "result.read_own",
    "analytics.read_own",
  ]),
  TEACHER: new Set<Permission>([
    "class.read_assigned",
    "question.manage",
    "question.read_answer_key",
    "exam.manage",
    "exam.publish",
    "exam.read_assigned",
    "exam.monitor",
    "result.read_own",
    "result.read_class",
    "analytics.read_class",
  ]),
  INSTITUTION_ADMIN: new Set<Permission>([
    "member.manage",
    "class.manage",
    "class.read_assigned",
    "subject.manage",
    "question.manage",
    "question.read_answer_key",
    "exam.manage",
    "exam.publish",
    "exam.read_assigned",
    "exam.monitor",
    "result.read_own",
    "result.read_class",
    "analytics.read_class",
    "analytics.read_institution",
  ]),
  // Least privilege: exactly one platform permission, zero tenant permissions.
  SUPER_ADMIN: new Set<Permission>(["platform.audit"]),
};

/**
 * Whether a role holds a permission. An unresolved role (`null` — signed in but
 * unassigned) holds nothing; fail closed rather than default-grant.
 */
export function hasPermission(
  role: UserRole | null,
  permission: Permission,
): boolean {
  if (role === null) return false;
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Every permission a role holds, in catalog order (for honest UI/audit lists). */
export function permissionsForRole(role: UserRole | null): Permission[] {
  if (role === null) return [];
  return PERMISSIONS.filter((permission) => ROLE_PERMISSIONS[role].has(permission));
}

/**
 * Plain-language capability wording for denial notices and audit descriptions.
 * Generic enough to render anywhere; it never names a specific record.
 */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "member.manage": "member management",
  "class.manage": "class management",
  "class.read_assigned": "assigned-class access",
  "subject.manage": "subject and topic catalogue",
  "question.manage": "question management",
  "question.read_answer_key": "answer-key access",
  "exam.manage": "exam management",
  "exam.publish": "exam publishing",
  "exam.read_assigned": "assigned-exam access",
  "exam.monitor": "live-exam monitoring",
  "result.read_own": "your own results",
  "result.read_class": "class results",
  "analytics.read_class": "class analytics",
  "analytics.read_institution": "institution analytics",
  "analytics.read_own": "your own analytics",
  "platform.audit": "platform auditing",
};
