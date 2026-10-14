import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getStudentByProfileId } from "@/lib/data/students";
import { listExamsForStudent, type ExamRecord } from "@/lib/data/exams";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  STUDENT_EXAM_BUCKET_LABELS,
  formatDuration,
  studentExamBucket,
  type StudentExamBucket,
} from "@/lib/exams";
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
  title: "My Exams",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

/** Badge tone per bucket — the same tones the dashboard and exam lists use. */
const BUCKET_TONES: Record<StudentExamBucket, "brand" | "success" | "info"> = {
  available: "success",
  upcoming: "brand",
  completed: "info",
};

/** "5 Oct 2026, 9:00 AM → 11:00 AM" or an honest placeholder when unscheduled
 *  (mirrors the dashboard's copy so both surfaces read identically). */
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
 * One assigned exam as a dense table row (the design's My Exams layout):
 * every fact prompt 21 requires up front — title, subject, window,
 * duration, question count, marks, and the attempt allowance — plus the
 * action that opens the pre-exam instructions. Scores/grades stay out of
 * this view until grading ships; nothing is fabricated.
 */
function ExamRow({ exam, bucket }: { exam: ExamRecord; bucket: StudentExamBucket }) {
  return (
    <TableRow>
      <TableCell className="min-w-56">
        <p className="font-medium text-ink">{exam.title}</p>
        <p className="mt-0.5 text-xs text-ink-subtle">
          {exam.categoryName ?? exam.subjectName}
        </p>
      </TableCell>
      <TableCell>
        <span className="whitespace-nowrap">{formatWindow(exam.startsAt, exam.endsAt)}</span>
      </TableCell>
      <TableCell numeric className="whitespace-nowrap">
        {formatDuration(exam.durationMinutes)}
      </TableCell>
      <TableCell numeric>{exam.questionCount}</TableCell>
      <TableCell numeric>{exam.totalMarks}</TableCell>
      <TableCell numeric>up to {exam.maxAttempts}</TableCell>
      <TableCell>
        <Badge tone={BUCKET_TONES[bucket]} dot>
          {STUDENT_EXAM_BUCKET_LABELS[bucket]}
        </Badge>
      </TableCell>
      <TableCell>
        {/* The instructions/detail screen is the one honest destination for
            every bucket — it explains the rules and (when eligible) gates
            the explicit start (prompt 21). */}
        <Link href={`/student/exams/${exam.id}`}>
          <Button type="button" variant="secondary" size="sm">
            View
          </Button>
          <span className="sr-only">
            {" "}
            {exam.title} — instructions and details
          </span>
        </Link>
      </TableCell>
    </TableRow>
  );
}

/** A titled section of exam rows; renders nothing when the bucket is empty,
 *  so the page never shows hollow headings (same rule as the dashboard). */
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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Exam</TableHead>
            <TableHead>Availability window</TableHead>
            <TableHead numeric>Duration</TableHead>
            <TableHead numeric>Questions</TableHead>
            <TableHead numeric>Marks</TableHead>
            <TableHead numeric>Attempts</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {exams.map((exam) => (
            <ExamRow key={exam.id} exam={exam} bucket={bucket} />
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

/**
 * My Exams (prompt 21) — the student's assigned-exam list.
 *
 * The list is exactly the set the server says this student may see: active
 * direct assignments plus their class roster's assignments, published or
 * closed only, under their trusted tenant (the same `listExamsForStudent`
 * read the dashboard uses — one source for both surfaces). Rows carry the
 * facts prompt 21 lists; the rules themselves, and the explicit start
 * action, live on the instructions screen behind each row, where
 * eligibility is re-checked server-side. Average score stays an honest "—"
 * until grading ships (prompts 23–24) — no invented numbers.
 */
export default async function StudentMyExamsPage() {
  await connection();

  // Defense in depth alongside the layout: only a verified STUDENT with a
  // trusted tenant membership may run these queries.
  const principal = await requireRole(["STUDENT"], { next: "/student/exams" });
  const institutionId = principal.institutionId as string;

  let exams: ExamRecord[] = [];
  let loadError: "unconfigured" | "unavailable" | "unlinked" | null = null;

  try {
    const student = await getStudentByProfileId(institutionId, principal.userId);
    if (!student) {
      loadError = "unlinked";
    } else {
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
      <header className="flex shrink-0 flex-col gap-1 border-b border-border bg-surface px-6 py-4">
        <h1 className="text-xl font-bold tracking-tight text-ink">My Exams</h1>
        <p className="text-sm text-ink-muted">
          Every exam assigned to you — read its instructions before the
          window closes, and open one to review the rules and start it.
        </p>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
          {loadError === "unconfigured" ? (
            <Alert variant="warning" title="Exam data is not configured">
              Supabase connection variables are missing on the server. Set
              <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
              <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to
              load your assigned exams.
            </Alert>
          ) : loadError === "unavailable" ? (
            <Alert variant="danger" title="Your exams could not be loaded">
              The exam data source is unavailable right now. Nothing is shown
              rather than anything that has not been verified against your
              records. Please reload; if it persists, check your connection
              and try again.
            </Alert>
          ) : loadError === "unlinked" ? (
            <EmptyState
              title="Your account isn't linked to a student record yet"
              description={
                <>
                  A PrepGrade account must be connected to your institution&apos;s
                  student roster before assigned exams can be shown — this page
                  only ever displays data for the verified student record
                  linked to your sign-in. Ask your institution&apos;s admin to
                  connect it.
                </>
              }
            />
          ) : (
            <>
              <section
                aria-label="Exam counts"
                className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
              >
                <Card>
                  <div className="flex flex-col gap-1 p-5">
                    <p className="text-sm text-ink-muted">Assigned to you</p>
                    <p className="text-2xl font-bold tracking-tight text-ink tabular-nums">
                      {exams.length}
                    </p>
                    <p className="text-2xs leading-4 text-ink-subtle">
                      Published and closed exams in your current records.
                    </p>
                  </div>
                </Card>
                <Card>
                  <div className="flex flex-col gap-1 p-5">
                    <p className="text-sm text-ink-muted">Open now</p>
                    <p className="text-2xl font-bold tracking-tight text-ink tabular-nums">
                      {available.length}
                    </p>
                    <p className="text-2xs leading-4 text-ink-subtle">
                      Inside their window — plan to finish before it closes.
                    </p>
                  </div>
                </Card>
                <Card>
                  <div className="flex flex-col gap-1 p-5">
                    <p className="text-sm text-ink-muted">Upcoming</p>
                    <p className="text-2xl font-bold tracking-tight text-ink tabular-nums">
                      {upcoming.length}
                    </p>
                    <p className="text-2xs leading-4 text-ink-subtle">
                      Published, opening at their scheduled start time.
                    </p>
                  </div>
                </Card>
                <Card>
                  <div className="flex flex-col gap-1 p-5">
                    <p className="text-sm text-ink-muted">Average score</p>
                    <p className="text-2xl font-bold tracking-tight text-ink">
                      <span aria-label="Not available yet">—</span>
                    </p>
                    <p className="text-2xs leading-4 text-ink-subtle">
                      Appears once exam delivery and grading are live.
                    </p>
                  </div>
                </Card>
              </section>

              {exams.length === 0 ? (
                <EmptyState
                  title="No exams assigned yet"
                  description={
                    <>
                      When your teacher or institution admin assigns an exam to
                      your class — or to you directly — it appears here with
                      its schedule, duration, question count, and instructions.
                    </>
                  }
                  action={
                    <Link href="/student">
                      <Button type="button" variant="secondary" size="sm">
                        Back to dashboard
                      </Button>
                    </Link>
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
