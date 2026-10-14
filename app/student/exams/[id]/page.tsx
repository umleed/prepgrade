import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getStudentByProfileId } from "@/lib/data/students";
import { getStudentExamView, type StudentExamView } from "@/lib/data/exams";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  EXAM_RESULTS_RELEASE_LABELS,
  formatDuration,
  studentExamStartGate,
  type StudentExamAvailabilityState,
} from "@/lib/exams";
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  EmptyState,
} from "@/components/ui";
import { StartExamButton } from "@/app/student/exams/start-exam-button";

export const metadata: Metadata = {
  title: "Exam instructions",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

type BadgeTone = "neutral" | "brand" | "success" | "warning" | "info";

/** A human status chip per eligibility state, reusing the shared tones. */
const STATE_PRESENTATION: Record<
  StudentExamAvailabilityState,
  { label: string; tone: BadgeTone }
> = {
  open: { label: "Open now", tone: "success" },
  scheduled: { label: "Not open yet", tone: "brand" },
  expired: { label: "Closed", tone: "warning" },
  attempts_exhausted: { label: "No attempts left", tone: "info" },
  unavailable: { label: "Unavailable", tone: "neutral" },
};

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

/** The rules a student must read before starting (prompt 21: explain the
 *  relevant rules). Every line is derived from the exam's own frozen
 *  configuration — nothing is invented, and no answer key or private
 *  question metadata is ever surfaced here. */
function buildInstructions(view: StudentExamView): string[] {
  const { exam, eligibility } = view;
  const lines: string[] = [
    `You have ${formatDuration(exam.durationMinutes)} to answer ${exam.questionCount} question${
      exam.questionCount === 1 ? "" : "s"
    } worth ${exam.totalMarks} mark${exam.totalMarks === 1 ? "" : "s"}.`,
  ];

  if (exam.startsAt || exam.endsAt) {
    lines.push(
      exam.endsAt
        ? `The exam closes at ${formatDateTime(exam.endsAt)}. You must submit before then.`
        : `The exam is open from ${formatDateTime(exam.startsAt)}.`,
    );
  }

  lines.push(
    exam.maxAttempts === 1
      ? "You have one attempt only — submit carefully."
      : `You may attempt this exam up to ${exam.maxAttempts} times. You have ${eligibility.attemptsRemaining} attempt${
          eligibility.attemptsRemaining === 1 ? "" : "s"
        } available right now.`,
  );

  if (exam.shuffleQuestions || exam.shuffleOptions) {
    lines.push(
      exam.shuffleQuestions && exam.shuffleOptions
        ? "Questions and answer options are shuffled, so your order may differ from another student's."
        : exam.shuffleQuestions
          ? "Questions appear in a random order that may differ between students."
          : "Answer options are shuffled, so the same question may show options in a different order.",
    );
  }

  lines.push(
    `Results: ${EXAM_RESULTS_RELEASE_LABELS[exam.resultsRelease].toLowerCase()}.`,
    "Stay on the page and make sure your connection is stable — your answers save as you go.",
  );

  return lines;
}

/**
 * Pre-exam instructions & detail (prompt 21) — the gate in front of the CBT
 * interface.
 *
 * The exam is resolved through the SAME server read the list uses, so an id
 * that is not this student's own assigned, released exam renders a plain
 * not-found (existence elsewhere is never confirmed — AGENTS.md §5). Every
 * fact shown comes from the frozen exam configuration; no question content,
 * answer key, or another student's data is exposed. The explicit start
 * action posts to a server action that re-checks eligibility and the
 * attempt budget — this screen is guidance, not the security boundary.
 */
export default async function StudentExamInstructionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();

  const principal = await requireRole(["STUDENT"], { next: "/student/exams" });
  const institutionId = principal.institutionId as string;
  const { id } = await params;

  let view: StudentExamView | null = null;
  let loadError: "unconfigured" | "unavailable" | "unlinked" | null = null;

  try {
    const student = await getStudentByProfileId(institutionId, principal.userId);
    if (!student) {
      loadError = "unlinked";
    } else {
      view = await getStudentExamView(institutionId, student.id, student.classId, id);
    }
  } catch (error) {
    loadError =
      error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  // Connection / configuration failures get an honest retry state rather
  // than a blank or a guessed exam (prompt 21: connection-error states).
  if (loadError) {
    return (
      <InstructionsShell title="Exam instructions">
        {loadError === "unconfigured" ? (
          <Alert variant="warning" title="Exam data is not configured">
            Supabase connection variables are missing on the server, so this
            exam cannot be verified before you start.
          </Alert>
        ) : loadError === "unlinked" ? (
          <EmptyState
            title="Your account isn't linked to a student record yet"
            description="Your institution must connect your account to its student roster before any assigned exam can be opened."
            action={
              <Link href="/student/exams">
                <Button type="button" variant="secondary" size="sm">
                  Back to My Exams
                </Button>
              </Link>
            }
          />
        ) : (
          <Alert variant="danger" title="This exam could not be loaded">
            The exam service is unreachable right now. Nothing is shown rather
            than anything unverified — check your connection and reload, or
            tell your institution admin if it persists.
            <div className="mt-3">
              <Link href="/student/exams">
                <Button type="button" variant="secondary" size="sm">
                  Back to My Exams
                </Button>
              </Link>
            </div>
          </Alert>
        )}
      </InstructionsShell>
    );
  }

  // Not in this student's visible set (unassigned, revoked, foreign, or
  // never released): a plain not-found, never a per-case leak.
  if (!view) notFound();

  const { exam, eligibility } = view;
  const state = eligibility.state;
  const presentation = STATE_PRESENTATION[state];
  const gate = studentExamStartGate({
    status: exam.status,
    assignmentActive: true,
    startsAt: exam.startsAt,
    endsAt: exam.endsAt,
    attemptsUsed: view.attemptsUsed,
    maxAttempts: exam.maxAttempts,
  });

  return (
    <InstructionsShell title={exam.title} examTitle={exam.title}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            {exam.title}
          </h1>
          <Badge tone={presentation.tone} dot>
            {presentation.label}
          </Badge>
        </div>
        {exam.description ? (
          <p className="max-w-2xl text-sm leading-6 text-ink-muted">
            {exam.description}
          </p>
        ) : null}

        {state === "scheduled" ? (
          <Alert variant="info" title="Not open yet">
            This exam opens at {formatDateTime(exam.startsAt)}. You can read
            the instructions now; the start button becomes available at the
            start time.
          </Alert>
        ) : state === "expired" ? (
          <Alert variant="warning" title="This exam is closed">
            Its availability window ended
            {exam.endsAt ? ` on ${formatDateTime(exam.endsAt)}` : ""}, so it
            can no longer be started.
          </Alert>
        ) : state === "attempts_exhausted" ? (
          <Alert variant="info" title="No attempts left">
            You have used all {exam.maxAttempts} attempt
            {exam.maxAttempts === 1 ? "" : "s"} allowed for this exam. Your
            submitted work and results stay available once grading is live.
          </Alert>
        ) : state === "unavailable" ? (
          <Alert variant="warning" title="Currently unavailable">
            This exam is not available to you right now.
          </Alert>
        ) : null}

        <Card>
          <div className="p-6">
            <h2 className="mb-2 text-sm font-semibold text-ink">
              Assessment details
            </h2>
            <dl className="grid gap-x-8 sm:grid-cols-2">
              <Detail label="Subject">{exam.subjectName}</Detail>
              <Detail label="Type">
                {exam.categoryName ?? (
                  <span className="text-ink-subtle">General assessment</span>
                )}
              </Detail>
              <Detail label="Questions">{exam.questionCount}</Detail>
              <Detail label="Total marks">{exam.totalMarks}</Detail>
              <Detail label="Duration">
                {formatDuration(exam.durationMinutes)}
              </Detail>
              <Detail label="Attempts allowed">
                {exam.maxAttempts}
                {state === "open" ? (
                  <span className="text-ink-subtle">
                    {" "}
                    · {eligibility.attemptsRemaining} available now
                  </span>
                ) : null}
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
              <Detail label="Results released">
                {EXAM_RESULTS_RELEASE_LABELS[exam.resultsRelease]}
              </Detail>
            </dl>
          </div>
        </Card>

        <Card>
          <div className="p-6">
            <h2 className="mb-3 text-sm font-semibold text-ink">
              Before you start
            </h2>
            <ul className="flex flex-col gap-2 text-sm text-ink">
              {buildInstructions(view).map((line) => (
                <li key={line} className="flex gap-2">
                  <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                  <span className="leading-6">{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        <Card>
          <div className="flex flex-col gap-3 p-6">
            <h2 className="text-sm font-semibold text-ink">Ready to begin?</h2>
            <p className="text-sm text-ink-muted">
              {gate.allowed
                ? "You meet every requirement to start. When the examination interface is live, starting here opens your attempt and begins the timer."
                : "Review the rules above. When this exam is open to you and the interface is live, the start action will appear here."}
            </p>
            <StartExamButton
              examId={exam.id}
              disabled={!gate.allowed}
              disabledReason={gate.allowed ? null : gate.message}
            />
            <p className="text-2xs leading-4 text-ink-subtle">
              Starting is confirmed on the server against your assignment,
              the exam window, and your remaining attempts — this screen
              cannot grant access on its own.
            </p>
          </div>
        </Card>
      </div>
    </InstructionsShell>
  );
}

/** Shared chrome (header + back link + scroll container) for every state of
 *  the instructions screen so error/not-linked/read views stay consistent. */
function InstructionsShell({
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
              { label: "My Exams", href: "/student/exams" },
              { label: examTitle ?? title },
            ]}
          />
          <h1 className="mt-1 text-xl font-bold tracking-tight text-ink lg:hidden">
            {title}
          </h1>
        </div>
        <div className="flex shrink-0">
          <Link href="/student/exams">
            <Button type="button" variant="ghost" size="sm">
              Back to My Exams
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
