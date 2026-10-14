import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import {
  getExam,
  getExamFormOptions,
  listExamBuildQuestions,
  listExamSnapshotQuestions,
  type ExamBuildQuestion,
  type ExamRecord,
} from "@/lib/data/exams";
import { listQuestionsPage } from "@/lib/data/questions";
import { resolveQuestionListQuery } from "@/lib/questions";
import {
  examBuilderEditable,
  examBuilderWarnings,
  examDisplayState,
  EXAM_RESULTS_RELEASE_LABELS,
  formatDuration,
  orgTotalPages,
} from "@/lib/exams";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  EmptyState,
  Input,
  Pagination,
  Select,
} from "@/components/ui";
import { ExamLifecycleButtons } from "@/app/teacher/exams/exam-lifecycle-buttons";
import {
  BankQuestionRows,
  SelectedQuestionList,
  type BankQuestionRow,
  type SelectedQuestionRow,
} from "./exam-builder";

export const metadata: Metadata = {
  title: "Exam builder",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

/** Keep list rows honest and client props small: excerpts, never full content. */
function excerpt(text: string, length = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length - 1)}…` : clean;
}

function optionLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/**
 * Safe teacher preview (prompt 18): the exam as a student would see it,
 * WITH the marked answer and explanation, rendered exclusively in
 * server HTML behind the exam.manage role guard. Options and answer keys
 * never reach a client component or a student-facing surface — grading
 * (prompt 24) reads the frozen snapshots, and this page shows exactly what
 * those snapshots contain for a published exam (AGENTS.md §6).
 */
function ExamPreview({ questions }: { questions: ExamBuildQuestion[] }) {
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="info" title="Teacher preview">
        This is exactly what the exam contains, answers marked and explained —
        shown only here, to exam managers. Students see the questions without
        answers during delivery, and results follow the exam&apos;s release
        rule.
      </Alert>
      {questions.map((question) => (
        <Card key={question.questionId}>
          <div className="flex flex-col gap-3 p-6">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium text-ink">
                <span className="mr-2 tabular-nums text-ink-subtle">
                  Q{question.position}.
                </span>
                {question.questionText}
              </p>
              <Badge tone="neutral">{question.marks} mark{question.marks === 1 ? "" : "s"}</Badge>
            </div>
            <ul className="flex flex-col gap-1.5">
              {question.options.map((option, index) => {
                const correct = index === question.correctOptionIndex;
                return (
                  <li
                    key={index}
                    className={
                      "flex items-start gap-2 rounded-card border px-3 py-2 text-sm " +
                      (correct
                        ? "border-success-border bg-success-soft text-ink"
                        : "border-border bg-canvas text-ink")
                    }
                  >
                    <span className="font-semibold tabular-nums text-ink-muted">
                      {optionLetter(index)}.
                    </span>
                    <span className="min-w-0 flex-1">{option}</span>
                    {correct ? (
                      <span className="text-2xs font-semibold uppercase tracking-wide text-success-strong">
                        Correct
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {question.explanation ? (
              <p className="text-sm text-ink-muted">
                <span className="font-semibold text-ink">Explanation: </span>
                {question.explanation}
              </p>
            ) : null}
          </div>
        </Card>
      ))}
    </div>
  );
}

function BuilderBody({
  exam,
  subjects,
  questions,
  editable,
  bankQuery,
  bankRows,
  bankTotal,
  preview,
  basePath,
}: {
  exam: ExamRecord;
  subjects: { id: string; name: string }[];
  questions: ExamBuildQuestion[];
  editable: boolean;
  bankQuery: ReturnType<typeof resolveQuestionListQuery>;
  bankRows: BankQuestionRow[];
  bankTotal: number;
  preview: boolean;
  basePath: string;
}) {
  const display = examDisplayState(exam.status, exam.startsAt, exam.endsAt);
  const warnings = examBuilderWarnings({
    questionCount: exam.questionCount,
    totalMarks: exam.totalMarks,
    scheduled: Boolean(exam.startsAt || exam.endsAt),
  });
  const archivedSelected = questions.some(
    (question) => question.bankStatus === "archived",
  );

  const selectedRows: SelectedQuestionRow[] = questions.map((question) => ({
    questionId: question.questionId,
    position: question.position,
    marks: question.marks,
    excerpt: excerpt(question.questionText),
    difficulty: question.difficulty,
    bankStatus: question.bankStatus,
  }));

  return (
    <>
      <header className="flex shrink-0 flex-col gap-4 border-b border-border bg-surface px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <Breadcrumbs
            items={[
              { label: "Exams", href: "/teacher/exams" },
              { label: exam.title, href: basePath },
              { label: preview ? "Preview" : "Builder" },
            ]}
          />
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight text-ink">
              {preview ? "Exam preview" : "Exam builder"}
            </h1>
            <Badge tone={display.tone} dot>
              {display.label}
            </Badge>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {preview ? (
            <Link href={basePath}>
              <Button type="button" variant="secondary" size="sm">
                Back to builder
              </Button>
            </Link>
          ) : (
            <>
              {examBuilderEditable(exam.status) ? (
                <Link href={`${basePath}/assign`}>
                  <Button type="button" variant="primary" size="sm">
                    Assign &amp; publish
                  </Button>
                </Link>
              ) : null}
              <Link href={`${basePath}?preview=1`}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={exam.questionCount < 1}
                >
                  Safe preview
                </Button>
              </Link>
              <Link href={`${basePath}/edit`}>
                <Button type="button" variant="secondary" size="sm">
                  Edit details
                </Button>
              </Link>
              <ExamLifecycleButtons examId={exam.id} status={exam.status} />
            </>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
          {preview ? (
            <ExamPreview questions={questions} />
          ) : (
            <>
              {/* Live totals and pre-publish warnings — prompt 18's checklist. */}
              <Card>
                <div className="p-6">
                  <h2 className="mb-3 text-sm font-semibold text-ink">
                    Before you publish
                  </h2>
                  <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
                    <div>
                      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Questions</dt>
                      <dd className="mt-0.5 tabular-nums text-ink">{exam.questionCount}</dd>
                    </div>
                    <div>
                      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Total marks</dt>
                      <dd className="mt-0.5 tabular-nums text-ink">{exam.totalMarks}</dd>
                    </div>
                    <div>
                      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Duration</dt>
                      <dd className="mt-0.5 text-ink">{formatDuration(exam.durationMinutes)}</dd>
                    </div>
                    <div>
                      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Attempts</dt>
                      <dd className="mt-0.5 tabular-nums text-ink">
                        {exam.maxAttempts} per student
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs text-ink-muted">
                    Results: {EXAM_RESULTS_RELEASE_LABELS[exam.resultsRelease].toLowerCase()}
                    {" · "}
                    Randomisation:{" "}
                    {exam.shuffleQuestions || exam.shuffleOptions
                      ? [
                          exam.shuffleQuestions ? "questions shuffled" : null,
                          exam.shuffleOptions ? "options shuffled" : null,
                        ]
                          .filter(Boolean)
                          .join(" + ")
                      : "fixed order"}
                  </p>
                  {warnings.length > 0 || archivedSelected ? (
                    <ul className="mt-3 flex flex-col gap-2">
                      {archivedSelected ? (
                        <li>
                          <Alert variant="warning" title="Archived question selected">
                            One or more selected questions are archived in the
                            bank. Remove them from the exam or restore them in
                            the bank before publishing.
                          </Alert>
                        </li>
                      ) : null}
                      {warnings.map((warning) => (
                        <li key={warning}>
                          <Alert variant="warning" title="Needs attention">
                            {warning}
                          </Alert>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-sm text-success-strong">
                      Everything checks out — this exam can be published.
                    </p>
                  )}
                  {!editable ? (
                    <p className="mt-3 text-sm text-ink-muted">
                      {exam.status === "published"
                        ? "Published — the question set below is frozen into immutable snapshots, so later bank edits can never change what students sat."
                        : "Closed or archived — the snapshot below is the historical record and can no longer be changed."}
                    </p>
                  ) : null}
                </div>
              </Card>

              {/* The exam's own question set. */}
              <Card>
                <div className="p-6">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-ink">
                      {editable
                        ? "Selected questions"
                        : "Published questions (snapshot)"}
                    </h2>
                    <p className="text-xs text-ink-subtle">
                      Order shown is what students get{exam.shuffleQuestions ? " (shuffled at delivery)" : ""}; marks are per exam, independent of the bank default.
                    </p>
                  </div>
                  <SelectedQuestionList
                    examId={exam.id}
                    rows={selectedRows}
                    editable={editable}
                  />
                </div>
              </Card>

              {/* The bank picker, live only while the selection is editable. */}
              {editable ? (
                <Card>
                  <div className="p-6">
                    <h2 className="mb-1 text-sm font-semibold text-ink">
                      Question bank
                    </h2>
                    <p className="mb-4 text-sm text-ink-muted">
                      Your active questions — adding one copies its bank marks
                      into the exam, where you can re-weight it freely.
                    </p>
                    <form
                      method="get"
                      action={basePath}
                      className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
                    >
                      <Input
                        label="Search"
                        name="bankq"
                        type="search"
                        defaultValue={bankQuery.q}
                        placeholder="Question text"
                      />
                      <Select label="Subject" name="banksubject" defaultValue={bankQuery.subjectId}>
                        <option value="">All subjects</option>
                        {subjects.map((subject) => (
                          <option key={subject.id} value={subject.id}>
                            {subject.name}
                          </option>
                        ))}
                      </Select>
                      <div className="pb-1">
                        <Button type="submit" variant="primary" size="md">
                          Apply
                        </Button>
                      </div>
                    </form>
                    {bankRows.length === 0 ? (
                      <p className="text-sm text-ink-muted">
                        No active questions match — adjust the search, or add
                        questions in the question bank first.
                      </p>
                    ) : (
                      <BankQuestionRows
                        examId={exam.id}
                        rows={bankRows}
                        editable={editable}
                      />
                    )}
                    <div className="mt-4 flex items-center justify-between gap-3">
                      <p className="text-xs text-ink-subtle">
                        Showing {bankRows.length} of {bankTotal.toLocaleString()} question
                        {bankTotal === 1 ? "" : "s"}.
                      </p>
                      <Pagination
                        page={bankQuery.page}
                        totalPages={orgTotalPages(bankTotal, bankQuery.pageSize)}
                        label="Question bank pages"
                        hrefFor={(page) =>
                          bankPageHref(basePath, bankQuery, page)
                        }
                      />
                    </div>
                  </div>
                </Card>
              ) : null}
            </>
          )}
        </div>
      </main>
    </>
  );
}

/** Bank pagination URL: keep the bank filters, drop any other page params. */
function bankPageHref(
  base: string,
  query: ReturnType<typeof resolveQuestionListQuery>,
  page: number,
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("bankq", query.q);
  if (query.subjectId) params.set("banksubject", query.subjectId);
  if (page > 1) params.set("bankpage", String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export default async function ExamBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher/exams",
  });
  const institutionId = principal.institutionId as string;

  const { id } = await params;
  const sp = await searchParams;
  const preview = sp.preview === "1";
  const basePath = `/teacher/exams/${id}`;

  let exam: ExamRecord | null = null;
  let questions: ExamBuildQuestion[] = [];
  let subjects: { id: string; name: string }[] = [];
  let bankRows: BankQuestionRow[] = [];
  let bankTotal = 0;
  let loadError: "unconfigured" | "unavailable" | null = null;

  const bankQuery = resolveQuestionListQuery({
    q: sp.bankq,
    subject: sp.banksubject,
    page: sp.bankpage,
    // The builder only ever offers selectable (active) questions.
    status: "active",
  });

  try {
    exam = await getExam(institutionId, id);
    if (exam) {
      const editable = examBuilderEditable(exam.status);
      const [options, selection, bank] = await Promise.all([
        getExamFormOptions(institutionId),
        editable
          ? listExamBuildQuestions(institutionId, exam.id)
          : listExamSnapshotQuestions(institutionId, exam.id),
        editable
          ? listQuestionsPage(institutionId, bankQuery, principal.userId)
          : Promise.resolve({ rows: [], total: 0 }),
      ]);
      subjects = options.subjects;
      questions = selection;
      const inExam = new Set(selection.map((row) => row.questionId));
      bankRows = bank.rows.map((row) => ({
        questionId: row.id,
        excerpt: excerpt(row.questionText),
        subjectName: row.subjectName,
        difficulty: row.difficulty,
        marks: row.marks,
        inExam: inExam.has(row.id),
      }));
      bankTotal = bank.total;
    }
  } catch (error) {
    loadError = error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  const toolbar = (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
      <h1 className="text-xl font-bold tracking-tight text-ink">Exam builder</h1>
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
                This exam could not be loaded. This is expected until the exam
                builder migration is applied to your Supabase project
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

  return (
    <BuilderBody
      exam={exam}
      subjects={subjects}
      questions={questions}
      editable={examBuilderEditable(exam.status)}
      bankQuery={bankQuery}
      bankRows={bankRows}
      bankTotal={bankTotal}
      preview={preview}
      basePath={basePath}
    />
  );
}
