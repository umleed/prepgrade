import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getExamFormOptions } from "@/lib/data/exams";
import { Alert, Button } from "@/components/ui";
import { ExamForm } from "@/app/teacher/exams/exam-form";

export const metadata: Metadata = {
  title: "Create exam",
};

export const instant = false;

type FormOptions = Awaited<ReturnType<typeof getExamFormOptions>>;

/**
 * Creation form for a new institution-owned exam (prompt 17). The exam
 * starts as a DRAFT — publishing is an explicit lifecycle action on the
 * detail page. Subject options come from the caller's visible catalogue; if
 * the data source isn't reachable the form still renders under an honest
 * notice, since saving would fail server-side anyway.
 */
export default async function NewExamPage() {
  await connection();
  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher/exams",
  });
  const institutionId = principal.institutionId as string;

  let options: FormOptions = { subjects: [], categories: [] };
  let optionsUnavailable = false;
  try {
    options = await getExamFormOptions(institutionId);
  } catch {
    optionsUnavailable = true;
  }

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">
            Create exam
          </h1>
          <p className="text-sm text-ink-muted">
            Set the exam details. It saves as a draft — questions and class
            assignment follow.
          </p>
        </div>
        <Link href="/teacher/exams">
          <Button type="button" variant="ghost" size="sm">
            Back to exams
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          {optionsUnavailable ? (
            <Alert variant="warning" title="Catalogue is unavailable">
              The subject catalogue could not be loaded, so the picker below
              is empty. This is expected until the migrations in
              <span className="font-mono"> supabase/migrations </span>are
              applied to your Supabase project.
            </Alert>
          ) : null}
          <ExamForm
            mode="create"
            subjects={options.subjects}
            categories={options.categories}
          />
        </div>
      </main>
    </>
  );
}
