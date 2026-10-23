import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getQuestionFormOptions } from "@/lib/data/questions";
import { Alert, Button } from "@/components/ui";
import { QuestionImportForm } from "../question-import-form";

export const metadata: Metadata = {
  title: "Import questions",
};

export const instant = false;

type FormOptions = Awaited<ReturnType<typeof getQuestionFormOptions>>;

/**
 * Bulk question import for the teaching workspace (prompt 34). TEACHER and
 * INSTITUTION_ADMIN both hold `question.manage`, so both are admitted here;
 * every row is scoped to the caller's trusted tenant and re-validated on the
 * server before it is written. Shares the same form, action, and `createQuestion`
 * path as the institution import page.
 */
export default async function TeacherImportQuestionsPage() {
  await connection();
  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher/questions",
  });
  const institutionId = principal.institutionId as string;

  let options: FormOptions = { subjects: [], topics: [], categories: [] };
  let optionsUnavailable = false;
  try {
    options = await getQuestionFormOptions(institutionId);
  } catch {
    optionsUnavailable = true;
  }

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">
            Import questions
          </h1>
          <p className="text-sm text-ink-muted">
            Load a batch of questions from a CSV or TSV file. Preview and check
            every row before anything is saved.
          </p>
        </div>
        <Link href="/teacher/questions">
          <Button type="button" variant="ghost" size="sm">
            Back to bank
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
          {optionsUnavailable ? (
            <Alert variant="warning" title="Catalogue is unavailable">
              The subject/topic catalogue could not be loaded, so imported rows
              cannot be matched to your subjects. This is expected until the
              migrations in{" "}
              <span className="font-mono">supabase/migrations</span> are applied
              to your Supabase project.
            </Alert>
          ) : null}
          <QuestionImportForm
            subjects={options.subjects}
            topics={options.topics}
            categories={options.categories}
            afterImportHref="/teacher/questions"
            cancelHref="/teacher/questions"
          />
        </div>
      </main>
    </>
  );
}
