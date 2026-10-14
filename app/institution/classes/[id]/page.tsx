import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guards";
import { getClass, type ClassRecord } from "@/lib/data/classes";
import { ORG_STATUS_HINTS, ORG_STATUS_LABELS } from "@/lib/classes";
import { Alert, Badge, Button, Card } from "@/components/ui";
import { ClassStatusButton } from "../class-status-button";

export const metadata: Metadata = {
  title: "Class profile",
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

export default async function ClassProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes",
  });
  const { id } = await params;

  let record: ClassRecord | null = null;
  let unavailable = false;
  try {
    record = await getClass(principal.institutionId as string, id);
  } catch {
    // Any read failure (data source unconfigured, or the tenant tables not yet
    // applied) is a "cannot load" state — distinct from a real 404, so it is
    // surfaced honestly instead of misleadingly reporting "not found".
    unavailable = true;
  }

  if (unavailable) {
    return (
      <>
        <ProfileHeader name="Class" />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            <Alert variant="danger" title="Class data is unavailable">
              This profile could not be loaded. It is expected until the tenant
              database migration is applied (<span className="font-mono">supabase/migrations</span>).
            </Alert>
          </div>
        </main>
      </>
    );
  }

  // getClass is tenant-scoped, so `null` means "no such class in your
  // institution" — an id from another tenant also lands here, never leaking
  // that the record exists elsewhere.
  if (!record) notFound();

  return (
    <>
      <ProfileHeader name={record.name} />

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          <Card>
            <div className="flex items-start justify-between gap-4 p-5">
              <div>
                <h2 className="text-lg font-bold tracking-tight text-ink">
                  {record.name}
                </h2>
                <p className="text-sm text-ink-muted">
                  {record.academicSessionName ?? "No academic session"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={record.status === "active" ? "success" : "neutral"} dot>
                  {ORG_STATUS_LABELS[record.status]}
                </Badge>
                <Link href={`/institution/classes/${record.id}/edit`}>
                  <Button type="button" variant="secondary" size="sm">
                    Edit
                  </Button>
                </Link>
              </div>
            </div>
          </Card>

          <Card>
            <dl className="px-5 py-2">
              <Detail label="Academic session">
                {record.academicSessionName ?? (
                  <span className="text-ink-subtle">Unassigned</span>
                )}
              </Detail>
              <Detail label="Students">{record.studentCount}</Detail>
              <Detail label="Teachers">
                {record.teacherNames.length > 0 ? (
                  record.teacherNames.join(", ")
                ) : (
                  <span className="text-ink-subtle">None assigned yet</span>
                )}
              </Detail>
              <Detail label="Created">
                {new Date(record.createdAt).toLocaleDateString()}
              </Detail>
            </dl>
          </Card>

          <Card>
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-ink">Lifecycle</h3>
                <p className="text-xs text-ink-muted">
                  {ORG_STATUS_HINTS[record.status]}
                </p>
              </div>
              <ClassStatusButton
                classId={record.id}
                status={record.status}
                attachedStudents={record.studentCount}
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
        <p className="text-sm text-ink-muted">Class profile</p>
      </div>
      <Link href="/institution/classes">
        <Button type="button" variant="ghost" size="sm">
          Back to classes
        </Button>
      </Link>
    </header>
  );
}
