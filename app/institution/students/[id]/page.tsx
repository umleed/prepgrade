import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guards";
import { getStudent, type Student } from "@/lib/data/students";
import {
  listStudentClassHistory,
  type StudentClassHistoryEntry,
} from "@/lib/data/classes";
import { STUDENT_STATUS_LABELS } from "@/lib/students";
import { Alert, Badge, Button, Card } from "@/components/ui";
import { StudentStatusButton } from "../student-status-button";

export const metadata: Metadata = {
  title: "Student profile",
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

export default async function StudentProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/students",
  });
  const { id } = await params;

  let student: Student | null = null;
  let history: StudentClassHistoryEntry[] = [];
  let unavailable = false;
  try {
    const institutionId = principal.institutionId as string;
    student = await getStudent(institutionId, id);
    // Class-move timeline (prompt 13): only meaningful once the student exists
    // under this tenant. A failure here is bookkeeping, not the profile itself,
    // so it degrades to an empty timeline rather than blocking the page.
    if (student) {
      try {
        history = await listStudentClassHistory(institutionId, student.id);
      } catch {
        history = [];
      }
    }
  } catch {
    // Any read failure (data source unconfigured, or the tenant tables not yet
    // applied) is a "cannot load" state — distinct from a real 404, so it is
    // surfaced honestly instead of misleadingly reporting "not found".
    unavailable = true;
  }

  if (unavailable) {
    return (
      <>
        <ProfileHeader name="Student" />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            <Alert variant="danger" title="Student data is unavailable">
              This profile could not be loaded. It is expected until the tenant
              database migration is applied (<span className="font-mono">supabase/migrations</span>).
            </Alert>
          </div>
        </main>
      </>
    );
  }

  // getStudent is tenant-scoped, so `null` means "no such student in your
  // institution" — an id from another tenant also lands here, never leaking
  // that the record exists elsewhere.
  if (!student) notFound();

  return (
    <>
      <ProfileHeader name={student.fullName} />

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          <Card>
            <div className="flex items-start justify-between gap-4 p-5">
              <div>
                <h2 className="text-lg font-bold tracking-tight text-ink">
                  {student.fullName}
                </h2>
                <p className="font-mono text-xs text-ink-muted">{student.studentCode}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={student.status === "active" ? "success" : "neutral"} dot>
                  {STUDENT_STATUS_LABELS[student.status]}
                </Badge>
                <Link href={`/institution/students/${student.id}/edit`}>
                  <Button type="button" variant="secondary" size="sm">
                    Edit
                  </Button>
                </Link>
              </div>
            </div>
          </Card>

          <Card>
            <dl className="px-5 py-2">
              <Detail label="Class">
                {student.className ?? <span className="text-ink-subtle">Unassigned</span>}
              </Detail>
              <Detail label="Status">{STUDENT_STATUS_LABELS[student.status]}</Detail>
              <Detail label="Linked account">
                {student.profileId
                  ? "Connected to a signed-in account"
                  : "No sign-in account linked yet"}
              </Detail>
              <Detail label="Enrolled">
                {new Date(student.createdAt).toLocaleDateString()}
              </Detail>
            </dl>
          </Card>

          <Card>
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-ink">Access</h3>
                <p className="text-xs text-ink-muted">
                  Deactivating keeps this student&apos;s history and is reversible.
                </p>
              </div>
              <StudentStatusButton studentId={student.id} status={student.status} />
            </div>
          </Card>

          <Card>
            <div className="p-5">
              <h3 className="text-sm font-semibold text-ink">Class history</h3>
              <p className="text-xs text-ink-muted">
                Recorded automatically whenever this student moves class, so a
                transfer never rewrites the class they belonged to for past
                assessments.
              </p>
              {history.length === 0 ? (
                <p className="mt-3 text-sm text-ink-subtle">
                  No class changes recorded yet.
                </p>
              ) : (
                <ul className="mt-3 flex flex-col gap-2">
                  {history.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-center justify-between gap-3 border-b border-border py-2 text-sm last:border-b-0"
                    >
                      <span className="text-ink">
                        {entry.className ?? (
                          <span className="text-ink-subtle">Unassigned</span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs text-ink-subtle">
                        {new Date(entry.changedAt).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
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
        <p className="text-sm text-ink-muted">Student profile</p>
      </div>
      <Link href="/institution/students">
        <Button type="button" variant="ghost" size="sm">
          Back to students
        </Button>
      </Link>
    </header>
  );
}
