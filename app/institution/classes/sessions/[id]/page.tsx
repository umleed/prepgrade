import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guards";
import {
  getSession,
  countClassesByStatus,
  type AcademicSession,
} from "@/lib/data/classes";
import { ORG_STATUS_HINTS, ORG_STATUS_LABELS } from "@/lib/classes";
import { Alert, Badge, Button, Card } from "@/components/ui";
import { SessionStatusButton } from "../session-status-button";

export const metadata: Metadata = {
  title: "Academic session",
};

export const instant = false;

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0">
      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">
        {label}
      </dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  );
}

export default async function SessionProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes/sessions",
  });
  const institutionId = principal.institutionId as string;
  const { id } = await params;

  let session: AcademicSession | null = null;
  let classCounts = { active: 0, archived: 0 };
  let unavailable = false;
  try {
    session = await getSession(institutionId, id);
    if (session) {
      classCounts = await countClassesByStatus(institutionId, id);
    }
  } catch {
    unavailable = true;
  }

  if (unavailable) {
    return (
      <>
        <ProfileHeader name="Session" />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            <Alert variant="danger" title="Session data is unavailable">
              This profile could not be loaded. It is expected until the tenant
              database migration is applied (<span className="font-mono">supabase/migrations</span>).
            </Alert>
          </div>
        </main>
      </>
    );
  }

  if (!session) notFound();

  return (
    <>
      <ProfileHeader name={session.name} />

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          <Card>
            <div className="flex items-start justify-between gap-4 p-5">
              <div>
                <h2 className="text-lg font-bold tracking-tight text-ink">
                  {session.name}
                </h2>
                <p className="text-sm text-ink-muted">Academic session</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={session.status === "active" ? "success" : "neutral"} dot>
                  {ORG_STATUS_LABELS[session.status]}
                </Badge>
                <Link href={`/institution/classes/sessions/${session.id}/edit`}>
                  <Button type="button" variant="secondary" size="sm">
                    Edit
                  </Button>
                </Link>
              </div>
            </div>
          </Card>

          <Card>
            <dl className="px-5 py-2">
              <Detail label="Active classes">{classCounts.active}</Detail>
              <Detail label="Archived classes">{classCounts.archived}</Detail>
              <Detail label="Created">
                {new Date(session.createdAt).toLocaleDateString()}
              </Detail>
            </dl>
          </Card>

          <Card>
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-ink">Classes in this session</h3>
                <p className="text-xs text-ink-muted">
                  Review or add the classes grouped under this academic year.
                </p>
              </div>
              <Link href={`/institution/classes?session=${session.id}`}>
                <Button type="button" variant="secondary" size="sm">
                  View classes
                </Button>
              </Link>
            </div>
          </Card>

          <Card>
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-ink">Lifecycle</h3>
                <p className="text-xs text-ink-muted">
                  {ORG_STATUS_HINTS[session.status]}
                </p>
              </div>
              <SessionStatusButton
                sessionId={session.id}
                status={session.status}
                activeClasses={classCounts.active}
              />
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}

function ProfileHeader({ name }: { name: string }) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">{name}</h1>
        <p className="text-sm text-ink-muted">Academic session</p>
      </div>
      <Link href="/institution/classes/sessions">
        <Button type="button" variant="ghost" size="sm">
          Back to sessions
        </Button>
      </Link>
    </header>
  );
}
