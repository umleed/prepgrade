import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getAuthContext } from "@/lib/auth/context";
import {
  listAssignedClassIdsForTeacher,
  listClassesByIdsWithStudentCounts,
  listClassOptions,
} from "@/lib/data/classes";
import { listExamsPage, type ExamRecord } from "@/lib/data/exams";
import { getBankStats } from "@/lib/data/questions";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  examDisplayState,
  formatDuration,
  teacherExamBucket,
  type ExamListQuery,
  type TeacherExamBucket,
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
  title: "Dashboard",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

/** Badge tone per exam display state, matching the exam list's status tones. */
const BUCKET_TONES: Record<TeacherExamBucket, "neutral" | "brand" | "success" | "info"> = {
  draft: "neutral",
  upcoming: "brand",
  active: "success",
  completed: "info",
};

/** "5 Oct 2026, 9:00 AM" or an honest placeholder when unscheduled. */
function formatStart(startsAt: string | null): string {
  if (!startsAt) return "Not scheduled";
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/**
 * Metric tile. Renders a real count when the data behind it exists, or a quiet
 * "—" with an explanatory caption when the source (class analytics, prompts
 * 27–29) has not shipped yet. Numbers are never fabricated (AGENTS.md §8,
 * prompt 26 "avoid decorative metrics and fake live data").
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

/**
 * Quick-action tile linking to a workspace route that already exists. The
 * teacher dashboard's job is to route into the tools; every href here points
 * at a live page (exam builder, question authoring, assignment, results).
 */
function ActionTile({
  label,
  description,
  href,
}: {
  label: string;
  description: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4 text-left shadow-card transition-colors hover:border-border-strong"
    >
      <span className="text-sm font-semibold text-ink">{label}</span>
      <span className="text-xs leading-5 text-ink-muted">{description}</span>
    </Link>
  );
}

/** One exam row in the "Recent assessments" table, with its derived state. */
function ExamRow({ exam }: { exam: ExamRecord }) {
  const state = examDisplayState(exam.status, exam.startsAt, exam.endsAt);
  return (
    <TableRow>
      <TableCell className="font-medium text-ink">
        <Link
          href={`/teacher/exams/${exam.id}`}
          className="hover:text-brand-700 hover:underline"
        >
          {exam.title}
        </Link>
        <span className="block text-2xs font-normal text-ink-subtle">
          {exam.subjectName}
        </span>
      </TableCell>
      <TableCell className="text-ink-muted">
        {exam.assignedClasses.length > 0
          ? exam.assignedClasses.map((cls) => cls.name).join(", ")
          : "—"}
      </TableCell>
      <TableCell className="tabular-nums text-ink-muted">{exam.questionCount}</TableCell>
      <TableCell>
        <Badge tone={state.tone} dot>
          {state.label}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap text-ink-muted">
        {formatStart(exam.startsAt)}
      </TableCell>
      <TableCell className="text-right">
        <Link
          href={`/teacher/exams/${exam.id}/results`}
          className="text-xs font-medium text-brand-700 hover:underline"
        >
          View results
        </Link>
      </TableCell>
    </TableRow>
  );
}

/**
 * Teacher dashboard (prompt 26) — classes, assessments, and the actions a
 * teacher reaches for most.
 *
 * Everything shown is backed by real records resolved from the trusted session
 * (Clerk user id + tenant), never a client-supplied teacher/class id. A
 * TEACHER's class scope comes from `teacher_class_assignments`; an
 * INSTITUTION_ADMIN sees the whole institution's active classes (they hold the
 * teaching area too). Exams are the institution's — the same scoping the My
 * Exams list already applies to both roles. Performance figures that would
 * need class analytics (prompts 27–29) render an honest "—" rather than an
 * invented number, and no decorative trend deltas are shown.
 */
export default async function TeacherDashboardPage() {
  await connection();

  // Defense in depth alongside the layout: the queries below must only ever
  // run for a verified TEACHER / INSTITUTION_ADMIN with a trusted tenant.
  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher",
  });
  const institutionId = principal.institutionId as string;

  const context = await getAuthContext();
  const greeting = context.displayName || context.email || "there";

  let classes: { id: string; name: string; studentCount: number }[] = [];
  let exams: ExamRecord[] = [];
  let totalExams: number | null = null;
  let questionsCreated: number | null = null;
  let loadError: "unconfigured" | "unavailable" | null = null;

  try {
    // Class scope: teachers see their assigned classes; admins see them all.
    const scopedClassIds =
      principal.role === "INSTITUTION_ADMIN"
        ? (await listClassOptions(institutionId)).map((option) => option.id)
        : await listAssignedClassIdsForTeacher(institutionId, principal.userId);

    const [classRows, examPage, bankStats] = await Promise.all([
      listClassesByIdsWithStudentCounts(institutionId, scopedClassIds),
      listExamsPage(institutionId, {
        q: "",
        subjectId: "",
        status: null,
        page: 1,
        pageSize: 20,
      } satisfies ExamListQuery),
      getBankStats(institutionId, principal.userId),
    ]);

    classes = classRows;
    exams = examPage.rows;
    totalExams = examPage.total;
    questionsCreated = bankStats.mine;
  } catch (error) {
    loadError =
      error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  const totalStudents = classes.reduce((sum, cls) => sum + cls.studentCount, 0);

  // Bucket the fetched exams for the "upcoming" strip; the table shows the
  // most recent activity. Archived exams are filtered out by the bucket rule.
  const now = new Date();
  const bucketOf = (exam: ExamRecord): TeacherExamBucket | null =>
    teacherExamBucket({
      status: exam.status,
      startsAt: exam.startsAt,
      endsAt: exam.endsAt,
      now,
    });
  const upcoming = exams
    .map((exam) => ({ exam, bucket: bucketOf(exam) }))
    .filter(
      (entry): entry is { exam: ExamRecord; bucket: TeacherExamBucket } =>
        entry.bucket === "upcoming" || entry.bucket === "active",
    );
  const recent = exams.slice(0, 6);

  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">
            Welcome back, {greeting}
          </h1>
          <p className="text-sm text-ink-muted">
            An overview of your classes and assessment activity.
          </p>
        </div>
        <Link href="/teacher/exams/new">
          <Button type="button" variant="primary" size="sm">
            Create exam
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
          {loadError === "unconfigured" ? (
            <Alert variant="warning" title="Teacher data is not configured">
              Supabase connection variables are missing on the server. Set
              <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
              <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to
              load your dashboard.
            </Alert>
          ) : loadError === "unavailable" ? (
            <Alert variant="danger" title="Your dashboard could not be loaded">
              The teaching data source is unavailable right now. Nothing is
              shown rather than anything that has not been verified against
              your records. Please reload; if it persists, tell your institution
              admin.
            </Alert>
          ) : (
            <>
              {/* Summary metrics — real counts only; average score waits for
                  class analytics (prompts 27–29) and never shows a guess. */}
              <section
                aria-label="Overview"
                className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
              >
                <MetricTile
                  label="Total Exams"
                  value={totalExams}
                  hint="Across your institution."
                />
                <MetricTile
                  label="Questions Created"
                  value={questionsCreated}
                  hint="Active questions you authored in the bank."
                />
                <MetricTile
                  label="Students in your classes"
                  value={totalStudents}
                  hint={`Across ${classes.length} active ${classes.length === 1 ? "class" : "classes"}.`}
                />
                <MetricTile
                  label="Average Score"
                  value={null}
                  hint="Appears once class analytics are live."
                />
              </section>

              {/* Quick actions — every link points at a live workspace route. */}
              <section aria-labelledby="actions-heading" className="flex flex-col gap-3">
                <h2
                  id="actions-heading"
                  className="text-lg font-semibold tracking-tight text-ink"
                >
                  Quick actions
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <ActionTile
                    label="Create exam"
                    description="Build a new assessment from scratch or your question bank."
                    href="/teacher/exams/new"
                  />
                  <ActionTile
                    label="Add questions"
                    description="Author new questions for your bank."
                    href="/teacher/questions/new"
                  />
                  <ActionTile
                    label="Assign exam"
                    description="Assign a published assessment to your classes."
                    href="/teacher/exams"
                  />
                  <ActionTile
                    label="Review results"
                    description="Open an exam to review student results."
                    href="/teacher/exams"
                  />
                </div>
              </section>

              <div className="grid gap-6 lg:grid-cols-3">
                {/* Recent assessments */}
                <section aria-labelledby="recent-heading" className="flex flex-col gap-3 lg:col-span-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2
                      id="recent-heading"
                      className="text-lg font-semibold tracking-tight text-ink"
                    >
                      Recent assessments
                    </h2>
                    <Link
                      href="/teacher/exams"
                      className="text-sm font-medium text-brand-700 hover:underline"
                    >
                      View all
                    </Link>
                  </div>

                  {recent.length === 0 ? (
                    <EmptyState
                      title="No assessments yet"
                      description={
                        <>
                          Create your first exam, add questions to your bank, and
                          assign it to a class. Your assessments and their status
                          will appear here.
                        </>
                      }
                      action={
                        <Link href="/teacher/exams/new">
                          <Button type="button" variant="primary" size="sm">
                            Create exam
                          </Button>
                        </Link>
                      }
                    />
                  ) : (
                    <Card className="overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Title</TableHead>
                            <TableHead>Classes</TableHead>
                            <TableHead>Questions</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Starts</TableHead>
                            <TableHead className="text-right">Action</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {recent.map((exam) => (
                            <ExamRow key={exam.id} exam={exam} />
                          ))}
                        </TableBody>
                      </Table>
                    </Card>
                  )}
                </section>

                {/* Upcoming + your classes */}
                <div className="flex flex-col gap-6">
                  <section aria-labelledby="upcoming-heading" className="flex flex-col gap-3">
                    <h2
                      id="upcoming-heading"
                      className="text-lg font-semibold tracking-tight text-ink"
                    >
                      Upcoming &amp; active
                    </h2>
                    {upcoming.length === 0 ? (
                      <Card>
                        <div className="p-5">
                          <p className="text-sm leading-6 text-ink-muted">
                            No exams are scheduled or open right now. Published
                            exams with a future or current window will appear
                            here.
                          </p>
                        </div>
                      </Card>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {upcoming.slice(0, 5).map(({ exam, bucket }) => (
                          <li key={exam.id}>
                            <Link
                              href={`/teacher/exams/${exam.id}`}
                              className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface p-3 shadow-card transition-colors hover:border-border-strong"
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-medium text-ink">
                                  {exam.title}
                                </span>
                                <span className="block text-2xs text-ink-subtle">
                                  {formatDuration(exam.durationMinutes)} ·{" "}
                                  {formatStart(exam.startsAt)}
                                </span>
                              </span>
                              <Badge tone={BUCKET_TONES[bucket]} dot>
                                {examDisplayState(exam.status, exam.startsAt, exam.endsAt).label}
                              </Badge>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section aria-labelledby="classes-heading" className="flex flex-col gap-3">
                    <h2
                      id="classes-heading"
                      className="text-lg font-semibold tracking-tight text-ink"
                    >
                      Your classes
                    </h2>
                    {classes.length === 0 ? (
                      <Card>
                        <div className="p-5">
                          <p className="text-sm leading-6 text-ink-muted">
                            You are not assigned to any active class yet. Your
                            institution admin assigns classes; once you have one,
                            it appears here with its student count.
                          </p>
                        </div>
                      </Card>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {classes.slice(0, 6).map((cls) => (
                          <li
                            key={cls.id}
                            className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface p-3"
                          >
                            <span className="truncate text-sm font-medium text-ink">
                              {cls.name}
                            </span>
                            <span className="shrink-0 text-2xs tabular-nums text-ink-subtle">
                              {cls.studentCount} {cls.studentCount === 1 ? "student" : "students"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
