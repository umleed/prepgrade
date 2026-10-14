import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getAuthContext } from "@/lib/auth/context";
import {
  getStudentByProfileId,
  type Student,
} from "@/lib/data/students";
import { listExamsForStudent, type ExamRecord } from "@/lib/data/exams";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  STUDENT_EXAM_BUCKET_LABELS,
  formatDuration,
  studentExamBucket,
  type StudentExamBucket,
} from "@/lib/exams";
import { Alert, Badge, Button, Card, EmptyState } from "@/components/ui";

export const metadata: Metadata = {
  title: "Dashboard",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

/** Badge tone per dashboard bucket, matching the exam list's status tones. */
const BUCKET_TONES: Record<StudentExamBucket, "brand" | "success" | "info"> = {
  available: "success",
  upcoming: "brand",
  completed: "info",
};

/** "5 Oct 2026, 9:00 AM → 11:00 AM" or an honest placeholder when unscheduled. */
function formatWindow(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt && !endsAt) return "Not scheduled";
  const dateFmt = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const parts = (iso: string | null): string => {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return `${dateFmt.format(date)}, ${timeFmt.format(date)}`;
  };
  if (!endsAt) return `From ${parts(startsAt)}`;
  if (!startsAt) return `Until ${parts(endsAt)}`;
  return `${parts(startsAt)} → ${parts(endsAt)}`;
}

/**
 * Metric tile. Renders a real count when the data behind it exists, or a
 * quiet "—" with an explanatory caption when the data source (attempts and
 * grading, prompts 23–24) has not shipped yet. Numbers are never fabricated.
 */
function MetricTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | null;
  hint: string;
}) {
  return (
    <Card>
      <div className="flex flex-col gap-1 p-5">
        <p className="text-sm text-ink-muted">{label}</p>
        <p className="text-2xl font-bold tracking-tight text-ink">
          {value === null ? (
            <span aria-label="Not available yet">—</span>
          ) : (
            value.toLocaleString()
          )}
        </p>
        <p className="text-2xs leading-4 text-ink-subtle">{hint}</p>
      </div>
    </Card>
  );
}

/** One assigned exam as a card: the facts a student needs before the CBT
 *  interface exists (delivery ships in prompts 22–23), plus an honest action
 *  state for its bucket. */
