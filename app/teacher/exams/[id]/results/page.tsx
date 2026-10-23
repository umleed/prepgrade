import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getExam, type ExamRecord } from "@/lib/data/exams";
import { listExamResults, type ExamResultRow } from "@/lib/data/results";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  formatPercentage,
  formatScore,
  formatTimeUsed,
  STUDENT_RESULT_VISIBILITY_LABELS,
} from "@/lib/results";
import { EXAM_RESULTS_RELEASE_LABELS } from "@/lib/exams";
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";

export const metadata: Metadata = {
  title: "Exam results",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

/** Average percentage across a set of results (0-denominator safe). */
function averagePercentage(rows: ExamResultRow[]): number | null {
  if (rows.length === 0) return null;
  const sum = rows.reduce((total, row) => total + row.percentage, 0);
  return Math.round((sum / rows.length) * 100) / 100;
}

function ResultRowEntry({ row, examId }: { row: ExamResultRow; examId: string }) {
  const releasedToStudent = row.studentVisibility === "released";
  return (
    <TableRow>
      <TableCell asHeader className="min-w-48">
        <p className="font-medium text-ink">{row.studentName}</p>
        <p className="mt-0.5 font-mono text-xs text-ink-subtle">{row.studentCode}</p>
      </TableCell>
      <TableCell numeric>{row.attemptNumber}</TableCell>
      <TableCell numeric>{formatScore(row.totalScore, row.maxScore)}</TableCell>
      <TableCell numeric>{formatPercentage(row.percentage)}</TableCell>
      <TableCell numeric>
        {row.correctCount}
        <span className="text-ink-subtle"> / {row.totalQuestions}</span>
      </TableCell>
      <TableCell numeric className="whitespace-nowrap">
        {formatTimeUsed(row.timeUsedSeconds)}
      </TableCell>
      <TableCell>
        <Badge tone={releasedToStudent ? "success" : "neutral"} dot>
          {STUDENT_RESULT_VISIBILITY_LABELS[row.studentVisibility]}
        </Badge>
      </TableCell>
      <TableCell>
        <Link href={`/teacher/exams/${examId}/results/${row.resultId}`}>
          <Button type="button" variant="secondary" size="sm">
            View
          </Button>
          <span className="sr-only"> {row.studentName} — result details</span>
        </Link>
      </TableCell>
    </TableRow>
  );
}

/**
 * Exam results list (prompt 25) — an authorised teacher's or institution admin's
 * view of one exam's graded results.
 *
 * The exam is first resolved through `getExam`, which pins the trusted tenant,
 * so an id that is not this institution's exam renders a plain not-found
 * (existence elsewhere is never confirmed — AGENTS.md §5). Staff hold `result.read_class`
 * and see every stored result for the exam regardless of the student release
 * gate, each marked with whether it has gone out to the student yet. Numbers are
 * the grading engine's stored facts, never recomputed.
 */
export default async function ExamResultsPage({
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
  let results: ExamResultRow[] = [];
  let loadError: "unconfigured" | "unavailable" | null = null;

  try {
    exam = await getExam(institutionId, id);
    if (exam) results = await listExamResults(institutionId, exam.id);
  } catch (error) {
    loadError =
      error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  // A missing exam (foreign or removed) is a not-found, never a per-case leak.
  if (!loadError && !exam) notFound();

  if (loadError || !exam) {
    return (
      <>
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
          <h1 className="text-xl font-bold tracking-tight text-ink">Exam results</h1>
          <Link href="/teacher/exams">
            <Button type="button" variant="ghost" size="sm">
              Back to exams
            </Button>
          </Link>
        </header>
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            {loadError === "unconfigured" ? (
              <Alert variant="warning" title="Result data is not configured">
                Supabase connection variables are missing on the server.
              </Alert>
            ) : loadError === "unavailable" ? (
              <Alert variant="danger" title="Result data is unavailable">
                These results could not be loaded. This is expected until the
                results migration is applied to your Supabase project
                (<span className="font-mono">supabase/migrations</span>).
              </Alert>
            ) : (
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
            )}
          </div>
        </main>
      </>
    );
  }

  const releasedCount = results.filter(
    (row) => row.studentVisibility === "released",
  ).length;
  const average = averagePercentage(results);

  return (
    <>
      <header className="flex shrink-0 flex-col gap-3 border-b border-border bg-surface px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <Breadcrumbs
            items={[
              { label: "Exams", href: "/teacher/exams" },
              { label: exam.title, href: `/teacher/exams/${exam.id}` },
              { label: "Results" },
            ]}
          />
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight text-ink">
              {exam.title} — Results
            </h1>
          </div>
          <p className="mt-1 text-sm text-ink-muted">
            {exam.subjectName} · Results {EXAM_RESULTS_RELEASE_LABELS[exam.resultsRelease].toLowerCase()}
          </p>
        </div>
        <div className="flex shrink-0">
          <Link href={`/teacher/exams/${exam.id}/analytics`}>
            <Button type="button" variant="secondary" size="sm">
              Class analytics
            </Button>
          </Link>
          <Link href={`/teacher/exams/${exam.id}`}>
            <Button type="button" variant="ghost" size="sm">
              Back to exam
            </Button>
          </Link>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <section
            aria-label="Result summary"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <Card>
              <div className="flex flex-col gap-1 p-5">
                <p className="text-sm text-ink-muted">Results recorded</p>
                <p className="text-2xl font-bold tracking-tight text-ink tabular-nums">
                  {results.length}
                </p>
              </div>
            </Card>
            <Card>
              <div className="flex flex-col gap-1 p-5">
                <p className="text-sm text-ink-muted">Released to students</p>
                <p className="text-2xl font-bold tracking-tight text-ink tabular-nums">
                  {releasedCount}
                </p>
              </div>
            </Card>
            <Card>
              <div className="flex flex-col gap-1 p-5">
                <p className="text-sm text-ink-muted">Average score</p>
                <p className="text-2xl font-bold tracking-tight text-ink tabular-nums">
                  {average === null ? (
                    <span aria-label="Not available yet">—</span>
                  ) : (
                    formatPercentage(average)
                  )}
                </p>
              </div>
            </Card>
            <Card>
              <div className="flex flex-col gap-1 p-5">
                <p className="text-sm text-ink-muted">Highest score</p>
                <p className="text-2xl font-bold tracking-tight text-ink tabular-nums">
                  {results.length === 0 ? (
                    <span aria-label="Not available yet">—</span>
                  ) : (
                    formatPercentage(
                      Math.max(...results.map((row) => row.percentage)),
                    )
                  )}
                </p>
              </div>
            </Card>
          </section>

          {results.length === 0 ? (
            <EmptyState
              title="No results yet"
              description="No graded results exist for this exam yet. A result appears once a student submits and the exam is graded, and any submitted attempt whose grade is still being finalised reconciles automatically."
              action={
                <Link href={`/teacher/exams/${exam.id}`}>
                  <Button type="button" variant="secondary" size="sm">
                    Back to exam
                  </Button>
                </Link>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead numeric>Attempt</TableHead>
                  <TableHead numeric>Score</TableHead>
                  <TableHead numeric>Percentage</TableHead>
                  <TableHead numeric>Correct</TableHead>
                  <TableHead numeric>Time used</TableHead>
                  <TableHead>Student visibility</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((row) => (
                  <ResultRowEntry key={row.resultId} row={row} examId={exam!.id} />
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </main>
    </>
  );
}
