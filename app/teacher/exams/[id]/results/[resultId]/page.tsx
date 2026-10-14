import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getExamResult, type ExamResultRow } from "@/lib/data/results";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  formatPercentage,
  formatScore,
  formatTimeUsed,
} from "@/lib/results";
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";

export const metadata: Metadata = {
  title: "Student result",
};

// Reads the live session and queries the tenant database — never prerendered.
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

function attemptStatusLabel(status: string): string {
  switch (status) {
    case "submitted":
      return "Submitted";
    case "expired":
      return "Time expired";
    default:
      return "Completed";
  }
}

/**
 * Individual student result (prompt 25) — the staff view of one graded sitting.
 *
 * The result is scoped by BOTH the trusted tenant AND the exam id in the URL, so
 * a valid result id belonging to another exam or tenant resolves to nothing
 * (AGENTS.md §5). Staff are authorised to see the full numbers; the result
 * carries no answer key, so nothing here can expose a correct option — the
 * subject breakdown is aggregate performance only.
 */
export default async function StudentResultStaffDetailPage({
  params,
}: {
  params: Promise<{ id: string; resultId: string }>;
}) {
  await connection();

  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher/exams",
  });
  const institutionId = principal.institutionId as string;
  const { id, resultId } = await params;

  let result: ExamResultRow | null = null;
  let loadError: "unconfigured" | "unavailable" | null = null;

  try {
    result = await getExamResult(institutionId, id, resultId);
  } catch (error) {
    loadError =
      error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  const resultsHref = `/teacher/exams/${id}/results`;

  if (loadError) {
    return (
      <Shell title="Student result" resultsHref={resultsHref}>
        {loadError === "unconfigured" ? (
          <Alert variant="warning" title="Result data is not configured">
            Supabase connection variables are missing on the server.
          </Alert>
        ) : (
          <Alert variant="danger" title="This result could not be loaded">
            The result service is unreachable right now. Nothing is shown rather
            than anything unverified.
          </Alert>
        )}
      </Shell>
    );
  }

  // Absent, foreign, or not this exam's result: a plain not-found.
  if (!result) {
    notFound();
  }

  const releasedToStudent = result.studentVisibility === "released";

  return (
    <Shell title={result.studentName} resultsHref={resultsHref}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            {result.studentName}
          </h1>
          <Badge tone={releasedToStudent ? "success" : "neutral"} dot>
            {releasedToStudent ? "Released to student" : "Not yet released to student"}
          </Badge>
        </div>
        <p className="text-sm text-ink-muted">
          <span className="font-mono">{result.studentCode}</span> · Attempt{" "}
          {result.attemptNumber}
        </p>

        <Card>
          <div className="flex flex-col items-center gap-1 p-8 text-center">
            <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">
              Score
            </p>
            <p className="text-4xl font-bold tracking-tight text-brand">
              {formatPercentage(result.percentage)}
            </p>
            <p className="text-sm text-ink-muted">
              {formatScore(result.totalScore, result.maxScore)} marks
            </p>
          </div>
        </Card>

        <section aria-label="Answer breakdown" className="grid gap-4 sm:grid-cols-3">
          <Card>
            <div className="flex flex-col gap-1 p-5">
              <p className="text-sm text-ink-muted">Correct</p>
              <p className="text-2xl font-bold tracking-tight text-success tabular-nums">
                {result.correctCount}
              </p>
            </div>
          </Card>
          <Card>
            <div className="flex flex-col gap-1 p-5">
              <p className="text-sm text-ink-muted">Incorrect</p>
              <p className="text-2xl font-bold tracking-tight text-danger-strong tabular-nums">
                {result.incorrectCount}
              </p>
            </div>
          </Card>
          <Card>
            <div className="flex flex-col gap-1 p-5">
              <p className="text-sm text-ink-muted">Unanswered</p>
              <p className="text-2xl font-bold tracking-tight text-ink tabular-nums">
                {result.unansweredCount}
              </p>
            </div>
          </Card>
        </section>

        <Card>
          <div className="p-6">
            <h2 className="mb-2 text-sm font-semibold text-ink">Sitting details</h2>
            <dl className="grid gap-x-8 sm:grid-cols-2">
              <Detail label="Status">{attemptStatusLabel(result.attemptStatus)}</Detail>
              <Detail label="Time used">{formatTimeUsed(result.timeUsedSeconds)}</Detail>
              <Detail label="Submitted">{formatDateTime(result.submittedAt)}</Detail>
              <Detail label="Graded">{formatDateTime(result.gradedAt)}</Detail>
            </dl>
          </div>
        </Card>

        {result.subjectBreakdown.length > 0 ? (
          <Card>
            <div className="p-6">
              <h2 className="mb-3 text-sm font-semibold text-ink">
                Performance by subject
              </h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject</TableHead>
                    <TableHead numeric>Correct</TableHead>
                    <TableHead numeric>Score</TableHead>
                    <TableHead numeric>Percentage</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.subjectBreakdown.map((subject) => (
                    <TableRow key={subject.subjectId}>
                      <TableCell asHeader>{subject.subjectName}</TableCell>
                      <TableCell numeric>
                        {subject.correct} / {subject.total}
                      </TableCell>
                      <TableCell numeric>
                        {formatScore(subject.score, subject.maxScore)}
                      </TableCell>
                      <TableCell numeric>
                        {formatPercentage(subject.percentage)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        ) : null}
      </div>
    </Shell>
  );
}

/** Shared chrome (breadcrumb header + back link + scroll container). */
function Shell({
  title,
  resultsHref,
  children,
}: {
  title: string;
  resultsHref: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="flex shrink-0 flex-col gap-3 border-b border-border bg-surface px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <Breadcrumbs
            items={[
              { label: "Exams", href: "/teacher/exams" },
              { label: "Results", href: resultsHref },
              { label: title },
            ]}
          />
          <h1 className="mt-1 text-xl font-bold tracking-tight text-ink lg:hidden">
            {title}
          </h1>
        </div>
        <div className="flex shrink-0">
          <Link href={resultsHref}>
            <Button type="button" variant="ghost" size="sm">
              Back to results
            </Button>
          </Link>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-3xl">{children}</div>
      </main>
    </>
  );
}
