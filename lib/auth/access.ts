/**
 * Access decision engine — pure, dependency-free, and unit-testable.
 *
 * `decideAccess()` is the single place that turns "who is this?" (session +
 * trusted principal) and "what do they want?" (role / tenant requirement) into a
 * grant or a typed denial. Server Components, route handlers, and server actions
 * all consume this one function, so a permission rule is written once and the
 * tests exercise the same code the app runs — not a mock of it.
 *
 * Rules, in order (each one fails closed):
 *   1. no verifiable session                      → signedOut
 *   2. session present but no longer verifiable   → sessionExpired
 *   3. role not assigned, or not attached to a
 *      institution (SUPER_ADMIN is platform-wide) → noMembership
 *   4. role absent from the requirement's allow
 *      list                                         → roleNotAllowed
 *   5. resource belongs to another institution and
 *      the caller is not SUPER_ADMIN                → tenantMismatch
 */

import type { AuthPrincipal } from "./principal.ts";
import type { UserRole } from "./roles.ts";

/**
 * - `anonymous`: no session at all.
 * - `expired`: the browser presented session data that the provider could no
 *   longer verify (age, revocation, sign-out elsewhere). Treated exactly like
 *   `anonymous` for authorization; the distinction only selects the message the
 *   user sees, so they learn to sign in again rather than seeing a blank page.
 * - `active`: a verifiable session.
 */
export type SessionState = "anonymous" | "expired" | "active";

export type AccessDenial =
  | "signedOut"
  | "sessionExpired"
  | "noMembership"
  | "roleNotAllowed"
  | "tenantMismatch"
  // Resource-level denials, produced by `checkResourceAccess()` (prompt 09):
  // the role lacks the named capability, the row isn't the caller's, or the
  // record sits outside the caller's teaching scope.
  | "permissionDenied"
  | "ownerMismatch"
  | "scopeMismatch";

export type AccessRequirement = {
  /** Roles allowed here. Omitted or empty means "any signed-in member". */
  roles?: readonly UserRole[];
  /**
   * Tenant the target resource belongs to. When set, a non-super-admin caller
   * whose membership points at a different institution is denied — this is the
   * cross-tenant boundary from AGENTS.md §5.
   */
  institutionId?: string | null;
};

export type AccessDecision =
  | { allowed: true; principal: AuthPrincipal }
  | { allowed: false; reason: AccessDenial; principal: AuthPrincipal | null };

/** The identity part of the decision input, kept separate for testability. */
export type AccessSubject = {
  session: SessionState;
  principal: AuthPrincipal | null;
};

export function decideAccess(
  subject: AccessSubject,
  requirement: AccessRequirement = {},
): AccessDecision {
  const { session, principal } = subject;

  if (session !== "active") {
    return {
      allowed: false,
      reason: session === "expired" ? "sessionExpired" : "signedOut",
      principal: null,
    };
  }

  if (!principal || !principal.hasMembership) {
    return { allowed: false, reason: "noMembership", principal };
  }

  // Role check before tenant check: a role that may never enter this area is
  // denied even if its tenant happens to match.
  const roles = requirement.roles;
  if (roles && roles.length > 0) {
    if (principal.role === null || !roles.includes(principal.role)) {
      return { allowed: false, reason: "roleNotAllowed", principal };
    }
  }

  const targetInstitution = requirement.institutionId;
  if (targetInstitution !== undefined && targetInstitution !== null) {
    if (
      principal.role !== "SUPER_ADMIN" &&
      principal.institutionId !== targetInstitution
    ) {
      return { allowed: false, reason: "tenantMismatch", principal };
    }
  }

  return { allowed: true, principal };
}

/** Stable, machine-readable keys for query params (e.g. `/dashboard?denied=`). */
export const DENIAL_PARAM: Record<AccessDenial, string> = {
  signedOut: "signed-out",
  sessionExpired: "expired",
  noMembership: "membership",
  roleNotAllowed: "role",
  tenantMismatch: "tenant",
  permissionDenied: "permission",
  ownerMismatch: "owner",
  scopeMismatch: "scope",
};

