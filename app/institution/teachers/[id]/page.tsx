import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guards";
import { getTeacher, type Teacher } from "@/lib/data/teachers";
import { TEACHER_STATUS_HINTS, TEACHER_STATUS_LABELS } from "@/lib/teachers";
import { Alert, Badge, Button, Card } from "@/components/ui";
import { TeacherAccessButton } from "../teacher-access-button";

export const metadata: Metadata = {
  title: "Teacher profile",
};

export const instant = false;

function StatusBadge({ status }: { status: Teacher["status"] }) {
  const tone = status === "active" ? "success" : status === "invited" ? "info" : "neutral";
  return (
    <Badge tone={tone} dot={status !== "inactive"}>
      {TEACHER_STATUS_LABELS[status]}
    </Badge>
  );
}

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

export default async function TeacherProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/teachers",
  });
  const { id } = await params;

  let teacher: Teacher | null = null;
  let unavailable = false;
  try {
    teacher = await getTeacher(principal.institutionId as string, id);
  } catch {
    // Any read failure (data source unconfigured, or the teacher tables not yet
    // applied) is a "cannot load" state — distinct from a real 404, so it is
    // surfaced honestly instead of misleadingly reporting "not found".
    unavailable = true;
  }

  if (unavailable) {
    return (
      <>
        <ProfileHeader name="Teacher" />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            <Alert variant="danger" title="Teacher data is unavailable">
              This profile could not be loaded. It is expected until the
              teacher management migration is applied (<span className="font-mono">supabase/migrations</span>).
            </Alert>
          </div>
        </main>
      </>
    );
  }

  // getTeacher is tenant-scoped, so `null` means "no such teacher in your
  // institution" — an id from another tenant also lands here, never leaking
  // that the record exists elsewhere.
  if (!teacher) notFound();

  return (
    <>
      <ProfileHeader name={teacher.fullName} />

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          <Card>
            <div className="flex items-start justify-between gap-4 p-5">
              <div>
                <h2 className="text-lg font-bold tracking-tight text-ink">
                  {teacher.fullName}
                </h2>
                <p className="text-sm text-ink-muted">{teacher.email}</p>
                <p className="font-mono text-xs text-ink-subtle">{teacher.employeeCode}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={teacher.status} />
                <Link href={`/institution/teachers/${teacher.id}/edit`}>
                  <Button type="button" variant="secondary" size="sm">
                    Edit
                  </Button>
                </Link>
              </div>
            </div>
          </Card>

          <Card>
            <dl className="px-5 py-2">
              <Detail label="Assigned classes">
                {teacher.classNames.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {teacher.classNames.map((name) => (
                      <Badge key={name} tone="neutral">
                        {name}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  <span className="text-ink-subtle">
                    Unassigned — this teacher has no class scope yet.
                  </span>
                )}
              </Detail>
              <Detail label="Status">
                {TEACHER_STATUS_LABELS[teacher.status]}
                <span className="block text-xs text-ink-subtle">
                  {TEACHER_STATUS_HINTS[teacher.status]}
                </span>
              </Detail>
              <Detail label="Linked account">
                {teacher.profileId
                  ? "Connected to a signed-in account"
                  : "No sign-in account linked yet"}
              </Detail>
              <Detail label="Added">
                {new Date(teacher.createdAt).toLocaleDateString()}
              </Detail>
            </dl>
          </Card>

          <Card>
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-ink">Access</h3>
                <p className="text-xs text-ink-muted">
                  Deactivating revokes sign-in access and keeps this
                  teacher&apos;s records. It can be undone.
                </p>
              </div>
              <TeacherAccessButton teacherId={teacher.id} status={teacher.status} />
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
        <p className="text-sm text-ink-muted">Teacher profile</p>
      </div>
      <Link href="/institution/teachers">
        <Button type="button" variant="ghost" size="sm">
          Back to teachers
        </Button>
      </Link>
    </header>
  );
}
