import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getQuestion, getQuestionFormOptions } from "@/lib/data/questions";
import type { QuestionInput } from "@/lib/questions";
import { Alert, Button, EmptyState } from "@/components/ui";
import { QuestionForm } from "../../question-form";

export const metadata: Metadata = {
  title: "Edit question",
};

export const instant = false;

type FormOptions = Awaited<ReturnType<typeof getQuestionFormOptions>>;

/**
 * Edit form for an institution-owned question. The row is re-read under the
 * caller's tenant (a foreign or vanished id renders the same "not found"
 * state as the detail page — existence is never leaked). Meaning-changing
 * edits (text, options, answer key, marks, type) archive the pre-edit
 * content into question_versions before the update lands, so what a student
 * answered is never silently overwritten; exam snapshots (prompts 17–19)
 * will pin those versions per published exam.
 */
export default async function EditQuestionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher/questions",
  });
  const institutionId = principal.institutionId as string;

  const { id } = await params;

  let options: FormOptions = { subjects: [], topics: [], categories: [] };
  let optionsUnavailable = false;
  try {
    options = await getQuestionFormOptions(institutionId);
  } catch {
    optionsUnavailable = true;
  }

  let question: Awaited<ReturnType<typeof getQuestion>> = null;
  let loadError = false;
  try {
    question = await getQuestion(institutionId, id);
  } catch {
    loadError = true;
  }

  const toolbar = (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">
          Edit question
        </h1>
        <p className="text-sm text-ink-muted">
          Changes apply to the bank immediately; meaning-changing edits are
          archived to this question&apos;s version history first.
        </p>
      </div>
      <Link href={`/teacher/questions/${id}`}>
        <Button type="button" variant="ghost" size="sm">
          Back to question
        </Button>
      </Link>
    </header>
  );

  if (loadError || !question) {
    return (
      <>
        {toolbar}
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-6xl">
            {loadError ? (
              <Alert variant="danger" title="Question data is unavailable">
                This question could not be loaded. This is expected until the
                questions migration is applied to your Supabase project.
              </Alert>
            ) : (
              <EmptyState
                title="Question not found"
                description="This question is not in your institution's bank."
                action={
                  <Link href="/teacher/questions">
                    <Button type="button" variant="secondary" size="sm">
                      Back to bank
                    </Button>
                  </Link>
                }
              />
            )}
          </div>
        </main>
      </>
    );
  }

  const initial: QuestionInput = {
    questionText: question.questionText,
    subjectId: question.subjectId,
    topicId: question.topicId ?? "",
    categoryId: question.categoryId ?? "",
    questionType: "mcq_single",
    difficulty: question.difficulty as QuestionInput["difficulty"],
    options: question.options,
    correctOptionIndex: question.correctOptionIndex,
    explanation: question.explanation,
    marks: question.marks,
    learningObjective: question.learningObjective,
    provenance: question.provenance as QuestionInput["provenance"],
    sourceLabel: question.sourceLabel,
    sourceYear: question.sourceYear,
    licenseNotes: question.licenseNotes,
  };

  return (
    <>
      {toolbar}
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          {optionsUnavailable ? (
            <Alert variant="warning" title="Catalogue is unavailable">
              The subject/topic catalogue could not be loaded, so some picker
              choices may be missing below. The question&apos;s current subject
              and topic remain selected.
            </Alert>
          ) : null}
          <QuestionForm
            mode="edit"
            questionId={question.id}
            subjects={options.subjects}
            topics={options.topics}
            categories={options.categories}
            initial={initial}
          />
        </div>
      </main>
    </>
  );
}