/** Reverse of `DENIAL_PARAM`; unknown or missing values become `null`. */
export function denialFromParam(
  value: string | null | undefined,
): AccessDenial | null {
  if (!value) return null;
  const entry = (Object.entries(DENIAL_PARAM) as [AccessDenial, string][]).find(
    ([, param]) => param === value,
  );
  return entry ? entry[0] : null;
}

export type AccessNotice = {
  variant: "info" | "warning" | "danger";
  title: string;
  message: string;
};

/**
 * User-facing wording per denial. Copy is intentionally generic: it tells the
 * user what happened and what to do next, and never reveals which roles,
 * institutions, or permissions the target required.
 */
export const ACCESS_NOTICES: Record<AccessDenial, AccessNotice> = {
  signedOut: {
    variant: "info",
    title: "You're signed out",
    message: "Sign in again to open that page.",
  },
  sessionExpired: {
    variant: "info",
    title: "Your session expired",
    message:
      "For your security, we signed you out after the session aged. Sign in again to continue where you left off.",
  },
  noMembership: {
    variant: "warning",
    title: "No institution membership yet",
    message:
      "Your account is verified, but it isn't attached to an institution with a role yet. Set up your institution or ask your school admin for an invitation.",
  },
  roleNotAllowed: {
    variant: "danger",
    title: "Access not allowed for your role",
    message:
      "Your role doesn't include this area. If you expected access, ask an institution admin to review your role.",
  },
  tenantMismatch: {
    variant: "danger",
    title: "This record belongs to another institution",
    message:
      "You can only open data that belongs to your own institution. Nothing from the other institution has been loaded.",
  },
  permissionDenied: {
    variant: "danger",
    title: "Your role doesn't include this action",
    message:
      "This operation needs a capability your role doesn't hold. Nothing was changed or revealed.",
  },
  ownerMismatch: {
    variant: "danger",
    title: "This record belongs to another account",
    message:
      "You can only open your own exams, attempts, and results. Nothing from the other account has been loaded.",
  },
  scopeMismatch: {
    variant: "danger",
    title: "This record is outside your assigned classes",
    message:
      "You can only work with classes you're assigned to. Ask an institution admin if you expected access.",
  },
};

/** Notice for a denial; `null` for a grant. */
export function accessNotice(decision: AccessDecision): AccessNotice | null {
  return decision.allowed ? null : ACCESS_NOTICES[decision.reason];
}

/**
 * Notice for the sign-in screen, from the `?reason=` param our own redirects
 * write. Unknown or absent reasons show nothing — the login form stays plain for
 * a first-time visitor, and we never invent a reason we can't verify.
 */
export function loginNoticeFromReason(
  value: string | null | undefined,
): AccessNotice | null {
  if (value === DENIAL_PARAM.sessionExpired) return ACCESS_NOTICES.sessionExpired;
  if (value === DENIAL_PARAM.signedOut) return ACCESS_NOTICES.signedOut;
  return null;
}

/**
 * Build the sign-in URL for a denied request. `next` is sanitised by
 * `safeInternalRedirect` at the login page itself, so a crafted value can't
 * turn this into an open redirect.
 */
export function loginUrlFor(
  nextPath: string,
  reason: "signedOut" | "sessionExpired" | null = null,
): string {
  const params = new URLSearchParams();
  params.set("next", nextPath || "/dashboard");
  if (reason) params.set("reason", DENIAL_PARAM[reason]);
  return `/login?${params.toString()}`;
}

/**
 * Landing URL after an explicit sign-out. The reason value is one this app
 * wrote itself, so the sign-in screen can say "you're signed out" truthfully
 * instead of guessing why the session ended.
 */
export const SIGN_OUT_REDIRECT_URL = `/login?reason=${DENIAL_PARAM.signedOut}`;

/**
 * HTTP status a route handler should return for a denial.
 * `signedOut`/`sessionExpired` are `401` — there is no verifiable identity.
 * Everything else is `403`: identity is fine, authorization is not. `403` (not
 * `404`) is deliberate for tenant mismatches in the API layer so tooling can
 * tell "forbidden" from "does not exist"; pages that must not confirm existence
 * should render `notFound()` instead.
 */
export function statusForDenial(reason: AccessDenial): 401 | 403 {
  return reason === "signedOut" || reason === "sessionExpired" ? 401 : 403;
}
