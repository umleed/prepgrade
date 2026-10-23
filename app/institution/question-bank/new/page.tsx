import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getQuestionFormOptions } from "@/lib/data/questions";
import {
  INSTITUTION_QUESTION_BANK_PATH,
  INSTITUTION_QUESTION_NEW_PATH,
} from "@/lib/navigation/institution-nav";
import { Alert, Button } from "@/components/ui";
import { QuestionForm } from "@/app/teacher/questions/question-form";

export const metadata: Metadata = {
  title: "Create question",
};

export const instant = false;

type FormOptions = Awaited<ReturnType<typeof getQuestionFormOptions>>;

/**
 * Institution-owned question creation (the Create_Question_screen authoring
 * slice).
 *
 * This is the fix for the reported bug that an admin's "add question" action
 * opened the teaching workspace: the create FORM and its routing live entirely
 * under `/institution`, and the page is admitted ONLY to INSTITUTION_ADMIN (a
 * teacher uses `/teacher/questions/new`). It reuses the SHARED `QuestionForm`
 * client component and the SHARED question server actions / `createQuestion`
 * data layer — the same institution-owned `questions` table, the same pure
 * validator, the same version-history behaviour — so there is no duplicated
 * question model or competing business logic (AGENTS.md §5, §6).
 *
 * Authorization and tenancy are unchanged: `createQuestionAction` re-resolves
 * the trusted tenant from the session and validates every subject/topic/
 * category against it. A client-supplied institution id is never read. On save
 * the admin is returned to the institution bank list, staying in-shell; the
 * deeper edit/history lifecycle remains the shared admin-authorized workspace
 * (reached from the list's View action).
 */
export default async function InstitutionNewQuestionPage() {
  await connection();

  // Institution-only gate (defense in depth alongside the layout guard).
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: INSTITUTION_QUESTION_NEW_PATH,
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
        <Link href={INSTITUTION_QUESTION_BANK_PATH}>
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
            afterSaveHref={INSTITUTION_QUESTION_BANK_PATH}
            cancelHref={INSTITUTION_QUESTION_BANK_PATH}
          />
        </div>
      </main>
    </>
  );
}
