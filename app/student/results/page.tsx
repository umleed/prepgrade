import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getStudentByProfileId } from "@/lib/data/students";
import { listStudentResults, type StudentResultSummary } from "@/lib/data/results";
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
  title: "My Results",
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

/**
 * One released result row: score, percentage, status, time used, and a link to
 * the detail. A not-yet-released row honestly withholds every number (the data
 * layer already stripped them) and shows when it will appear instead.
 */
function ResultRow({ result }: { result: StudentResultSummary }) {
  const released = result.visibility === "released";
  return (
    <TableRow>
      <TableCell asHeader className="min-w-52">
        <p className="font-medium text-ink">{result.examTitle}</p>
        <p className="mt-0.5 text-xs text-ink-subtle">{result.subjectName}</p>
      </TableCell>
      <TableCell numeric>
        {released ? formatScore(result.totalScore!, result.maxScore!) : (
          <span className="text-ink-subtle">Hidden</span>
        )}
      </TableCell>
      <TableCell numeric>
        {released ? formatPercentage(result.percentage!) : (
          <span className="text-ink-subtle">—</span>
        )}
      </TableCell>
      <TableCell numeric className="whitespace-nowrap">
        {released ? formatTimeUsed(result.timeUsedSeconds!) : "—"}
      </TableCell>
      <TableCell>
        <Badge tone={released ? "success" : "warning"} dot>
          {STUDENT_RESULT_VISIBILITY_LABELS[result.visibility]}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap text-ink-muted">
        {formatDateTime(result.gradedAt)}
      </TableCell>
      <TableCell>
        <Link href={`/student/results/${result.resultId}`}>
          <Button type="button" variant="secondary" size="sm">
            View
          </Button>
          <span className="sr-only"> {result.examTitle} — result details</span>
        </Link>
      </TableCell>
    </TableRow>
  );
}

/**
 * My Results (prompt 25) — the student's own graded results.
 *
 * The list is exactly the set the server says belongs to THIS verified student
 * under their trusted tenant (`listStudentResults` pins `student_id` + `institution_id`).
 * Every number is the grading engine's stored, derived fact — never recomputed
 * here — and a result whose release policy has not yet permitted it is rendered
 * as a clear "not yet released" state with no score, percentage, or breakdown
 * (AGENTS.md §6; the answer key never lives in a result anyway). Loading, empty,
 * error, and unlinked states are all explicit.
 */
export default async function StudentResultsPage() {
  await connection();

  const principal = await requireRole(["STUDENT"], { next: "/student/results" });
  const institutionId = principal.institutionId as string;

  let results: StudentResultSummary[] = [];
  let loadError: "unconfigured" | "unavailable" | "unlinked" | null = null;

  try {
    const student = await getStudentByProfileId(institutionId, principal.userId);
    if (!student) {
      loadError = "unlinked";
    } else {
      results = await listStudentResults(institutionId, student.id);
    }
  } catch (error) {
    loadError =
      error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  const released = results.filter((result) => result.visibility === "released");
  const pending = results.length - released.length;
  const average =
    released.length > 0
      ? released.reduce((sum, result) => sum + (result.percentage ?? 0), 0) /
        released.length
      : null;

  return (
    <>
      <header className="flex shrink-0 flex-col gap-1 border-b border-border bg-surface px-6 py-4">
        <h1 className="text-xl font-bold tracking-tight text-ink">My Results</h1>
        <p className="text-sm text-ink-muted">
          Your graded assessments. Scores appear once your institution&apos;s
          release policy allows it — a result held back shows when it will.
        </p>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          {loadError === "unconfigured" ? (
            <Alert variant="warning" title="Result data is not configured">
              Supabase connection variables are missing on the server. Set
              <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
              <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to
              load your results.
            </Alert>
          ) : loadError === "unavailable" ? (
            <Alert variant="danger" title="Your results could not be loaded">
              The result data source is unavailable right now. Nothing is shown
              rather than anything that has not been verified against your
              records. Please reload; if it persists, check your connection and
              try again.
            </Alert>
          ) : loadError === "unlinked" ? (
            <EmptyState
              title="Your account isn't linked to a student record yet"
              description="A PrepGrade account must be connected to your institution's student roster before any results can be shown — this page only ever displays data for the verified student record linked to your sign-in. Ask your institution's admin to connect it."
            />
          ) : (
            <>
              <section
                aria-label="Result counts"
                className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              >
                <Card>
                  <div className="flex flex-col gap-1 p-5">
                    <p className="text-sm text-ink-muted">Released results</p>
                    <p className="text-2xl font-bold tracking-tight text-ink tabular-nums">
                      {released.length}
                    </p>
                    <p className="text-2xs leading-4 text-ink-subtle">
                      Graded assessments you can open in full.
                    </p>
                  </div>
                </Card>
                <Card>
                  <div className="flex flex-col gap-1 p-5">
                    <p className="text-sm text-ink-muted">Awaiting release</p>
                    <p className="text-2xl font-bold tracking-tight text-ink tabular-nums">
                      {pending}
                    </p>
                    <p className="text-2xs leading-4 text-ink-subtle">
                      Graded, but held until the release policy allows.
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
                    <p className="text-2xs leading-4 text-ink-subtle">
                      Across your released results only.
                    </p>
                  </div>
                </Card>
              </section>

              {results.length === 0 ? (
                <EmptyState
                  title="No results yet"
                  description="Once you submit an exam and it has been graded, it appears here. Some results stay hidden until your institution releases them."
                  action={
                    <Link href="/student/exams">
                      <Button type="button" variant="secondary" size="sm">
                        Go to My Exams
                      </Button>
                    </Link>
                  }
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Exam</TableHead>
                      <TableHead numeric>Score</TableHead>
                      <TableHead numeric>Percentage</TableHead>
                      <TableHead numeric>Time used</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Graded</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((result) => (
                      <ResultRow key={result.resultId} result={result} />
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}
