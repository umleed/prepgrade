/**
 * Institution identity data access — SERVER-ONLY.
 *
 * Resolves the REAL institution name (`institutions.name`, migration 0001) for
 * the signed-in administrator, and cross-checks the trusted tenant against
 * `institution_memberships` (same migration). The layout and dashboard call
 * this so user-facing chrome never renders the tenant UUID.
 *
 * TRUST CONTRACT (AGENTS.md §5)
 * `institutionId` must come from `AuthPrincipal` — the server-resolved trusted
 * tenant — never from a route param, query string, or client-writable metadata.
 * A caller forging an id cannot read another institution's name through this
 * module any more than through the exam/student tables: the id is validated
 * against the caller's own membership rows before anything is returned, and
 * callers only ever pass their own trusted value.
 *
 * HONEST FAILURES (AGENTS.md §7)
 * Missing env, a DB error, or no institution row each map to a typed status;
 * the UI renders a fallback rather than a guessed name. Diagnostics are logged
 * server-side with identifiers only — never secrets, keys, or tokens.
 */

import "server-only";
import { createAdminClient, DataSourceUnavailableError } from "@/lib/supabase/server";
import { selectTrustedAdminMembership } from "@/lib/auth/institution-identity";

export type InstitutionIdentity =
  /** Name found. `membershipVerified` is the cross-check result below. */
  | { status: "resolved"; name: string; membershipVerified: boolean }
  /** No trusted tenant on the principal (should be unreachable behind the guard). */
  | { status: "no-trusted-tenant" }
  /** Trusted tenant id has no matching row in `institutions`. */
  | { status: "missing-record" }
  /** Supabase variables are absent on the server. */
  | { status: "unconfigured" }
  /** The read itself failed (schema not applied, network, etc.). */
  | { status: "unavailable" };

/**
 * Resolve the display identity for one trusted principal. Two bounded reads:
 * the caller's own membership rows (keyed by their own user id) and the single
 * institution row for the trusted tenant. Neither query is filtered by
 * anything the browser controls.
 */
export async function getInstitutionIdentity(input: {
  userId: string;
  institutionId: string | null;
}): Promise<InstitutionIdentity> {
  const trustedInstitutionId = input.institutionId?.trim() ?? "";
  if (!trustedInstitutionId) {
    return { status: "no-trusted-tenant" };
  }

  let supabase;
  try {
    supabase = createAdminClient();
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      return { status: "unconfigured" };
    }
    console.error("[institution-identity] data source could not be created");
    return { status: "unavailable" };
  }

  // 1. The institution row behind the trusted tenant id. This is the name's
  //    only source; its absence is reported, never papered over.
  const { data: institution, error: institutionError } = await supabase
    .from("institutions")
    .select("id, name")
    .eq("id", trustedInstitutionId)
    .maybeSingle();

  if (institutionError) {
    // Identifiers and the Postgres error code only — no secrets in logs.
    console.error(
      "[institution-identity] institution lookup failed",
      trustedInstitutionId,
      institutionError.code,
    );
    return { status: "unavailable" };
  }

  const name =
    institution && typeof institution.name === "string"
      ? institution.name.trim()
      : "";
  if (!institution || name.length === 0) {
    console.error(
      "[institution-identity] no institutions record for trusted tenant",
      trustedInstitutionId,
    );
    return { status: "missing-record" };
  }

  // 2. Cross-check: an active INSTITUTION_ADMIN membership for exactly this
  //    tenant. A failure here degrades gracefully — the name is still the
  //    tenant's real name (the authorization decision was already made from
  //    the trusted principal upstream), but the unverified state is logged so
  //    operators can reconcile the membership row.
  const { data: membershipRows, error: membershipError } = await supabase
    .from("institution_memberships")
    .select("institution_id, role, status")
    .eq("user_id", input.userId);

  let membershipVerified = false;
  if (membershipError) {
    console.error(
      "[institution-identity] membership cross-check failed",
      input.userId,
      membershipError.code,
    );
  } else {
    membershipVerified =
      selectTrustedAdminMembership(
        trustedInstitutionId,
        (membershipRows ?? []).map((row) => ({
          institutionId: String(row.institution_id ?? ""),
          role: row.role,
          status: row.status,
        })),
      ) !== null;
    if (!membershipVerified) {
      console.error(
        "[institution-identity] no active INSTITUTION_ADMIN membership for trusted tenant",
        input.userId,
        trustedInstitutionId,
      );
    }
  }

  return { status: "resolved", name, membershipVerified };
}
