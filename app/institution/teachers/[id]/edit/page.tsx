import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guards";
import { getTeacher, listTeacherClassIds, type Teacher } from "@/lib/data/teachers";
import { listClasses } from "@/lib/data/students";
import type { TeacherInput } from "@/lib/teachers";
import { Button, Card } from "@/components/ui";
import { TeacherForm } from "../../teacher-form";

export const metadata: Metadata = {
  title: "Edit teacher",
};

export const instant = false;

/**
 * Edit an existing teacher. The record is loaded tenant-scoped, so another
 * institution's id (or a missing one) reaches `notFound()` rather than leaking.
 * Email is shown read-only (it is the account-linking key).
 */
export default async function EditTeacherPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/teachers",
  });
  const institutionId = principal.institutionId as string;
  const { id } = await params;

  let teacher: Teacher | null = null;
  let classes: { id: string; name: string }[] = [];
  let currentClassIds: string[] = [];
  let unavailable = false;

  try {
    [teacher, classes, currentClassIds] = await Promise.all([
      getTeacher(institutionId, id),
      listClasses(institutionId),
      listTeacherClassIds(institutionId, id),
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
                This teacher could not be loaded until the teacher management
                migration is applied (
                <span className="font-mono">supabase/migrations</span>).
              </p>
              <Link href="/institution/teachers" className="mt-4 inline-block">
                <Button type="button" variant="secondary" size="sm">
                  Back to teachers
                </Button>
              </Link>
            </div>
          </Card>
        </div>
      </main>
    );
  }

  if (!teacher) notFound();

  const initial: TeacherInput = {
    fullName: teacher.fullName,
    email: teacher.email,
    employeeCode: teacher.employeeCode,
    classIds: currentClassIds,
  };

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">Edit teacher</h1>
          <p className="text-sm text-ink-muted">{teacher.fullName}</p>
        </div>
        <Link href={`/institution/teachers/${teacher.id}`}>
          <Button type="button" variant="ghost" size="sm">
            Back to profile
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <div className="p-6">
              <TeacherForm
                mode="edit"
                teacherId={teacher.id}
                classes={classes}
                initial={initial}
              />
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}
