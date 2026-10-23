import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getExamFormOptions } from "@/lib/data/exams";
import {
  INSTITUTION_EXAMS_NEW_PATH,
  INSTITUTION_EXAMS_PATH,
} from "@/lib/navigation/institution-nav";
import { Alert, Button } from "@/components/ui";
import { ExamForm } from "@/app/teacher/exams/exam-form";

export const metadata: Metadata = {
  title: "Create exam",
};

export const instant = false;

type FormOptions = Awaited<ReturnType<typeof getExamFormOptions>>;

/**
 * Institution-owned exam creation (assessment-details slice).
 *
 * This is the fix for the reported bug that an admin's "Create exam" action
 * opened the teaching workspace: the create FORM and its routing live entirely
 * under `/institution`, and the page is admitted ONLY to INSTITUTION_ADMIN (a
 * teacher uses `/teacher/exams/new`). It reuses the SHARED `ExamForm` client
 * component and the SHARED exam server actions / `createExam` data layer — the
 * same institution-owned `exams` table, the same pure validator, the same
 * publish lifecycle — so there is no duplicated exam model or competing
 * business logic (AGENTS.md §5, §6).
 *
 * Authorization and tenancy are unchanged: `createExamAction` re-resolves the
 * trusted tenant from the session and the data layer validates every
 * subject/category against it. A client-supplied institution id is never read.
 * On save the admin is returned to the institution exam list, staying in-shell;
 * the deeper build/publish/monitor lifecycle remains the shared admin-authorized
 * workspace (reached from the list's View action).
 */
export default async function InstitutionNewExamPage() {
  await connection();

  // Institution-only gate (defense in depth alongside the layout guard).
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: INSTITUTION_EXAMS_NEW_PATH,
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
        <Link href={INSTITUTION_EXAMS_PATH}>
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
            afterSaveHref={INSTITUTION_EXAMS_PATH}
            cancelHref={INSTITUTION_EXAMS_PATH}
          />
        </div>
      </main>
    </>
  );
}
