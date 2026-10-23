import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import Link from "next/link";
import { SignOutButton } from "@clerk/nextjs";
import {
  ACCESS_NOTICES,
  SIGN_OUT_REDIRECT_URL,
  decideAccess,
  denialFromParam,
  loginUrlFor,
  type AccessNotice,
} from "@/lib/auth/access";
import { getAuthContext } from "@/lib/auth/context";
import { missingMembershipReason, type AuthPrincipal } from "@/lib/auth/principal";
import { getRegistrationIntent } from "@/lib/auth/registration-context";
import { INTENT_LABELS, intentNextStep, type RegistrationIntent } from "@/lib/auth/registration";
import { DASHBOARD_PATH, DENIED_QUERY_KEY } from "@/lib/auth/routing";
import {
  AREA_LABELS,
  accessibleAreas,
  roleHomePath,
  roleLabel,
} from "@/lib/auth/roles";
import { Alert, Badge, Button, Card } from "@/components/ui";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Your PrepGrade workspace.",
};

// Reads the live session and query params, so this route is never prerendered
// (Cache Components). Auth pages must resolve per request.
export const instant = false;

/**
 * Notice for a visitor bounced back from a restricted area. Deliberately limited
 * to the cross-area and resource-level denials; see the call site for why.
 */
function bounceNoticeFor(
  value: string | undefined,
): AccessNotice | null {
  const denial = denialFromParam(value);
  if (
    denial === "roleNotAllowed" ||
    denial === "tenantMismatch" ||
    denial === "permissionDenied" ||
    denial === "ownerMismatch" ||
    denial === "scopeMismatch"
  ) {
    return ACCESS_NOTICES[denial];
  }
  return null;
}

/**
 * Role-routed landing area for every signed-in role.
 *
 * Enforcement is here, not in the proxy: the session is re-verified, the role
 * and tenant are resolved from trusted server-side data, and the routing spine
 * (`roleHomePath`) decides the destination — all on the server, on every request.
 * Three states are rendered explicitly: the role workspace, the no-membership
 * state, and the access-denied notice for users bounced back from a restricted
 * area. Unknown query values are ignored rather than trusted.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  const [params, context, intent] = await Promise.all([
    searchParams,
    getAuthContext(),
    getRegistrationIntent(),
  ]);

  // No verifiable session: fail closed back to sign-in, preserving the return
  // path so an expired user lands here again after re-verifying.
  if (context.session !== "active") {
    redirect(
      loginUrlFor(
        DASHBOARD_PATH,
        context.session === "expired" ? "sessionExpired" : null,
      ),
    );
  }

  const principal = context.principal;
  const role = principal?.role ?? null;

  // Single source of truth for post-login destinations. Roles with dedicated
  // workspaces (INSTITUTION_ADMIN → /institution, prompt 10; STUDENT →
  // /student, prompt 20; SUPER_ADMIN → /platform, prompt 31; TEACHER →
  // /teacher, prompt 26) are redirected there. Only an unassigned role resolves
  // to this page. The map lives in `lib/auth/roles.ts` and no call site changes
  // as they ship.
  const home = roleHomePath(role);
  if (home !== DASHBOARD_PATH) {
    redirect(home);
  }

  // A denial on this route can only be a membership problem — role, tenant,
  // and resource requirements are what guard the *other* areas.
  const decision = decideAccess(context, {});
  // Only role/tenant/resource bounces from other areas are announced here. A
  // `membership` value is already covered by the no-membership state below, and
  // an unknown value is ignored rather than rendered, so a hand-written URL
  // can't put words on the page.
  const bounced = bounceNoticeFor(
    typeof params[DENIED_QUERY_KEY] === "string"
      ? (params[DENIED_QUERY_KEY] as string)
      : undefined,
  );
  const greeting = context.displayName || context.email || "there";

  if (!decision.allowed) {
    return (
      <NoMembershipState
        greeting={greeting}
        email={context.email}
        principal={principal}
        intent={intent}
      />
    );
  }

  const areas = accessibleAreas(role);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-16">
      {bounced ? (
        <Alert variant={bounced.variant} title={bounced.title}>
          {bounced.message}
        </Alert>
      ) : null}

      <Card>
        <div className="flex flex-col gap-5 p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-ink">
                Welcome back, {greeting}
              </h1>
              <p className="mt-1 text-sm text-ink-muted">
                You&apos;re signed in as a{" "}
                <strong className="font-semibold text-ink">
                  {roleLabel(role).toLowerCase()}
                </strong>
                . Your role and institution were resolved server-side from
                trusted data.
              </p>
            </div>
            <Badge tone="brand" dot>
              {roleLabel(role)}
            </Badge>
          </div>

          <dl className="grid gap-3 rounded-card border border-border bg-surface-muted p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-muted">Account</dt>
              <dd className="mt-0.5 font-medium break-all text-ink">
                {context.email ?? "No email on file"}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Institution</dt>
              <dd className="mt-0.5 font-medium break-all text-ink">
                {principal?.institutionId ?? "Platform scope (no institution)"}
              </dd>
            </div>
          </dl>

          <div>
            <h2 className="text-sm font-semibold text-ink">
              Areas available to your role
            </h2>
            <ul className="mt-2 flex flex-wrap gap-2">
              {areas.map((area) => (
                <li key={area}>
                  <Badge tone="neutral">{AREA_LABELS[area]}</Badge>
                </li>
              ))}
            </ul>
          </div>

          {/* Platform administration (prompt 31) has shipped — link it for
              SUPER_ADMIN only, and only here: the /platform routes enforce
              the role server-side regardless of this link. */}
          {role === "SUPER_ADMIN" ? (
            <Link href="/platform" className="w-full sm:w-auto">
              <Button type="button" variant="primary" size="md" className="w-full sm:w-auto">
                Open platform administration
              </Button>
            </Link>
          ) : null}

          <Alert variant="info" title="What happens next">
            Institution management (prompt 10), platform administration
            (prompt 31), the student workspace (prompt 20), and the teacher
            dashboard (prompt 26) are all live — those roles now go straight to
            their own area after sign-in. This page remains the landing state
            for accounts that are signed in but not yet assigned to a workspace.
            {" "}
            <Link href="/onboarding" className="font-medium underline">
              Review institution setup
            </Link>
            .
          </Alert>

          <SignOutButton redirectUrl={SIGN_OUT_REDIRECT_URL}>
            <Button type="button" variant="secondary" size="md">
              Sign out
            </Button>
          </SignOutButton>
        </div>
      </Card>
    </main>
  );
}

