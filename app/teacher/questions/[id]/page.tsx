import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import {
  getQuestion,
  listQuestionVersions,
  type QuestionVersionRecord,
} from "@/lib/data/questions";
import {
  optionLabel,
  QUESTION_DIFFICULTY_LABELS,
  QUESTION_PROVENANCE_LABELS,
  QUESTION_STATUS_HINTS,
  QUESTION_STATUS_LABELS,
  QUESTION_TYPE_LABELS,
  type QuestionDifficulty,
} from "@/lib/questions";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import { Alert, Badge, Button, Card, EmptyState } from "@/components/ui";
import { cn } from "@/lib/utils";
import { QuestionStatusButton } from "@/app/teacher/questions/question-status-button";

export const metadata: Metadata = {
  title: "Question",
};

export const instant = false;

function difficultyTone(difficulty: string): "success" | "warning" | "danger" {
  if (difficulty === "easy") return "success";
  if (difficulty === "hard") return "danger";
  return "warning";
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0">
      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">
        {label}
      </dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

/**
 * Answerable options with the correct one marked. This is the answer key — it
 * renders ONLY on a server component behind a `question.manage` role guard, so
 * a student can never fetch it (AGENTS.md §6). The correct option is derived
 * from `correctOptionIndex`, never from a client-supplied flag.
 */
function OptionList({
  options,
  correctOptionIndex,
}: {
  options: string[];
  correctOptionIndex: number;
}) {
  if (options.length === 0) {
    return (
      <p className="text-sm text-ink-subtle">
        This question has no stored options — it may predate the current
        structure and should be edited.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-2">
      {options.map((option, index) => {
        const isCorrect = index === correctOptionIndex;
        return (
          <li
            key={index}
            className={cn(
              "flex items-start gap-3 rounded-field border px-3 py-2.5 text-sm",
              isCorrect
                ? "border-success-border bg-success-soft"
                : "border-border bg-surface",
            )}
          >
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold",
                isCorrect
                  ? "bg-success text-white"
                  : "bg-surface-muted text-ink-muted",
              )}
              aria-hidden="true"
            >
              {optionLabel(index)}
            </span>
            <span className="min-w-0 flex-1 text-ink">{option}</span>
            {isCorrect ? (
              <Badge tone="success" variant="solid">
                Correct
              </Badge>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Archived pre-edit content (prompt 16). Each row is what the question said
 * BEFORE a meaning-changing edit; newest first. The archived answer key is
 * fine to show here — this whole page sits behind the question.manage role
 * guard, and "A teacher at your institution" never exposes another user's
 * identifier beyond what the bank already shows.
 */
function VersionList({
  versions,
  currentUserId,
}: {
  versions: QuestionVersionRecord[];
  currentUserId: string;
}) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {versions.map((version) => (
        <li key={version.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
          <p className="text-sm font-medium text-ink">
            Version {version.version}{" "}
            <span className="font-normal text-ink-muted">
              · archived {formatDate(version.createdAt)} · edited by{" "}
              {version.editedBy === currentUserId ? "you" : "a teacher at your institution"}
            </span>
          </p>
          <p className="line-clamp-2 text-sm text-ink-muted">
            {version.questionText}
          </p>
          <p className="text-2xs text-ink-subtle">
            Answer was {optionLabel(version.correctOptionIndex)}.
            {" "}
            {version.options[version.correctOptionIndex] ?? "—"} ·{" "}
            {version.marks} {version.marks === 1 ? "mark" : "marks"}
          </p>
        </li>
      ))}
    </ul>
  );
}

export default async function QuestionDetailPage({
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

  let question: Awaited<ReturnType<typeof getQuestion>> = null;
  let loadError: "unconfigured" | "unavailable" | null = null;
  try {
    question = await getQuestion(institutionId, id);
  } catch (error) {
    loadError = error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  // Version history is additive context — a failure to read it (e.g. the
  // 0009 migration not applied yet) must never hide the question itself.
  let versions: QuestionVersionRecord[] = [];
  if (question) {
    try {
      versions = await listQuestionVersions(institutionId, question.id);
    } catch {
      versions = [];
    }
  }

  const toolbar = (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">
          Question preview
        </h1>
        <p className="text-sm text-ink-muted">
          The answer key below is visible to teachers and admins only — never
          to students.
        </p>
      </div>
      <Link href="/teacher/questions">
        <Button type="button" variant="ghost" size="sm">
          Back to bank
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
              <Alert variant="warning" title="Question bank is not configured">
                Supabase connection variables are missing on the server.
              </Alert>
            ) : (
              <Alert variant="danger" title="Question data is unavailable">
                This question could not be loaded. This is expected until the
                questions migration is applied to your Supabase project.
              </Alert>
            )}
          </div>
        </main>
      </>
    );
  }

  if (!question) {
    return (
      <>
        {toolbar}
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <EmptyState
            title="Question not found"
            description="This question is not in your institution's bank, or it has been removed. We never confirm whether a question exists in another institution's bank."
            action={
              <Link href="/teacher/questions">
                <Button type="button" variant="secondary" size="sm">
                  Back to bank
                </Button>
              </Link>
            }
          />
        </main>
      </>
    );
  }

  const authoredByCaller = question.createdBy === principal.userId;

  return (
    <>
      {toolbar}
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          <Card>
            <div className="flex flex-col gap-4 p-6">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="info">
                  {QUESTION_TYPE_LABELS[
                    question.questionType as keyof typeof QUESTION_TYPE_LABELS
                  ] ?? question.questionType}
                </Badge>
                <Badge tone={difficultyTone(question.difficulty)}>
                  {QUESTION_DIFFICULTY_LABELS[
                    question.difficulty as QuestionDifficulty
                  ] ?? question.difficulty}
                </Badge>
                {question.categoryName ? (
                  <Badge tone="brand">{question.categoryName}</Badge>
                ) : null}
                <Badge
                  tone={question.status === "active" ? "success" : "neutral"}
                  dot
                >
                  {QUESTION_STATUS_LABELS[question.status]}
                </Badge>
              </div>

              <p className="whitespace-pre-wrap text-base font-medium leading-7 text-ink">
                {question.questionText}
              </p>

              <OptionList
                options={question.options}
                correctOptionIndex={question.correctOptionIndex}
              />

              {question.explanation ? (
                <div className="rounded-card border border-border bg-surface-muted p-4">
                  <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">
                    Explanation
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink">
                    {question.explanation}
                  </p>
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <div className="p-6">
              <h2 className="mb-2 text-sm font-semibold text-ink">
                Organisation &amp; provenance
              </h2>
              <dl className="grid gap-x-8 sm:grid-cols-2">
                <Detail label="Subject">{question.subjectName}</Detail>
                <Detail label="Topic">
                  {question.topicName ?? (
                    <span className="text-ink-subtle">None</span>
                  )}
                </Detail>
                <Detail label="Marks">{question.marks}</Detail>
                <Detail label="Learning objective">
                  {question.learningObjective || (
                    <span className="text-ink-subtle">Not set</span>
                  )}
                </Detail>
                <Detail label="Source">
                  {question.provenance === "licensed" && question.sourceLabel
                    ? `${question.sourceLabel}${question.sourceYear ? ` (${question.sourceYear})` : ""}`
                    : QUESTION_PROVENANCE_LABELS[
                        question.provenance as keyof typeof QUESTION_PROVENANCE_LABELS
                      ] ?? "—"}
                </Detail>
                <Detail label="Licensing notes">
                  {question.licenseNotes || (
                    <span className="text-ink-subtle">None recorded</span>
                  )}
                </Detail>
                <Detail label="Created by">
                  {authoredByCaller ? "You" : "A teacher at your institution"}
                </Detail>
                <Detail label="Created on">{formatDate(question.createdAt)}</Detail>
              </dl>
            </div>
          </Card>

          {versions.length > 0 ? (
            <Card>
              <div className="p-6">
                <h2 className="mb-2 text-sm font-semibold text-ink">
                  Edit history
                </h2>
                <p className="mb-3 text-xs text-ink-muted">
                  Content replaced by meaning-changing edits, newest first.
                  These records are permanent — history is never rewritten.
                </p>
                <VersionList
                  versions={versions}
                  currentUserId={principal.userId}
                />
              </div>
            </Card>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-ink-subtle">
              {QUESTION_STATUS_HINTS[question.status]}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/teacher/questions/${question.id}/edit`}>
                <Button type="button" variant="secondary" size="sm">
                  Edit question
                </Button>
              </Link>
              <QuestionStatusButton
                questionId={question.id}
                status={question.status}
              />
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