function ExamCard({ exam, bucket }: { exam: ExamRecord; bucket: StudentExamBucket }) {
  return (
    <Card>
      <div className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-ink">{exam.title}</h3>
            <p className="mt-0.5 text-sm text-ink-muted">
              {exam.subjectName}
              {exam.categoryName ? ` · ${exam.categoryName}` : ""}
            </p>
          </div>
          <Badge tone={BUCKET_TONES[bucket]} dot>
            {STUDENT_EXAM_BUCKET_LABELS[bucket]}
          </Badge>
        </div>

        {exam.description ? (
          <p className="line-clamp-2 text-sm leading-6 text-ink-muted">
            {exam.description}
          </p>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-4">
            <dt className="text-2xs font-medium uppercase tracking-wide text-ink-subtle">
              Availability window
            </dt>
            <dd className="mt-0.5 text-ink">
              {formatWindow(exam.startsAt, exam.endsAt)}
            </dd>
          </div>
          <div>
            <dt className="text-2xs font-medium uppercase tracking-wide text-ink-subtle">
              Duration
            </dt>
            <dd className="mt-0.5 tabular-nums text-ink">
              {formatDuration(exam.durationMinutes)}
            </dd>
          </div>
          <div>
            <dt className="text-2xs font-medium uppercase tracking-wide text-ink-subtle">
              Questions
            </dt>
            <dd className="mt-0.5 tabular-nums text-ink">{exam.questionCount}</dd>
          </div>
          <div>
            <dt className="text-2xs font-medium uppercase tracking-wide text-ink-subtle">
              Total marks
            </dt>
            <dd className="mt-0.5 tabular-nums text-ink">{exam.totalMarks}</dd>
          </div>
          <div>
            <dt className="text-2xs font-medium uppercase tracking-wide text-ink-subtle">
              Attempts
            </dt>
            <dd className="mt-0.5 tabular-nums text-ink">
              up to {exam.maxAttempts}
            </dd>
          </div>
        </dl>

        {bucket === "available" ? (
          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            {/* The pre-exam instructions screen (prompt 21) is the gate in
                front of the CBT interface — it explains the rules and runs
                the server-side eligibility/attempt check before any start. */}
            <Link href={`/student/exams/${exam.id}`}>
              <Button type="button" variant="primary" size="sm">
                View instructions
              </Button>
            </Link>
            <p className="text-2xs leading-4 text-ink-subtle">
              Review the rules and start from there once you are ready.
            </p>
          </div>
        ) : bucket === "upcoming" ? (
          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <Link href={`/student/exams/${exam.id}`}>
              <Button type="button" variant="secondary" size="sm">
                View instructions
              </Button>
            </Link>
            <p className="text-2xs leading-4 text-ink-subtle">
              Not open yet — it becomes available at its start time.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <Link href={`/student/exams/${exam.id}`}>
              <Button type="button" variant="secondary" size="sm">
                View details
              </Button>
            </Link>
            <p className="text-2xs leading-4 text-ink-subtle">
              This exam&apos;s availability has ended. Results appear once
              grading and result release are live.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

/** A titled section of exam cards; renders nothing when the bucket is empty,
 *  so the dashboard never shows hollow headings. */
function ExamSection({
  title,
  description,
  exams,
  bucket,
}: {
  title: string;
  description: string;
  exams: ExamRecord[];
  bucket: StudentExamBucket;
}) {
  if (exams.length === 0) return null;
  return (
    <section aria-labelledby={`section-${bucket}`} className="flex flex-col gap-3">
      <div>
        <h2
          id={`section-${bucket}`}
          className="text-lg font-semibold tracking-tight text-ink"
        >
          {title}{" "}
          <span className="text-sm font-normal tabular-nums text-ink-subtle">
            ({exams.length})
          </span>
        </h2>
        <p className="text-sm text-ink-muted">{description}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {exams.map((exam) => (
          <ExamCard key={exam.id} exam={exam} bucket={bucket} />
        ))}
      </div>
    </section>
  );
}

/**
 * Signed in as STUDENT, but no live roster row is linked to this account.
 * The link (`students.profile_id`) is written by institution-side
 * membership flows, never by the student — guessing or self-asserting a
 * roster row would break tenant and owner integrity (AGENTS.md §5), so the
 * honest state is "ask your institution", not a picker. Rendered under the
 * page's greeting header, which already names the visitor.
 */
function UnlinkedAccountState() {
  return (
    <EmptyState
      title="Your account isn't linked to a student record yet"
      description={
        <>
          Your institution keeps a student roster with your name, student
          code, and class. A PrepGrade account must be connected to that
          roster row by your institution&apos;s admin before any assigned
          exams or results can be shown here — this page only ever displays
          data for the verified student record linked to your sign-in.
        </>
      }
    />
  );
}

/**
 * Student dashboard (prompt 20) — assigned assessments first.
 *
 * Everything on this page is backed by real records: the student's own roster
 * row (resolved from the trusted session — Clerk user id + tenant — never a
 * client-supplied student id) and the exams assigned to them or to their
 * class. Performance tiles that would need attempt/grading records
 * (prompts 23–24) render an honest "—" instead of an invented number, and
 * the "start exam" action is disabled until the CBT interface ships
 * (prompts 22–23). Students only ever see published and closed exams —
 * drafts and unpublished scheduled exams do not exist for them.
 */
export default async function StudentDashboardPage() {
  await connection();

  // Defense in depth alongside the layout: the queries below must only ever
  // run for a verified STUDENT with a trusted tenant membership.
  const principal = await requireRole(["STUDENT"], { next: "/student" });
  const institutionId = principal.institutionId as string;

  const context = await getAuthContext();
  const greeting = context.displayName || context.email || "there";

  // Identity resolution: session → own roster row. Both keys are server-side
  // trusted; a failure here is a data-source problem, rendered honestly.
  let student: Student | null = null;
  let exams: ExamRecord[] = [];
  let loadError: "unconfigured" | "unavailable" | null = null;

  try {
    student = await getStudentByProfileId(institutionId, principal.userId);
    if (student) {
      exams = await listExamsForStudent(institutionId, student.id, student.classId);
    }
  } catch (error) {
    loadError =
      error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  const now = new Date();
  const bucketOf = (exam: ExamRecord): StudentExamBucket | null =>
    studentExamBucket({
      status: exam.status,
      startsAt: exam.startsAt,
      endsAt: exam.endsAt,
      now,
    });
  const available = exams.filter((exam) => bucketOf(exam) === "available");
  const upcoming = exams.filter((exam) => bucketOf(exam) === "upcoming");
  const completed = exams.filter((exam) => bucketOf(exam) === "completed");

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">
            Hello, {greeting}
          </h1>
          <p className="text-sm text-ink-muted">
            {student
              ? `${student.fullName}${student.className ? ` · ${student.className}` : ""} · Student code ${student.studentCode}`
              : "Your assigned assessments and exam schedule."}
          </p>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
          {loadError === "unconfigured" ? (
            <Alert variant="warning" title="Student data is not configured">
              Supabase connection variables are missing on the server. Set
              <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
              <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to
              load your assigned exams.
            </Alert>
          ) : loadError === "unavailable" ? (
            <Alert variant="danger" title="Your exams could not be loaded">
              The student data source is unavailable right now. Nothing is
              shown rather than anything that has not been verified against
              your records. Please reload; if it persists, tell your
              institution admin.
            </Alert>
          ) : !student ? (
            <UnlinkedAccountState />
          ) : (
            <>
              {/* Performance summary — counts come straight from the real
                  assignment records below; the score tile waits for the
                  grading engine (prompts 23–24) and never shows a guess. */}
              <section
                aria-label="Performance summary"
                className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
              >
                <MetricTile
                  label="Open now"
                  value={available.length}
                  hint="Assigned exams you can take in their current window."
                />
                <MetricTile
                  label="Upcoming"
                  value={upcoming.length}
                  hint="Published exams whose window has not opened yet."
                />
                <MetricTile
                  label="Recently ended"
                  value={completed.length}
                  hint="Assigned exams whose availability has passed."
                />
                <MetricTile
                  label="Average score"
                  value={null}
                  hint="Appears once exam delivery and grading are live."
                />
              </section>

              {exams.length === 0 ? (
                <EmptyState
                  title="No exams assigned yet"
                  description={
                    <>
                      When your teacher or institution admin assigns an exam to
                      your class — or to you directly — it appears here with
                      its schedule, duration, and instructions.
                    </>
                  }
                />
              ) : (
                <>
                  <ExamSection
                    title="Available now"
                    description="Open for the whole window — check the closing time and plan to finish before it."
                    exams={available}
                    bucket="available"
                  />
                  <ExamSection
                    title="Upcoming exams"
                    description="Published and scheduled; they open automatically at their start time."
                    exams={upcoming}
                    bucket="upcoming"
                  />
                  <ExamSection
                    title="Recently ended"
                    description="Availability has passed for these assigned exams. Your attempts and results will appear with them once grading is live."
                    exams={completed}
                    bucket="completed"
                  />
                </>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}
