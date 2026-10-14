import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { listClasses } from "@/lib/data/students";
import { Alert, Button, Card } from "@/components/ui";
import { TeacherForm } from "../teacher-form";

export const metadata: Metadata = {
  title: "Add teacher",
};

export const instant = false;

/**
 * Invitation form for a new teacher. Class options are read from the caller's
 * tenant; if the data source isn't reachable yet the form still renders with
 * no classes (assignment can happen later), matching the directory's honest
 * states. The invitation/membership grant itself runs in the server action —
 * never from anything typed here.
 */
export default async function NewTeacherPage() {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/teachers",
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
          <h1 className="text-xl font-bold tracking-tight text-ink">Add teacher</h1>
          <p className="text-sm text-ink-muted">
            Invite a teacher to your institution&apos;s roster.
          </p>
        </div>
        <Link href="/institution/teachers">
          <Button type="button" variant="ghost" size="sm">
            Back to teachers
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          <Alert variant="info" title="How inviting works">
            The teacher receives an email invitation to create their PrepGrade
            account. Once their account exists, open their profile and choose
            Activate access to grant teacher sign-in for the assigned classes.
          </Alert>

          <Card>
            <div className="p-6">
              <TeacherForm mode="create" classes={classes} />
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}
