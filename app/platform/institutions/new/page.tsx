import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { InstitutionRegistrationForm } from "@/components/platform/institution-registration-form";
import { Card } from "@/components/ui";
import { BuildingIcon } from "@/components/platform/icons";

export const metadata: Metadata = {
  title: "Add Institution",
};

// Reads the live session — never prerendered (platform guard convention).
export const instant = false;

/**
 * Platform "Add New Institution" registration (SUPER_ADMIN only).
 *
 * The page gate is `requireSuperAdmin` — enforced on every request before
 * anything renders — and the server action re-checks it independently,
 * because a page guard alone is not authorization (AGENTS.md §5). The form
 * itself is a client component for progressive `useActionState` feedback;
 * this shell only supplies the page title, the guard, and the static
 * guidance panels (server-rendered, no client JavaScript needed).
 *
 * Honest scope vs. the approved design: the numbered Basic Information and
 * Location & Contact sections are implemented; Subscription Plan, logo
 * upload, Save-as-Draft, and the welcome-email toggle are stated as
 * deferrals on the form itself — those systems do not exist yet, so nothing
 * here pretends to collect or promise them.
 */
export default async function PlatformAddInstitutionPage() {
  await connection();
  await requireSuperAdmin({ next: "/platform/institutions/new" });

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <div>
          <Link
            href="/platform/institutions"
            className="text-sm font-medium text-brand hover:underline"
          >
            ← Institutions
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink lg:text-3xl">
            Add New Institution
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Register a new school, tutorial centre, or CBT centre on PrepGrade.
          </p>
        </div>

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <InstitutionRegistrationForm />

          {/* Guidance column — static, server-rendered. */}
          <aside
            aria-label="Registration guidance"
            className="flex flex-col gap-4"
          >
            <Card>
              <div className="flex flex-col gap-3 p-5">
                <h2 className="text-base font-semibold tracking-tight text-ink">
                  What happens next?
                </h2>
                <ol className="flex flex-col gap-2 text-sm leading-6 text-ink-muted">
                  <li className="flex gap-2">
                    <StepDot>1</StepDot>
                    <span>The institution is created on PrepGrade as Active.</span>
                  </li>
                  <li className="flex gap-2">
                    <StepDot>2</StepDot>
                    <span>
                      Its record appears in the directory and the registration
                      is written to the audit log.
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <StepDot>3</StepDot>
                    <span>
                      The first administrator is provisioned separately through
                      a trusted invitation workflow — this form does not create
                      user accounts or send emails.
                    </span>
                  </li>
                </ol>
              </div>
            </Card>

            <Card>
              <div className="flex flex-col gap-2 p-5">
                <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-ink">
                  <BuildingIcon className="h-4 w-4 text-brand" />
                  Important notes
                </h2>
                <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-6 text-ink-muted">
                  <li>
                    Each institution&apos;s data is isolated and cannot be
                    accessed by other institutions.
                  </li>
                  <li>
                    Institution names must be unique — duplicates are refused,
                    never merged.
                  </li>
                  <li>
                    Subscription plans and status enforcement are not yet
                    wired up; the initial record is operational metadata for
                    the platform team.
                  </li>
                  <li>
                    Every create attempt (including refused ones) is recorded
                    in the audit log.
                  </li>
                </ul>
              </div>
            </Card>
          </aside>
        </div>
      </div>
    </main>
  );
}

function StepDot({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-2xs font-semibold text-brand-700"
    >
      {children}
    </span>
  );
}
