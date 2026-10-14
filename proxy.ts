/**
 * Proxy (Next.js 16 `proxy.ts`, formerly `middleware.ts`): runs Clerk's
 * middleware to keep the session fresh and enforce the auth boundary. This is a
 * convenience/UX layer — the real authorization happens in Server Components /
 * Route Handlers via `@clerk/nextjs/server` `auth()` (AGENTS.md §5: never rely
 * on hiding UI alone).
 *
 * Routing rules (per approved product decision):
 *   - `/` (marketing landing) stays PUBLIC.
 *   - `/dashboard`, `/onboarding`, `/app`, `/setup`, `/platform` require a signed-in user.
 *   - `/login`, `/register` are guest-only (signed-in users bounce to /dashboard).
 *
 * Role routing is NOT decided here. The proxy only knows that a session exists;
 * resolving role + institution membership happens server-side in
 * `lib/auth/context.ts`, and `/dashboard` is what routes each role to its area.
 */

import { NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { DENIAL_PARAM } from "@/lib/auth/access";

/** Paths that require an authenticated session. */
const isProtected = createRouteMatcher([
  "/dashboard(.*)",
  "/onboarding(.*)",
  "/app(.*)",
  "/setup(.*)",
  // Convenience gate only — the SUPER_ADMIN check itself runs server-side in
  // requireSuperAdmin() (lib/auth/guards.ts), which is the actual enforcement.
  "/platform(.*)",
]);
/** Paths that should bounce signed-in users to their dashboard. */
const isGuestOnly = createRouteMatcher(["/login(.*)", "/register(.*)"]);

export const proxy = clerkMiddleware(async (auth, request) => {
  const { userId, sessionStatus } = await auth();
  const { pathname } = request.nextUrl;

  if (isProtected(request) && !userId) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname);
    // `sessionStatus` is only set when a session token was presented but no
    // longer resolves (aged out, revoked, or ended elsewhere), so we can tell
    // that visitor to expect a fresh code. A first-time visitor gets no notice.
    // This changes the message only — both cases are denied identically.
    if (sessionStatus) {
      url.searchParams.set("reason", DENIAL_PARAM.sessionExpired);
    }
    return NextResponse.redirect(url);
  }

  if (isGuestOnly(request) && userId) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    /*
     * Run on everything except static assets and Next internals so that
     * session handling + route gating apply to all app routes.
     * Clerk's auto-proxy path (`/__clerk/:path*`) is included last, after the
     * API/TRPC matcher, per Clerk's Next.js setup guidance.
     */
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
