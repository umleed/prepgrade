import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getQuestionFormOptions } from "@/lib/data/questions";
import { Alert, Button } from "@/components/ui";
import { QuestionForm } from "../question-form";

export const metadata: Metadata = {
  title: "Create question",
};

export const instant = false;

type FormOptions = Awaited<ReturnType<typeof getQuestionFormOptions>>;

/**
 * Creation form for a new institution-owned question. Subject/topic/category
 * options come from the caller's visible catalogue; if the data source isn't
 * reachable yet the form still renders under an honest notice — saving would
 * fail server-side anyway, and no fake picker choices are invented.
 */
export default async function NewQuestionPage() {
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
            Create question
          </h1>
          <p className="text-sm text-ink-muted">
            Add a new question to your question bank. Fill in all required
            details and choose the correct answer.
          </p>
        </div>
        <Link href="/teacher/questions">
          <Button type="button" variant="ghost" size="sm">
            Back to bank
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          {optionsUnavailable ? (
            <Alert variant="warning" title="Catalogue is unavailable">
              The subject/topic catalogue could not be loaded, so the pickers
              below are empty. This is expected until the migrations in
              <span className="font-mono"> supabase/migrations </span>are
              applied to your Supabase project.
            </Alert>
          ) : null}
          <QuestionForm
            mode="create"
            subjects={options.subjects}
            topics={options.topics}
            categories={options.categories}
          />
        </div>
      </main>
    </>
  );
}
