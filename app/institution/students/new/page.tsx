import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { listClasses } from "@/lib/data/students";
import { Button, Card } from "@/components/ui";
import { StudentForm } from "../student-form";

export const metadata: Metadata = {
  title: "Add student",
};

export const instant = false;

/**
 * Enrolment form for a new student. Class options are read from the caller's
 * tenant; if the data source isn't reachable yet the form still renders with no
 * classes (assignment can happen later), matching the directory's honest states.
 */
export default async function NewStudentPage() {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/students",
  });

  let classes: { id: string; name: string }[] = [];
  try {
    classes = await listClasses(principal.institutionId as string);
  } catch {
    classes = [];
  }

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">Add student</h1>
          <p className="text-sm text-ink-muted">
            Enrol a student in your institution&apos;s roster.
          </p>
        </div>
        <Link href="/institution/students">
          <Button type="button" variant="ghost" size="sm">
            Back to students
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <div className="p-6">
              <StudentForm mode="create" classes={classes} />
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}
