import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getExam, type ExamRecord } from "@/lib/data/exams";
import {
  examBuilderEditable,
  examDisplayState,
  formatDuration,
  EXAM_RESULTS_RELEASE_LABELS,
  EXAM_STATUS_HINTS,
} from "@/lib/exams";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  EmptyState,
} from "@/components/ui";
import { ExamLifecycleButtons } from "@/app/teacher/exams/exam-lifecycle-buttons";

export const metadata: Metadata = {
  title: "Exam details",
};

export const instant = false;

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
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

/**
 * Configuration summary — the "review its configuration" half of prompt 17.
 * Question content and class assignment are shown as facts with honest empty
 * states: the builder (prompt 18) and assignment flow (prompt 19) populate
 * them, and results appear only once delivery and grading exist (prompts
 * 22–25). Nothing here pretends data exists where it cannot yet.
 */
function ExamDetailBody({
  exam,
  currentUserId,
}: {
  exam: ExamRecord;
  currentUserId: string;
}) {
  const display = examDisplayState(exam.status, exam.startsAt, exam.endsAt);
  const editable = exam.status === "draft" || exam.status === "scheduled" || exam.status === "published";
  const randomisation = [
    exam.shuffleQuestions ? "questions shuffled" : null,
    exam.shuffleOptions ? "options shuffled" : null,
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <>
      <header className="flex shrink-0 flex-col gap-4 border-b border-border bg-surface px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <Breadcrumbs
            items={[{ label: "Exams", href: "/teacher/exams" }, { label: exam.title }]}
          />
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight text-ink">{exam.title}</h1>
            <Badge tone={display.tone} dot>
              {display.label}
            </Badge>
          </div>
          {exam.description ? (
            <p className="mt-1 line-clamp-2 max-w-2xl text-sm text-ink-muted">
              {exam.description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {examBuilderEditable(exam.status) ? (
            <Link href={`/teacher/exams/${exam.id}/assign`}>
              <Button type="button" variant="primary" size="sm">
                Assign &amp; publish
              </Button>
            </Link>
          ) : null}
          <Link href={`/teacher/exams/${exam.id}/build`}>
            <Button type="button" variant="secondary" size="sm">
              {examBuilderEditable(exam.status) ? "Build exam" : "View questions"}
            </Button>
          </Link>
          {editable ? (
            <Link href={`/teacher/exams/${exam.id}/edit`}>
              <Button type="button" variant="secondary" size="sm">
                Edit exam
              </Button>
            </Link>
          ) : null}
          <ExamLifecycleButtons examId={exam.id} status={exam.status} />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
          <Card>
            <div className="p-6">
              <h2 className="mb-2 text-sm font-semibold text-ink">
                Assessment details
              </h2>
              <dl className="grid gap-x-8 sm:grid-cols-2">
                <Detail label="Subject">{exam.subjectName}</Detail>
                <Detail label="Category">
                  {exam.categoryName ?? (
                    <span className="text-ink-subtle">Unclassified</span>
                  )}
                </Detail>
                <Detail label="Duration">
                  {formatDuration(exam.durationMinutes)}
                </Detail>
                <Detail label="Attempts per student">
                  {exam.maxAttempts}
                </Detail>
                <Detail label="Availability window">
                  {exam.startsAt || exam.endsAt ? (
                    <span>
                      {formatDateTime(exam.startsAt)}
                      {" → "}
                      {exam.endsAt ? formatDateTime(exam.endsAt) : "open end"}
                    </span>
                  ) : (
                    <span className="text-ink-subtle">Not scheduled</span>
                  )}
                </Detail>
                <Detail label="Questions">
                  {exam.questionCount}
                  <span className="tabular-nums">
                    {" · "}
                    {exam.totalMarks} mark{exam.totalMarks === 1 ? "" : "s"}
                  </span>
                  <span className="text-ink-subtle">
                    {" — assembled in the "}
                    <Link
                      href={`/teacher/exams/${exam.id}/build`}
                      className="underline hover:text-brand-700"
                    >
                      exam builder
                    </Link>
                  </span>
                </Detail>
                <Detail label="Randomisation">
                  {randomisation || (
                    <span className="text-ink-subtle">Fixed order</span>
                  )}
                </Detail>
                <Detail label="Results released">
                  {EXAM_RESULTS_RELEASE_LABELS[exam.resultsRelease]}
                </Detail>
                <Detail label="Audience">
                  {exam.assignedClasses.length > 0 ||
                  exam.assignedStudentCount > 0 ? (
                    <>
                      {exam.assignedClasses.length > 0
                        ? exam.assignedClasses.map((entry) => entry.name).join(", ")
                        : "No classes"}
                      {exam.assignedStudentCount > 0
                        ? ` + ${exam.assignedStudentCount} individual student${
                            exam.assignedStudentCount === 1 ? "" : "s"
                          }`
                        : ""}
                    </>
                  ) : (
                    <span className="text-ink-subtle">Not assigned yet</span>
                  )}
                </Detail>
                <Detail label="Published on">
                  {exam.publishedAt ? (
                    <>
                      {formatDateTime(exam.publishedAt)}
                      {exam.publishedTo !== null ? (
                        <span className="text-ink-subtle">
                          {" → "}
                          {exam.publishedTo} student{exam.publishedTo === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-ink-subtle">Not published</span>
                  )}
                </Detail>
                <Detail label="Created by">
                  {exam.createdBy === currentUserId
                    ? "You"
                    : "A teacher at your institution"}
                </Detail>
                <Detail label="Created on">{formatDateTime(exam.createdAt)}</Detail>
              </dl>
              <p className="mt-4 text-xs text-ink-subtle">
                {EXAM_STATUS_HINTS[exam.status]}
              </p>
            </div>
          </Card>

          <Card>
            <div className="p-6">
              <h2 className="mb-2 text-sm font-semibold text-ink">
                Questions &amp; assignment
              </h2>
              <p className="text-sm text-ink-muted">
                {exam.questionCount > 0
                  ? `${exam.questionCount} question${
                      exam.questionCount === 1 ? "" : "s"
                    } worth ${exam.totalMarks} mark${
                      exam.totalMarks === 1 ? "" : "s"
                    }${
                      exam.status === "published" ||
                      exam.status === "closed" ||
                      exam.status === "archived"
                        ? " — frozen into immutable snapshots at publish, so later bank edits never change delivered or historical results."
                        : " — assembled in the exam builder, where marks and order can still be adjusted."
                    }`
                  : "No questions attached yet. Open the exam builder to select questions from your bank; an exam cannot be published until it has at least one."}
              </p>
              <p className="mt-2 text-sm text-ink-muted">
                {exam.assignedClasses.length > 0 || exam.assignedStudentCount > 0
                  ? `Assigned to ${exam.assignedClasses.length} class${
                      exam.assignedClasses.length === 1 ? "" : "es"
                    }${
                      exam.assignedClasses.length > 0
                        ? ` (${exam.assignedClasses
                            .map((entry) => entry.name)
                            .join(", ")})`
                        : ""
                    }${
                      exam.assignedStudentCount > 0
                        ? ` plus ${exam.assignedStudentCount} individual student${
                            exam.assignedStudentCount === 1 ? "" : "s"
                          }`
                        : ""
                    }.`
                  : "Not assigned to any class or student yet. An exam cannot be published until at least one class or student is in its audience."}
                {" "}
                {examBuilderEditable(exam.status) ? (
                  <Link
                    href={`/teacher/exams/${exam.id}/assign`}
                    className="underline hover:text-brand-700"
                  >
                    Manage assignment &amp; publish
                  </Link>
                ) : null}
              </p>
            </div>
          </Card>

          <Card>
            <div className="flex flex-col gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="mb-2 text-sm font-semibold text-ink">
                  Attempts &amp; results
                </h2>
                <p className="text-sm text-ink-muted">
                  {exam.status === "published" || exam.status === "closed"
                    ? "Graded results appear on the results screen once students have submitted and the exam has been graded. Open it to see each student's score, percentage, and subject breakdown."
                    : "Attempts and results appear after the exam is published and taken."}
                </p>
              </div>
              {exam.status === "published" || exam.status === "closed" ? (
                <Link href={`/teacher/exams/${exam.id}/results`}>
                  <Button type="button" variant="secondary" size="sm">
                    View results
                  </Button>
                </Link>
              ) : null}
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}

export default async function ExamDetailPage({
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

  let exam: ExamRecord | null = null;
  let loadError: "unconfigured" | "unavailable" | null = null;
  try {
    exam = await getExam(institutionId, id);
  } catch (error) {
    loadError = error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  if (loadError) {
    return (
      <>
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
          <h1 className="text-xl font-bold tracking-tight text-ink">Exam details</h1>
          <Link href="/teacher/exams">
            <Button type="button" variant="ghost" size="sm">
              Back to exams
            </Button>
          </Link>
        </header>
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
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
          <h1 className="text-xl font-bold tracking-tight text-ink">Exam details</h1>
          <Link href="/teacher/exams">
            <Button type="button" variant="ghost" size="sm">
              Back to exams
            </Button>
          </Link>
        </header>
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <EmptyState
            title="Exam not found"
            description="This exam is not in your institution, or it has been removed. We never confirm whether an exam exists in another institution."
            action={
              <Link href="/teacher/exams">
                <Button type="button" variant="secondary" size="sm">
                  Back to exams
                </Button>
              </Link>
            }
          />
        </main>
      </>
    );
  }

  return <ExamDetailBody exam={exam} currentUserId={principal.userId} />;
}
