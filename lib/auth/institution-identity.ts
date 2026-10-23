/**
 * Institution identity resolution — pure, dependency-free, and unit-testable.
 *
 * WHAT THIS DECIDES
 * The sidebar and dashboard must show the institution's REAL name, not the
 * tenant UUID. The name lives in `institutions.name` (migration 0001), keyed by
 * the trusted tenant id on the principal. Before that read is trusted, the
 * membership table (`institution_memberships`, also migration 0001) is
 * cross-checked here: an active `INSTITUTION_ADMIN` row for exactly the
 * principal's tenant confirms the membership.
 *
 * RULES (AGENTS.md §5 — authentication is not authorization)
 * - The tenant id handed to the lookup comes from the SERVER-resolved
 *   `AuthPrincipal` (Clerk privateMetadata today, see lib/auth/context.ts),
 *   never from a URL, query param, or client-writable metadata.
 * - When a user holds several memberships, the ACTIVE workspace is the one that
 *   matches the trusted tenant id. Rows for other institutions are never
 *   selected — not "the first row", not "the newest row".
 * - When the name cannot be resolved, the display is an honest fallback. A
 *   UUID, an email, or a Google display name is never substituted for an
 *   institution name.
 */

import { normalizeUserRole } from "./roles.ts";

/** A raw `institution_memberships` row, normalised to camelCase by the data layer. */
export type AdminMembershipFact = {
  institutionId: string;
  role: unknown;
  status: unknown;
};

/** Membership states the platform recognises; anything else is not active. */
const ACTIVE_MEMBERSHIP_STATUS = "active";

/**
 * From the caller's membership rows, return the one that confirms their
 * trusted tenant membership — the row whose institution equals the
 * server-resolved `trustedInstitutionId`, whose role normalises to
 * `INSTITUTION_ADMIN`, and whose status is `active`.
 *
 * Returns `null` when no such row exists. Rows for OTHER institutions are
 * ignored even if they are the only admin rows present: the trusted tenant is
 * pinned by the principal, so multiple memberships never become a choice.
 */
export function selectTrustedAdminMembership(
  trustedInstitutionId: string | null | undefined,
  rows: readonly AdminMembershipFact[],
): AdminMembershipFact | null {
  const tenant = typeof trustedInstitutionId === "string" ? trustedInstitutionId.trim() : "";
  if (!tenant) return null;

  for (const row of rows) {
    const rowInstitution =
      typeof row.institutionId === "string" ? row.institutionId.trim() : "";
    if (rowInstitution !== tenant) continue;
    if (normalizeUserRole(row.role) !== "INSTITUTION_ADMIN") continue;
    if (row.status !== ACTIVE_MEMBERSHIP_STATUS) continue;
    return row;
  }
  return null;
}

/** Display fallback when the real name could not be resolved. Never an id. */
export const INSTITUTION_NAME_UNAVAILABLE = "Institution name unavailable";

/**
 * The single place user-facing navigation turns an identity lookup into text.
 * A resolved name is trimmed and shown; anything unresolved shows the honest
 * fallback — the tenant UUID is never rendered as a name.
 */
export function institutionDisplayText(name: string | null | undefined): string {
  if (typeof name !== "string") return INSTITUTION_NAME_UNAVAILABLE;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : INSTITUTION_NAME_UNAVAILABLE;
}
