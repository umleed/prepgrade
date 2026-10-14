import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guards";
import { getStudent, listClasses, type Student } from "@/lib/data/students";
import { Button, Card } from "@/components/ui";
import { StudentForm } from "../../student-form";

export const metadata: Metadata = {
  title: "Edit student",
};

export const instant = false;

/**
 * Edit an existing student. The record is loaded tenant-scoped, so another
 * institution's id (or a missing one) reaches `notFound()` rather than leaking.
 */
export default async function EditStudentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/students",
  });
  const institutionId = principal.institutionId as string;
  const { id } = await params;

  let student: Student | null = null;
  let classes: { id: string; name: string }[] = [];
  let unavailable = false;
  try {
    [student, classes] = await Promise.all([
      getStudent(institutionId, id),
      listClasses(institutionId),
    ]);
  } catch {
    unavailable = true;
  }

  if (unavailable) {
    return (
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <div className="p-5">
              <p className="text-sm text-ink-muted">
                This student could not be loaded until the tenant database
                migration is applied (<span className="font-mono">supabase/migrations</span>).
              </p>
              <Link href="/institution/students" className="mt-4 inline-block">
                <Button type="button" variant="secondary" size="sm">
                  Back to students
                </Button>
              </Link>
            </div>
          </Card>
        </div>
      </main>
    );
  }

  if (!student) notFound();

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">Edit student</h1>
          <p className="text-sm text-ink-muted">{student.fullName}</p>
        </div>
        <Link href={`/institution/students/${student.id}`}>
          <Button type="button" variant="ghost" size="sm">
            Back to profile
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <div className="p-6">
              <StudentForm
                mode="edit"
                studentId={student.id}
                classes={classes}
                initial={{
                  fullName: student.fullName,
                  studentCode: student.studentCode,
                  classId: student.classId ?? "",
                  status: student.status,
                }}
              />
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}
