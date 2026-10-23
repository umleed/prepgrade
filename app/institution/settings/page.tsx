import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getInstitutionProfile, type InstitutionProfile } from "@/lib/data/institution-profile";
import {
  INSTITUTION_EXAMS_PATH,
  INSTITUTION_SETTINGS_PATH,
} from "@/lib/navigation/institution-nav";
import { Alert, Button, Card } from "@/components/ui";
import { InstitutionProfileForm } from "./profile-form";

export const metadata: Metadata = {
  title: "Settings",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

/**
 * A settings area that has NO schema-backed editable data yet renders an
 * honest explanation with a link to where the real capability lives — never a
 * dead toggle or a fabricated control. The product is an assessment platform,
 * not a school ERP, so fee/payroll/attendance-style settings are deliberately
 * absent (they have no table and no owner flow).
 */
function InfoSection({
  title,
  description,
  children,
  links,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
  links: Array<{ label: string; href: string }>;
}) {
  return (
    <Card>
      <div className="flex flex-col gap-3 p-6">
        <div>
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
        </div>
        {children}
        {links.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {links.map((link) => (
              <Link key={link.href} href={link.href}>
                <Button type="button" variant="secondary" size="sm">
                  {link.label}
                </Button>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** Honest, non-fabricated states for a profile the database can't supply. */
function profileFallback(status: "missing-record" | "unconfigured" | "unavailable") {
  if (status === "unconfigured") {
    return (
      <Alert variant="warning" title="Settings are not configured">
        Supabase connection variables are missing on the server. Set
        <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
        <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to enable
        profile editing.
      </Alert>
    );
  }
  if (status === "missing-record") {
    return (
      <Alert variant="danger" title="Institution record not found">
        Your signed-in account has no matching institution record, so there is
        nothing to edit. This is a data problem on the server — please contact
        support. No placeholder profile is shown to avoid editing a record that
        does not exist.
      </Alert>
    );
  }
  return (
    <Alert variant="danger" title="Settings are temporarily unavailable">
      Your institution profile could not be loaded right now. This is expected
      until the profile migration is applied to your Supabase project
      (<span className="font-mono">supabase/migrations</span>). No data is shown
      to avoid presenting anything that has not been stored.
    </Alert>
  );
}

export default async function InstitutionSettingsPage() {
  await connection();

  // Institution-only gate (defense in depth alongside the layout guard).
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: INSTITUTION_SETTINGS_PATH,
  });
  const institutionId = principal.institutionId as string;

  let profile: InstitutionProfile | null = null;
  let fallbackStatus: "missing-record" | "unconfigured" | "unavailable" | null = null;
  const result = await getInstitutionProfile(institutionId);
  if (result.status === "resolved") {
    profile = result.profile;
  } else {
    fallbackStatus = result.status;
  }

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">Settings</h1>
          <p className="text-sm text-ink-muted">
            Manage your institution&apos;s profile and assessment setup.
          </p>
        </div>
        <Link href="/institution">
          <Button type="button" variant="ghost" size="sm">
            Back to dashboard
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          {/* General — the only section with schema-backed editable fields. */}
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-ink">General</h2>
              <p className="text-sm text-ink-muted">
                Your institution&apos;s identity and contact details.
              </p>
            </div>
            {profile ? (
              <InstitutionProfileForm initial={profile} />
            ) : fallbackStatus ? (
              profileFallback(fallbackStatus)
            ) : null}
          </section>

          <InfoSection
            title="Examination settings"
            description="Duration, pass mark, attempts, start window, and publishing are configured per exam in the exam builder — the platform intentionally has no institution-wide exam defaults in the schema yet, so nothing here would actually be applied. Manage exams to set these where they take effect."
            links={[
              { label: "Go to Exams", href: INSTITUTION_EXAMS_PATH },
              { label: "Create an exam", href: `${INSTITUTION_EXAMS_PATH}/new` },
            ]}
          >
            <Alert variant="info" title="No institution-wide exam defaults exist">
              There is no schema field for shared exam settings, so this page
              offers no toggles rather than controls that would silently do
              nothing. Configure each exam directly.
            </Alert>
          </InfoSection>

          <InfoSection
            title="Subjects & topics"
            description="Your curriculum catalogue — the subjects and topics questions and exams are filed under. These are managed on their own page, where they are created and edited."
            links={[{ label: "Manage subjects", href: "/institution/subjects" }]}
          />

          <InfoSection
            title="User access"
            description="Teachers and students who can work within your institution. Access is governed by server-side role checks and membership rows; manage the people who hold those roles below."
            links={[
              { label: "Manage teachers", href: "/institution/teachers" },
              { label: "Manage students", href: "/institution/students" },
            ]}
          />

          <InfoSection
            title="Integrations"
            description="Third-party integrations (imports, SSO providers, webhooks) have no data source in the current schema, so there is nothing to configure here yet. This section stays informational rather than offering controls that cannot be saved."
            links={[]}
          />

          <InfoSection
            title="Security"
            description="Sign-in and role assignment are handled by the authentication provider and enforced on the server on every request (never trusted from the browser). Tenant isolation scopes every read and write to your institution. There are no institution-managed security toggles in the schema, so none are shown."
            links={[]}
          />
        </div>
      </main>
    </>
  );
}