/**
 * Signed in, but no trusted role/institution membership exists yet — the state a
 * brand-new PrepGrade account sees before institution setup (prompts 05 and 08).
 * Nothing role-specific is rendered, so an unassigned account can't probe the
 * product's data surface.
 */
function NoMembershipState({
  greeting,
  email,
  principal,
  intent,
}: {
  greeting: string;
  email: string | null;
  principal: AuthPrincipal | null;
  intent: RegistrationIntent | null;
}) {
  const notice = ACCESS_NOTICES.noMembership;
  const missing = principal
    ? missingMembershipReason(principal)
    : ("role" as const);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16">
      <Card>
        <div className="flex flex-col gap-5 p-6 sm:p-8">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink">
              Welcome, {greeting}
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              Your account is verified{email ? ` (${email})` : ""}, but there is
              no workspace to open yet.
            </p>
          </div>

          <Alert variant={notice.variant} title={notice.title}>
            {notice.message}
          </Alert>

          {/*
           * The intent is presentation-only — it never unlocks a workspace.
           * Surfacing it here (when the user actually picked one) explains
           * what still needs to happen, without inventing any approval status
           * we cannot verify until the tenant schema (prompt 08) exists.
           */}
          {intent ? (
            <div className="rounded-card border border-border bg-surface-muted p-4 text-sm">
              <p className="text-ink-muted">
                You signed up as a{" "}
                <strong className="font-semibold text-ink">
                  {INTENT_LABELS[intent]}
                </strong>
                .
              </p>
              <p className="mt-1 leading-6 text-ink">
                {intentNextStep(intent)}
              </p>
            </div>
          ) : null}

          <p className="text-sm leading-6 text-ink-muted">
            {missing === "role"
              ? "An institution admin or PrepGrade super admin needs to assign your role before you can open any area."
              : "Your role is recognised, but it isn't attached to an institution yet. Create your institution or accept an invitation to continue."}
          </p>

          <div className="flex flex-wrap gap-3">
            <Link href="/onboarding">
              <Button type="button" variant="primary" size="md">
                {intent ? "Review your setup" : "Choose your account type"}
              </Button>
            </Link>
            <SignOutButton redirectUrl={SIGN_OUT_REDIRECT_URL}>
              <Button type="button" variant="secondary" size="md">
                Sign out
              </Button>
            </SignOutButton>
          </div>
        </div>
      </Card>
    </main>
  );
}
