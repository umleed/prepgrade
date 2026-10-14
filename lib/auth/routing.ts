/**
 * Denial routing table — pure, dependency-free, and unit-testable.
 *
 * `guards.ts` decides *whether* a request is denied; this module decides *where*
 * a denied visitor is sent. Keeping the table separate means the security-
 * relevant part of that logic (session problems go to sign-in, membership and
 * role/tenant problems stay inside the app) is exercised by `npm test`, while
 * `guards.ts` keeps only the parts that need a live Next.js request.
 *
 * Invariants enforced here:
 * - an anonymous visitor is never sent to a page that renders data;
 * - a user bounced for role or tenant reasons lands on the shared dashboard with
 *   a `denied=` key that maps back to a typed denial, and nothing more;
 * - every `next` value is sanitised before it can become a redirect target.
 */

import { DENIAL_PARAM, loginUrlFor } from "./access.ts";
import type { AccessDenial } from "./access.ts";
import { safeInternalRedirect } from "./redirect.ts";

/** Shared landing route for signed-in users; renders role, denial, and no-membership states. */
export const DASHBOARD_PATH = "/dashboard";

/** Query param the dashboard reads to explain why the visitor was bounced back. */
export const DENIED_QUERY_KEY = "denied";

/** `/dashboard?denied=<key>` — the access-denied landing state for role/tenant denials. */
export function dashboardUrlForDenial(reason: AccessDenial): string {
  return `${DASHBOARD_PATH}?${DENIED_QUERY_KEY}=${DENIAL_PARAM[reason]}`;
}

/**
 * Where a denied request goes: sign-in for session problems, dashboard for
 * membership/role/tenant problems. Session denials keep the sanitised return
 * path so the user can resume after verifying again.
 */
export function redirectTargetForDenial(
  reason: AccessDenial,
  next: string = DASHBOARD_PATH,
): string {
  switch (reason) {
    case "signedOut":
      return loginUrlFor(safeInternalRedirect(next, DASHBOARD_PATH), null);
    case "sessionExpired":
      return loginUrlFor(
        safeInternalRedirect(next, DASHBOARD_PATH),
        "sessionExpired",
      );
    case "noMembership":
    case "roleNotAllowed":
    case "tenantMismatch":
    case "permissionDenied":
    case "ownerMismatch":
    case "scopeMismatch":
      return dashboardUrlForDenial(reason);
  }
}
