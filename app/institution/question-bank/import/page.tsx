import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getQuestionFormOptions } from "@/lib/data/questions";
import {
  INSTITUTION_QUESTION_BANK_PATH,
  INSTITUTION_QUESTION_IMPORT_PATH,
  INSTITUTION_QUESTION_NEW_PATH,
} from "@/lib/navigation/institution-nav";
import { Alert, Button } from "@/components/ui";
import { QuestionImportForm } from "@/app/teacher/questions/question-import-form";

export const metadata: Metadata = {
  title: "Import questions",
};

export const instant = false;

type FormOptions = Awaited<ReturnType<typeof getQuestionFormOptions>>;

/**
 * Institution-owned bulk question import (prompt 34).
 *
 * Mirrors the create page's contract exactly: the route lives under
 * `/institution`, is admitted ONLY to INSTITUTION_ADMIN (a teacher imports from
 * the shared `/teacher/questions` workspace), and reuses the SHARED
 * `QuestionImportForm` and the SHARED `importQuestionsAction` — the same
 * tenant-owned `questions` table, the same pure validator, the same
 * `createQuestion` write path — so there is one question model and one set of
 * rules (AGENTS.md §5, §6, §7).
 *
 * The catalog the form needs for its preview is read from the caller's trusted
 * tenant server-side; the import itself re-resolves everything on the server,
 * so the browser's copy is only ever an advisory convenience, never authority.
 */
export default async function InstitutionImportQuestionsPage() {
  await connection();

  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: INSTITUTION_QUESTION_IMPORT_PATH,
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
        <Link href={INSTITUTION_QUESTION_BANK_PATH}>
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

          {options.subjects.length === 0 && !optionsUnavailable ? (
            <Alert variant="info" title="Add a subject first">
              Imported rows must name a subject that already exists in your
              catalogue.{" "}
              <Link href={INSTITUTION_QUESTION_NEW_PATH} className="font-medium underline">
                Create a question manually
              </Link>{" "}
              or add subjects under Subjects &amp; Topics before importing.
            </Alert>
          ) : null}

          <QuestionImportForm
            subjects={options.subjects}
            topics={options.topics}
            categories={options.categories}
            afterImportHref={INSTITUTION_QUESTION_BANK_PATH}
            cancelHref={INSTITUTION_QUESTION_BANK_PATH}
          />
        </div>
      </main>
    </>
  );
}
