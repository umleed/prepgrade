/**
 * SERVER-ONLY authorization guards for Server Components, Route Handlers, and
 * Server Actions. Never import from a client component: these read the session
 * with the secret key and enforce the decision from `access.ts`.
 *
 * TWO ENTRY POINTS, ONE RULE SET
 * - `inspectAccess()` answers the question without side effects, so a route
 *   handler can turn a denial into `401`/`403` itself.
 * - `requireAccess()` answers it for a rendered page and redirects on denial.
 * Both call the same `decideAccess()`, so a page and an API can never drift into
 * disagreeing about who is allowed.
 *
 * The proxy (`proxy.ts`) is a convenience layer only. Every protected page and
 * handler must call a guard here — that is the actual enforcement (AGENTS.md §5).
 *
 * This module is thin on purpose: identity comes from `context.ts`, the rules
 * from `access.ts`, and the destination for a denial from `routing.ts` — the two
 * pure layers are covered by `npm test`, which cannot load `next/navigation`.
 */

import { redirect } from "next/navigation";
import { decideAccess, type AccessDecision } from "./access.ts";
import { getAuthContext, type AuthContext } from "./context.ts";
import { recordPlatformAudit } from "../data/audit.ts";
import type { AuthPrincipal } from "./principal.ts";
import {
  checkResourceAccess,
  type ResourceAccessRequest,
} from "./resource-access.ts";
import { redirectTargetForDenial } from "./routing.ts";
import type { UserRole } from "./roles.ts";

export type GuardOptions = {
  /**
   * Path the visitor intended, used to rebuild `?next=` on a sign-in redirect.
   * Sanitised by `redirectTargetForDenial`, so a hostile value can't leak through.
   */
  next?: string;
  /** Roles allowed here. Omit for "any signed-in member with a membership". */
  roles?: readonly UserRole[];
  /** Tenant the target belongs to. Omit when the route isn't tenant-scoped yet. */
  institutionId?: string | null;
};

/**
 * Evaluate access for the current request without redirecting or throwing.
 * Route handlers and server actions use this, then answer with
 * `statusForDenial(decision.reason)`.
 */
export async function inspectAccess(
  options: GuardOptions = {},
): Promise<AccessDecision> {
  const context = await getAuthContext();
  return decideAccess(context, {
    roles: options.roles,
    institutionId: options.institutionId,
  });
}

/**
 * Enforce access for a rendered route and return the trusted principal.
 * Redirects on denial — `redirect()` throws internally, so this never returns a
 * principal for a denied request.
 */
export async function requireAccess(
  options: GuardOptions = {},
): Promise<AuthPrincipal> {
  const decision = await inspectAccess(options);
  if (decision.allowed) return decision.principal;
  redirect(redirectTargetForDenial(decision.reason, options.next));
}

/** Any signed-in user with a usable membership. */
export async function requireSignIn(
  options: Omit<GuardOptions, "roles" | "institutionId"> = {},
): Promise<AuthPrincipal> {
  return requireAccess(options);
}

/**
 * Session-only gate, for routes a signed-in user must reach *before* a
 * membership exists. Institution setup (prompt 05) is how a new account gets
 * its role and tenant, so the membership rule must not be applied there — it
 * would make the page unreachable for exactly the people it exists for.
 * The full context is returned so the page can adapt to what it finds.
 */
export async function requireSession(
  options: Omit<GuardOptions, "roles" | "institutionId"> = {},
): Promise<AuthContext> {
  const context = await getAuthContext();
  if (context.session === "active") return context;
  redirect(
    redirectTargetForDenial(
      context.session === "expired" ? "sessionExpired" : "signedOut",
      options.next,
    ),
  );
}

/**
 * Signed-in user whose role is one of `roles`, scoped to `institutionId` when given.
 */
export async function requireRole(
  roles: readonly UserRole[],
  options: Omit<GuardOptions, "roles"> = {},
): Promise<AuthPrincipal> {
  return requireAccess({ ...options, roles });
}

/**
 * The platform-area gate (prompt 31). Identical rules to
 * `requireRole(["SUPER_ADMIN"])` — the named entry point exists so every
 * platform surface declares the same requirement, and a denied attempt is
 * recorded through the platform audit log before the redirect.
 *
 * AUDIT OF DENIALS: entering the platform area is a normal action for a
 * super admin (not audited), but a DENIED attempt is a security event and is
 * recorded (actor id + trusted role + denial outcome, no secrets — see
 * lib/audit/platform.ts). The record is best-effort and non-blocking: the
 * redirect happens whether or not the write succeeds, and anonymous probes
 * are recorded with the `unknown` actor. Only authorization failures are
 * audited — a session problem (signed out / expired) is not an access
 * attempt worth a security record.
 */
export async function requireSuperAdmin(
  options: { next?: string } = {},
): Promise<AuthPrincipal> {
  const context = await getAuthContext();
  const decision = decideAccess(context, { roles: ["SUPER_ADMIN"] });
  if (decision.allowed) return decision.principal;

  if (
    decision.reason !== "signedOut" &&
    decision.reason !== "sessionExpired"
  ) {
    // Fire-and-forget is not available in a request path we are about to
    // redirect from, so await the (non-throwing) write, then redirect.
    await recordPlatformAudit({
      actorId: decision.principal?.userId ?? null,
      actorRole: decision.principal?.role ?? null,
      action: "platform.access_denied",
      targetType: "area",
      targetId: options.next ?? "/platform",
      outcome: "denied",
    });
  }

  redirect(redirectTargetForDenial(decision.reason, options.next));
}

/**
 * Signed-in user with a membership in `institutionId` — the cross-tenant gate.
 * Pass the tenant read from the *server-side record being opened*, never one
 * taken from a request body or query param.
 */
export async function requireTenant(
  institutionId: string,
  options: Omit<GuardOptions, "institutionId"> = {},
): Promise<AuthPrincipal> {
  return requireAccess({ ...options, institutionId });
}

/**
 * Evaluate a resource-level request (permission + operation + record facts)
 * for the current request, without redirecting or throwing. Route handlers
 * and server actions answer with `statusForDenial(decision.reason)`; for a
 * resource denial that is always `403` — the caller is authenticated, the
 * authorization is what fails.
 */
export async function inspectResourceAccess(
  request: ResourceAccessRequest,
): Promise<AccessDecision> {
  const context = await getAuthContext();
  return checkResourceAccess(context, request);
}

/**
 * Enforce a resource-level request for a rendered route and return the
 * trusted principal. Redirects on denial, like `requireAccess`. Pass the
 * `ResourceDescriptor` built from the server-side read of the record — never
 * from client-supplied ids, roles, or release flags (AGENTS.md §5, §6).
 */
export async function requireResourceAccess(
  request: ResourceAccessRequest,
  options: { next?: string } = {},
): Promise<AuthPrincipal> {
  const decision = await inspectResourceAccess(request);
  if (decision.allowed) return decision.principal;
  redirect(redirectTargetForDenial(decision.reason, options.next));
}
