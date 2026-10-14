import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getStudentByProfileId } from "@/lib/data/students";
import { getStudentResult, type StudentResultSummary } from "@/lib/data/results";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  formatPercentage,
  formatScore,
  formatTimeUsed,
  STUDENT_RESULT_VISIBILITY_LABELS,
} from "@/lib/results";
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
  title: "Result detail",
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

/** A plain-language label for how the sitting ended. */
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

/** The full result: headline score, the three answer buckets, and the subject
 *  breakdown. Every value is the grading engine's stored fact; the answer key
 *  and per-question detail never live in a result, so nothing here can expose
 *  a correct option before release (AGENTS.md §6). */
function ReleasedResult({ result }: { result: StudentResultSummary }) {
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div className="flex flex-col items-center gap-1 p-8 text-center">
          <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">
            Your score
          </p>
          <p className="text-4xl font-bold tracking-tight text-brand">
            {formatPercentage(result.percentage!)}
          </p>
          <p className="text-sm text-ink-muted">
            {formatScore(result.totalScore!, result.maxScore!)} marks
          </p>
        </div>
      </Card>

      <section
        aria-label="Answer breakdown"
        className="grid gap-4 sm:grid-cols-3"
      >
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
          <h2 className="mb-2 text-sm font-semibold text-ink">Assessment details</h2>
          <dl className="grid gap-x-8 sm:grid-cols-2">
            <Detail label="Subject">{result.subjectName}</Detail>
            <Detail label="Questions">{result.totalQuestions}</Detail>
            <Detail label="Status">{attemptStatusLabel(result.attemptStatus)}</Detail>
            <Detail label="Time used">{formatTimeUsed(result.timeUsedSeconds!)}</Detail>
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
            <p className="mt-3 text-2xs leading-4 text-ink-subtle">
              Subject breakdown reflects the topics this assessment covered.
              Detailed answer-by-answer review is not released with this result.
            </p>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Student result detail (prompt 25).
 *
 * The result is resolved through a read that pins BOTH the trusted tenant and
 * the verified student id, so an id belonging to another student or tenant
 * renders a plain not-found — existence is never confirmed (AGENTS.md §5). A
 * result the exam's release policy has not yet permitted shows only a clear
 * "not yet released" state with the hint, never its numbers (the data layer
 * already stripped them); answer keys are not part of a result at all.
 */
export default async function StudentResultDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();

  const principal = await requireRole(["STUDENT"], { next: "/student/results" });
  const institutionId = principal.institutionId as string;
  const { id } = await params;

  let result: StudentResultSummary | null = null;
  let loadError: "unconfigured" | "unavailable" | "unlinked" | null = null;

  try {
    const student = await getStudentByProfileId(institutionId, principal.userId);
    if (!student) {
      loadError = "unlinked";
    } else {
      result = await getStudentResult(institutionId, student.id, id);
    }
  } catch (error) {
    loadError =
      error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  if (loadError) {
    return (
      <Shell title="Result detail">
        {loadError === "unconfigured" ? (
          <Alert variant="warning" title="Result data is not configured">
            Supabase connection variables are missing on the server, so this
            result cannot be verified.
          </Alert>
        ) : loadError === "unlinked" ? (
          <EmptyState
            title="Your account isn't linked to a student record yet"
            description="Your institution must connect your account to its student roster before any result can be opened."
            action={
              <Link href="/student/results">
                <Button type="button" variant="secondary" size="sm">
                  Back to My Results
                </Button>
              </Link>
            }
          />
        ) : (
          <Alert variant="danger" title="This result could not be loaded">
            The result service is unreachable right now. Nothing is shown rather
            than anything unverified — check your connection and reload, or tell
            your institution admin if it persists.
            <div className="mt-3">
              <Link href="/student/results">
                <Button type="button" variant="secondary" size="sm">
                  Back to My Results
                </Button>
              </Link>
            </div>
          </Alert>
        )}
      </Shell>
    );
  }

  // Not this student's own released-eligible result (absent, foreign, or
  // another tenant's): a plain not-found, never a per-case leak.
  if (!result) notFound();

  return (
    <Shell title={result.examTitle} examTitle={result.examTitle}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            {result.examTitle}
          </h1>
          <Badge
            tone={result.visibility === "released" ? "success" : "warning"}
            dot
          >
            {STUDENT_RESULT_VISIBILITY_LABELS[result.visibility]}
          </Badge>
        </div>

        {result.visibility === "released" ? (
          <ReleasedResult result={result} />
        ) : (
          <EmptyState
            title="This result isn't released yet"
            description={
              result.hint ??
              "Your result has been graded but is not available to you yet. It will appear once your institution's release policy allows."
            }
            action={
              <Link href="/student/results">
                <Button type="button" variant="secondary" size="sm">
                  Back to My Results
                </Button>
              </Link>
            }
          />
        )}
      </div>
    </Shell>
  );
}

/** Shared chrome (breadcrumb header + back link + scroll container). */
function Shell({
  title,
  examTitle,
  children,
}: {
  title: string;
  examTitle?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="flex shrink-0 flex-col gap-3 border-b border-border bg-surface px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <Breadcrumbs
            items={[
              { label: "My Results", href: "/student/results" },
              { label: examTitle ?? title },
            ]}
          />
          <h1 className="mt-1 text-xl font-bold tracking-tight text-ink lg:hidden">
            {title}
          </h1>
        </div>
        <div className="flex shrink-0">
          <Link href="/student/results">
            <Button type="button" variant="ghost" size="sm">
              Back to My Results
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
