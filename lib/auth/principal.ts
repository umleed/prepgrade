/**
 * Trusted principal resolution — pure, dependency-free, and unit-testable.
 *
 * TRUST BOUNDARY (this is the whole point of the module)
 * A PrepGrade role and tenant are read ONLY from server-written data. With the
 * current provider (Clerk) that means `privateMetadata`, which the browser
 * cannot write — it is only settable through the Clerk Backend API with the
 * secret key, or from Clerk Dashboard. `publicMetadata` and `unsafeMetadata`
 * are deliberately NOT consulted: they are client-writable, so trusting them
 * would let a signed-in student promote themselves to INSTITUTION_ADMIN or
 * attach themselves to another school (AGENTS.md §5 — never trust
 * client-supplied permissions or tenant IDs).
 *
 * SWAP PATH (prompt 08): when `profiles` / `institution_memberships` exist,
 * `lib/auth/context.ts` becomes the only file that changes — it will resolve the
 * principal from a database membership row and pass it through the same shape.
 * Page and route-handler call sites keep working because they consume
 * `AuthPrincipal`, never Clerk objects or metadata keys.
 */

import { normalizeUserRole, type UserRole } from "./roles.ts";

/** Metadata keys this application owns. Kept in one place for the writer too. */
export const PRINCIPAL_ROLE_KEY = "role";
export const PRINCIPAL_INSTITUTION_KEY = "institutionId";

/** Anything the caller swears is server-written metadata. */
export type TrustedMetadata = Record<string, unknown> | null | undefined;

export type AuthPrincipal = {
  /** Clerk user id — the only stable identity key available before prompt 08. */
  userId: string;
  /** Resolved role, or `null` when no trusted role has been assigned yet. */
  role: UserRole | null;
  /** Tenant (institution) the membership belongs to, or `null`. */
  institutionId: string | null;
  /**
   * Whether the principal has a usable membership: a known role that is either
   * platform-scoped (SUPER_ADMIN) or attached to an institution.
   */
  hasMembership: boolean;
};

/** Non-empty string or `null`; everything else is treated as absent. */
function readStringId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build a principal from trusted (server-only) metadata.
 *
 * Returns `null` for an anonymous request so callers cannot accidentally read
 * fields off a fake principal. Unknown role strings, blank tenant ids, and
 * malformed metadata all resolve to `null` fields rather than a permissive
 * default — fail closed.
 */
export function readTrustedPrincipal(input: {
  userId: string | null | undefined;
  privateMetadata?: TrustedMetadata;
}): AuthPrincipal | null {
  const userId = readStringId(input.userId);
  if (!userId) return null;

  const metadata =
    input.privateMetadata && typeof input.privateMetadata === "object"
      ? input.privateMetadata
      : null;

  const role = normalizeUserRole(metadata?.[PRINCIPAL_ROLE_KEY]);
  const institutionId = readStringId(
    metadata?.[PRINCIPAL_INSTITUTION_KEY],
  );

  // A platform role needs no tenant; every other role must be attached to one.
  const hasMembership = role !== null && (role === "SUPER_ADMIN" || institutionId !== null);

  return { userId, role, institutionId, hasMembership };
}

/**
 * Explain, for UI copy, which trusted field is missing when a signed-in user has
 * no membership. Never used for authorization — only to word the no-membership
 * state accurately without leaking internals.
 */
export function missingMembershipReason(
  principal: AuthPrincipal,
): "role" | "institution" | "none" {
  if (principal.hasMembership) return "none";
  if (principal.role === null) return "role";
  return "institution";
}
