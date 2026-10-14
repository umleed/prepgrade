import type { Metadata } from "next";
import { connection } from "next/server";
import { SignOutButton } from "@clerk/nextjs";
import { SIGN_OUT_REDIRECT_URL } from "@/lib/auth/access";
import { requireSession } from "@/lib/auth/guards";
import { getRegistrationIntent } from "@/lib/auth/registration-context";
import { roleLabel } from "@/lib/auth/roles";
import { Badge, Button, Card } from "@/components/ui";
import { OnboardingPanel } from "./onboarding-panel";

export const metadata: Metadata = {
  title: "Get started",
  description: "Set up your PrepGrade workspace.",
};

// Authenticated, request-time route: reads the session via the server guards.
export const instant = false;

/**
 * First-stop route for newly signed-up users.
 *
 * Session-gated, not membership-gated: this is where an account without a role
 * or institution picks its starting point, so requiring a membership here
 * would lock it out (see `requireSession`). The session is verified server-side
 * on every request — the proxy is not the enforcement point.
 *
 * What lives here vs. what lives in prompt 08:
 * - Here: the *untrusted* registration intent (Student / Teacher / CBT Centre /
 *   School) and intent-aware guidance. Nothing in this page grants a role, a
 *   membership, or a workspace link.
 * - Prompt 08: real invitations, join codes, institution registration records,
 *   and the server-side approval workflow. The trusted swap happens in
 *   `lib/auth/context.ts` — not on this page.
 */
export default async function OnboardingPage() {
  await connection();

  const [context, intent] = await Promise.all([
    requireSession({ next: "/onboarding" }),
    getRegistrationIntent(),
  ]);

  const principal = context.principal;
  const role = principal?.role ?? null;
  const greeting = context.displayName || context.email || "there";

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16">
      <Card>
        <div className="flex flex-col gap-5 p-6 sm:p-8">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink">
              Welcome, {greeting}
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              Your account is verified. Choose your account type to see the
              right setup steps.
            </p>
          </div>

          {/* What the server already knows about this account — shown plainly so
              a user with an existing membership isn't asked to start over. The
              intent itself is untrusted and never unlocks a workspace. */}
          <dl className="grid gap-3 rounded-card border border-border bg-surface-muted p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-muted">Trusted role on file</dt>
              <dd className="mt-0.5 flex items-center gap-2">
                <Badge tone={role ? "brand" : "neutral"}>
                  {roleLabel(role)}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Institution on file</dt>
              <dd className="mt-0.5 font-medium break-all text-ink">
                {principal?.institutionId ?? "None yet"}
              </dd>
            </div>
          </dl>

          <OnboardingPanel initialIntent={intent} />

          <div className="flex flex-wrap gap-3 border-t border-border pt-4">
            <SignOutButton redirectUrl={SIGN_OUT_REDIRECT_URL}>
              <Button type="button" variant="ghost" size="md">
                Sign out
              </Button>
            </SignOutButton>
          </div>
        </div>
      </Card>
    </main>
  );
}
