import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getExam, getExamFormOptions } from "@/lib/data/exams";
import { examLockedFields, toDatetimeLocalValue, type ExamInput } from "@/lib/exams";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import { Alert, Button } from "@/components/ui";
import { ExamForm } from "@/app/teacher/exams/exam-form";

export const metadata: Metadata = {
  title: "Edit exam",
};

export const instant = false;

type FormOptions = Awaited<ReturnType<typeof getExamFormOptions>>;

/**
 * Edit form for an institution-owned exam. Which fields are still editable
 * is decided by the exam's CURRENT status: the locked list is computed
 * server-side from the stored row and passed down for presentation, while
 * the server action independently refuses any locked-field change — the UI
 * hint is convenience, the enforcement is on the server (AGENTS.md §5, §6).
 */
export default async function EditExamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher/exams",
  });
  const institutionId = principal.institutionId as string;

  const { id } = await params;

  let exam: Awaited<ReturnType<typeof getExam>> = null;
  let options: FormOptions = { subjects: [], categories: [] };
  let loadError: "unconfigured" | "unavailable" | null = null;
  try {
    const [examResult, optionsResult] = await Promise.all([
      getExam(institutionId, id),
      getExamFormOptions(institutionId),
    ]);
    exam = examResult;
    options = optionsResult;
  } catch (error) {
    loadError = error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  const toolbar = (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Edit exam</h1>
        <p className="text-sm text-ink-muted">
          Update the exam details allowed by its current lifecycle status.
        </p>
      </div>
      <Link href="/teacher/exams">
        <Button type="button" variant="ghost" size="sm">
          Back to exams
        </Button>
      </Link>
    </header>
  );

  if (loadError) {
    return (
      <>
        {toolbar}
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            {loadError === "unconfigured" ? (
              <Alert variant="warning" title="Exam data is not configured">
                Supabase connection variables are missing on the server.
              </Alert>
            ) : (
              <Alert variant="danger" title="Exam data is unavailable">
                This exam could not be loaded. This is expected until the exams
                migration is applied to your Supabase project
                (<span className="font-mono">supabase/migrations</span>).
              </Alert>
            )}
          </div>
        </main>
      </>
    );
  }

  if (!exam) {
    return (
      <>
        {toolbar}
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            <Alert variant="warning" title="Exam not found">
              This exam is not in your institution, or it has been removed. We
              never confirm whether an exam exists in another institution.
            </Alert>
            <Link href="/teacher/exams" className="mt-4 inline-block">
              <Button type="button" variant="secondary" size="sm">
                Back to exams
              </Button>
            </Link>
          </div>
        </main>
      </>
    );
  }

  const initial: ExamInput = {
    title: exam.title,
    description: exam.description,
    subjectId: exam.subjectId,
    categoryId: exam.categoryId,
    durationMinutes: exam.durationMinutes,
    startsAt: toDatetimeLocalValue(exam.startsAt),
    endsAt: toDatetimeLocalValue(exam.endsAt),
    maxAttempts: exam.maxAttempts,
    shuffleQuestions: exam.shuffleQuestions,
    shuffleOptions: exam.shuffleOptions,
    resultsRelease: exam.resultsRelease,
  };

  return (
    <>
      {toolbar}
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          <ExamForm
            mode="edit"
            examId={exam.id}
            subjects={options.subjects}
            categories={options.categories}
            initial={initial}
            lockedFields={examLockedFields(exam.status)}
          />
        </div>
      </main>
    </>
  );
}
