/**
 * SERVER-ONLY: reads the live Clerk session and the secret-key-backed user
 * record. Never import this from a client component.
 *
 * This is the provider boundary of PrepGrade's authorization stack. It converts
 * Clerk's server-side session data into the app's own `AuthPrincipal` shape, so
 * pages, guards, and data queries never touch a Clerk object directly.
 *
 * WHY `privateMetadata` IS TRUSTED SERVER-SIDE DATA
 * Clerk exposes three metadata channels. `unsafeMetadata` and `publicMetadata`
 * can be written by the browser SDK, so they are client-editable and unusable
 * for authorization. `privateMetadata` is only writable with the Clerk secret
 * key (Backend API / Dashboard) — the browser cannot set it — which is what
 * makes it acceptable as a trusted source before the tenant schema exists.
 *
 * SWAP PATH (prompt 08) — NOT YET ENFORCED
 * When `profiles` + `institution_memberships` land, replace the metadata read
 * below with a membership lookup (RLS-scoped, using the caller's own session)
 * and keep the returned `AuthContext` identical. Nothing above this file changes.
 *
 * IMPORTANT CAVEAT (security, not just refactor): today authorization trusts
 * the mere PRESENCE of a server-written `role` + `institutionId` in
 * `privateMetadata`. It does NOT evaluate a membership's `status`
 * (active/inactive) or any verification flag, because `privateMetadata` carries
 * neither and the DB membership table is not yet read. Consequently a membership
 * that is later deactivated (or was never confirmed) in `institution_memberships`
 * would NOT yet revoke access. Until the DB-backed read lands, treat
 * `privateMetadata` as a TEMPORARY trust source: do not treat an unverified or
 * inactive membership as authorized anywhere that reads this context.
 */

import { auth, currentUser } from "@clerk/nextjs/server";
import type { SessionState } from "./access.ts";
import { readTrustedPrincipal, type AuthPrincipal } from "./principal.ts";

export type AuthContext = {
  /** Verifiability of the incoming session — see `SessionState` in access.ts. */
  session: SessionState;
  /** Trusted identity for the session, or `null` when anonymous/unresolvable. */
  principal: AuthPrincipal | null;
  /**
   * Presentation-only fields for greeting the user. They are never used in an
   * access decision, and are `null` rather than a guessed fallback.
   */
  displayName: string | null;
  email: string | null;
};

/**
 * Resolve session state + principal for the current request.
 *
 * Requires `CLERK_SECRET_KEY`; `currentUser()` fetches the user server-side so
 * the role and tenant come from data the browser cannot write.
 *
 * The `expired` classification uses Clerk's public `sessionStatus` field, which
 * the installed SDK types allow on a signed-out auth object (a token was present
 * but resolved to no session). It only chooses the message the user sees:
 * `expired` and `anonymous` are both denied identically by `decideAccess()`.
 */
export async function getAuthContext(): Promise<AuthContext> {
  const { userId, sessionStatus } = await auth();

  if (!userId) {
    return {
      session: sessionStatus ? "expired" : "anonymous",
      principal: null,
      displayName: null,
      email: null,
    };
  }

  const user = await currentUser();
  const principal = readTrustedPrincipal({
    userId,
    // Only the server-written channel is read here, by design.
    privateMetadata: (user?.privateMetadata ?? null) as Record<string, unknown> | null,
  });

  const fullName = user?.fullName?.trim();
  const emailAddress = user?.primaryEmailAddress?.emailAddress?.trim();

  return {
    session: "active",
    principal,
    displayName: fullName ? fullName : null,
    email: emailAddress ? emailAddress : null,
  };
}

/**
 * Same session resolution, narrowed to the signed-in identity alone. Route
 * handlers that only need "who is calling" use this; anything that needs "may
 * they" goes through `guards.ts` instead.
 */
export async function getCurrentPrincipal(): Promise<AuthPrincipal | null> {
  const { principal } = await getAuthContext();
  return principal;
}
