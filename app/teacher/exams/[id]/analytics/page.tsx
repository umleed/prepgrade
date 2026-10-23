import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import {
  getExamClassAnalytics,
  resolveSubjectNames,
  type ExamAnalyticsBundle,
} from "@/lib/data/analytics";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  buildGradeDistribution,
  buildScoreDistribution,
  computeClassSummary,
  computeSubjectPerformance,
  computeTopicPerformance,
  formatMetricPercent,
  formatShare,
  gradeForPercentage,
  topicHighlights,
  DEFAULT_PASS_MARK,
  type AnalyticsResultRow,
} from "@/lib/analytics";
import { formatDuration } from "@/lib/exams";
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
  title: "Class performance analytics",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

const PASS_MARK = DEFAULT_PASS_MARK;

/** "5 Oct 2026, 9:00 AM" or an honest placeholder when unscheduled. */
function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A tone for a percentage: green at/above pass, amber near it, red below. */
function percentTone(percentage: number): "success" | "warning" | "danger" {
  if (percentage >= 75) return "success";
  if (percentage >= PASS_MARK) return "warning";
  return "danger";
}

const TONE_BAR: Record<"success" | "warning" | "danger" | "brand", string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  brand: "bg-brand",
};

const TONE_TEXT: Record<"success" | "warning" | "danger", string> = {
  success: "text-success-strong",
  warning: "text-warning-strong",
  danger: "text-danger-strong",
};

// --- Summary cards -----------------------------------------------------------

function SummaryCard({
  label,
  value,
  sub,
  tone = "brand",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "brand" | "success" | "warning" | "danger" | "neutral";
}) {
  const iconTone =
    tone === "neutral"
      ? "bg-surface-muted text-ink-muted"
      : `${TONE_BAR[tone]} text-white`;
  return (
    <Card>
      <div className="flex items-center gap-3 p-4">
        <span
          aria-hidden="true"
          className={`flex size-9 shrink-0 items-center justify-center rounded-field ${iconTone}`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="size-4">
            <path d="M3 3v18h18" />
            <path d="m7 14 3.5-3.5 3 2.5L19 7" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="truncate text-2xl font-bold tracking-tight text-ink tabular-nums">
            {value}
          </p>
          <p className="truncate text-xs text-ink-muted">{label}</p>
          {sub ? <p className="truncate text-2xs text-ink-subtle">{sub}</p> : null}
        </div>
      </div>
    </Card>
  );
}

// --- Score distribution (accessible CSS histogram) ---------------------------

function ScoreDistribution({ rows }: { rows: AnalyticsResultRow[] }) {
  const buckets = buildScoreDistribution(rows);
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Score distribution</h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        Students per 10-point band, out of {rows.length} graded.
      </p>
      <div
        role="img"
        aria-label={`Score distribution across ${buckets.length} bands for ${rows.length} graded students.`}
        className="mt-4 flex h-40 items-end gap-1.5"
      >
        {buckets.map((bucket) => {
          const heightPct = Math.round((bucket.count / max) * 100);
          return (
            <div key={bucket.label} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-2xs font-medium text-ink-subtle tabular-nums">
                {bucket.count > 0 ? bucket.count : ""}
              </span>
              <div className="flex w-full flex-1 items-end">
                <div
                  className="w-full rounded-t bg-brand-200"
                  style={{ height: `${bucket.count > 0 ? Math.max(heightPct, 4) : 0}%` }}
                  title={`${bucket.label}: ${bucket.count}`}
                />
              </div>
              <span className="text-2xs text-ink-subtle">{bucket.label}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// --- Pass / fail overview ----------------------------------------------------

function PassFailOverview({
  passed,
  failed,
  notSubmitted,
  graded,
}: {
  passed: number;
  failed: number;
  notSubmitted: number;
  graded: number;
}) {
  const total = passed + failed + notSubmitted;
  const segments = [
    { label: "Passed", count: passed, tone: "success" as const },
    { label: "Failed", count: failed, tone: "danger" as const },
    { label: "Not submitted", count: notSubmitted, tone: "neutral" as const },
  ];
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Pass / fail overview</h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        Pass mark set at {PASS_MARK}% for reporting (not an official cut-off).
      </p>
      <div className="mt-4 flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div
            role="img"
            aria-label={`Passed ${passed}, failed ${failed}, not submitted ${notSubmitted}, of ${total} assigned students.`}
            className="flex h-4 w-full overflow-hidden rounded-full bg-surface-muted"
          >
            {segments.map((segment) =>
              segment.count > 0 ? (
                <div
                  key={segment.label}
                  className={
                    segment.tone === "neutral"
                      ? "bg-ink-subtle"
                      : TONE_BAR[segment.tone]
                  }
                  style={{ width: `${(segment.count / Math.max(1, total)) * 100}%` }}
                />
              ) : null,
            )}
          </div>
          <dl className="mt-4 flex flex-col gap-2">
            {segments.map((segment) => (
              <div key={segment.label} className="flex items-center justify-between gap-3 text-sm">
                <dt className="flex items-center gap-2 text-ink-muted">
                  <span
                    aria-hidden="true"
                    className={`size-2.5 rounded-full ${
                      segment.tone === "neutral" ? "bg-ink-subtle" : TONE_BAR[segment.tone]
                    }`}
                  />
                  {segment.label}
                </dt>
                <dd className="tabular-nums text-ink">
                  {segment.count}
                  <span className="ml-1 text-ink-subtle">
                    ({formatShare(segment.count, total)})
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="flex w-24 shrink-0 flex-col items-center">
          <p className="text-3xl font-bold tracking-tight text-ink tabular-nums">{graded}</p>
          <p className="text-2xs text-ink-muted">graded</p>
        </div>
      </div>
    </Card>
  );
}

// --- Grade distribution ------------------------------------------------------

function GradeDistribution({ rows }: { rows: AnalyticsResultRow[] }) {
  const grades = buildGradeDistribution(rows).filter((band) => band.count > 0);
  const total = rows.length;
  if (grades.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Grade distribution</h2>
        <p className="mt-2 text-sm text-ink-subtle">No graded results yet.</p>
      </Card>
    );
  }
  const max = Math.max(...grades.map((band) => band.count));
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Grade distribution</h2>
      <p className="mt-0.5 text-sm text-ink-muted">Letter grade per student.</p>
      <div
        role="img"
        aria-label={`Grade distribution across ${grades.length} letter grades for ${total} graded students.`}
        className="mt-4 flex h-40 items-end gap-3"
      >
        {grades.map((band) => {
          const heightPct = Math.round((band.count / max) * 100);
          const tone =
            band.grade === "A" || band.grade === "B"
              ? "success"
              : band.grade === "C" || band.grade === "D"
                ? "warning"
                : "danger";
          return (
            <div key={band.grade} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-2xs font-medium text-ink-subtle tabular-nums">
                {band.count}
              </span>
              <div className="flex w-full flex-1 items-end">
                <div
                  className={`w-full rounded-t ${TONE_BAR[tone]}`}
                  style={{ height: `${Math.max(heightPct, 4)}%` }}
                  title={`${band.grade}: ${band.count}`}
                />
              </div>
              <span className="text-xs font-semibold text-ink">{band.grade}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// --- Topic performance -------------------------------------------------------

function TopicPerformance({ rows }: { rows: AnalyticsResultRow[] }) {
  const topics = computeTopicPerformance(rows).sort(
    (a, b) => (b.accuracy ?? -1) - (a.accuracy ?? -1),
  );
  if (topics.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Performance by topic</h2>
        <p className="mt-2 text-sm text-ink-subtle">
          No topic-tagged questions were answered in the graded results, so no
          topic accuracy can be reported. This is missing data, not zero.
        </p>
      </Card>
    );
  }
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Performance by topic</h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        Class accuracy per topic, from graded answers.
      </p>
      <ul className="mt-4 flex flex-col gap-3">
        {topics.map((topic) => {
          const accuracy = topic.accuracy ?? 0;
          const tone = percentTone(accuracy);
          return (
            <li key={topic.topicId}>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-medium text-ink">{topic.topicName}</span>
                <span className={`shrink-0 tabular-nums ${TONE_TEXT[tone]}`}>
                  {formatMetricPercent(topic.accuracy)}
                </span>
              </div>
              <div
                className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-muted"
                role="progressbar"
                aria-valuenow={Math.round(accuracy)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${topic.topicName} accuracy`}
              >
                <div className={`h-full ${TONE_BAR[tone]}`} style={{ width: `${Math.min(100, accuracy)}%` }} />
              </div>
              <p className="mt-0.5 text-2xs text-ink-subtle">
                {topic.correct} of {topic.total} answers correct
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// --- Subject performance -----------------------------------------------------

function SubjectPerformance({
  rows,
  names,
}: {
  rows: AnalyticsResultRow[];
  names: Map<string, string>;
}) {
  // Fill each row's subject name from the resolved map before aggregating.
  const labelled: AnalyticsResultRow[] = rows.map((row) => ({
    ...row,
    subjects: row.subjects.map((subject) => ({
      ...subject,
      subjectName: names.get(subject.subjectId) ?? "—",
    })),
  }));
  const subjects = computeSubjectPerformance(labelled);
  if (subjects.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Subject performance</h2>
        <p className="mt-2 text-sm text-ink-subtle">
          No subject breakdown is recorded for the graded results yet.
        </p>
      </Card>
    );
  }
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Subject performance</h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        Marks earned vs. available, per subject.
      </p>
      <ul className="mt-4 flex flex-col gap-3">
        {subjects.map((subject) => {
          const pct = subject.percentage ?? 0;
          const tone = percentTone(pct);
          return (
            <li key={subject.subjectId}>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-medium text-ink">{subject.subjectName}</span>
                <span className={`shrink-0 tabular-nums ${TONE_TEXT[tone]}`}>
                  {formatMetricPercent(subject.percentage)}
                </span>
              </div>
              <div
                className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-muted"
                role="progressbar"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${subject.subjectName} score share`}
              >
                <div className={`h-full ${TONE_BAR[tone]}`} style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// --- Key insights ------------------------------------------------------------

function KeyInsights({ rows }: { rows: AnalyticsResultRow[] }) {
  const topics = computeTopicPerformance(rows);
  const { strongest, weakest } = topicHighlights(topics);
  const summary = computeClassSummary(rows, rows.length, PASS_MARK);

  const items: { tone: "success" | "warning" | "danger" | "brand"; title: string; body: string }[] = [];
  if (strongest) {
    items.push({
      tone: "success",
      title: "Strongest topic",
      body: `${strongest.topicName} (${formatMetricPercent(strongest.accuracy)}) — the class answered the highest share of these correctly.`,
    });
  }
  if (weakest) {
    items.push({
      tone: "warning",
      title: "Needs revision",
      body: `${weakest.topicName} (${formatMetricPercent(weakest.accuracy)}) — the lowest topic accuracy measured. Consider a targeted revision session.`,
    });
  }
  if (summary.average !== null) {
    const belowCount = rows.filter((row) => row.percentage < PASS_MARK).length;
    items.push({
      tone: "brand",
      title: "Class standing",
      body: `Average ${formatMetricPercent(summary.average)} across ${summary.graded} graded ${summary.graded === 1 ? "student" : "students"}; ${belowCount} below the ${PASS_MARK}% reporting pass mark.`,
    });
  }

  if (items.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Key insights</h2>
        <p className="mt-2 text-sm text-ink-subtle">
          Insights appear once enough results are graded to compare topics.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Key insights</h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        Descriptive of graded answers only — no prediction or risk label.
      </p>
      <ul className="mt-4 flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.title} className="flex gap-3">
            <span
              aria-hidden="true"
              className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${TONE_BAR[item.tone]} text-white`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="size-3.5">
                <path d="M12 8v5m0 3h.01" />
                <circle cx="12" cy="12" r="9" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">{item.title}</p>
              <p className="text-sm text-ink-muted">{item.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- Student roster table ----------------------------------------------------

type StudentView = "all" | "passed" | "failed" | "missing";

function resolveView(raw: string | string[] | undefined): StudentView {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "passed" || value === "failed" || value === "missing"
    ? value
    : "all";
}

function StudentTable({
  bundle,
  view,
  examId,
}: {
  bundle: ExamAnalyticsBundle;
  view: StudentView;
  examId: string;
}) {
  const gradedIds = new Set(bundle.rows.map((row) => row.studentId));
  const passedRows = bundle.rows.filter((row) => row.percentage >= PASS_MARK);
  const failedRows = bundle.rows.filter((row) => row.percentage < PASS_MARK);
  const missingStudents = bundle.roster.filter((student) => !gradedIds.has(student.id));

  const tabs: { key: StudentView; label: string; count: number }[] = [
    { key: "all", label: "All students", count: bundle.rosterSize || bundle.rows.length },
    { key: "passed", label: "Passed", count: passedRows.length },
    { key: "failed", label: "Failed", count: failedRows.length },
    { key: "missing", label: "Not submitted", count: missingStudents.length },
  ];

  const base = `/teacher/exams/${examId}/analytics`;
  const hrefFor = (key: StudentView) => (key === "all" ? base : `${base}?view=${key}`);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 pt-3">
        {tabs.map((tab) => {
          const active = tab.key === view;
          return (
            <Link
              key={tab.key}
              href={hrefFor(tab.key)}
              aria-current={active ? "page" : undefined}
              className={
                "rounded-t-field border-b-2 px-3 py-2 text-sm font-medium transition-colors " +
                (active
                  ? "border-brand text-brand-700"
                  : "border-transparent text-ink-muted hover:text-ink")
              }
            >
              {tab.label}
              <span className="ml-1 text-ink-subtle tabular-nums">({tab.count})</span>
            </Link>
          );
        })}
      </div>

      {view === "missing" ? (
        missingStudents.length === 0 ? (
          <p className="p-5 text-sm text-ink-subtle">
            Every assigned student has a graded result.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {missingStudents.map((student) => (
                <TableRow key={student.id}>
                  <TableCell asHeader className="font-medium text-ink">
                    {student.name}
                  </TableCell>
                  <TableCell>{student.className ?? "—"}</TableCell>
                  <TableCell>
                    <Badge tone="neutral" dot>
                      No graded result
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      ) : (
        <StudentResultRows
          rows={view === "passed" ? passedRows : view === "failed" ? failedRows : bundle.rows}
          examId={examId}
          emptyLabel={
            view === "passed"
              ? "No student has passed yet."
              : view === "failed"
                ? "No student is below the pass mark."
                : "No graded results yet."
          }
        />
      )}
    </Card>
  );
}

function StudentResultRows({
  rows,
  examId,
  emptyLabel,
}: {
  rows: AnalyticsResultRow[];
  examId: string;
  emptyLabel: string;
}) {
  const sorted = [...rows].sort((a, b) => b.percentage - a.percentage);
  if (sorted.length === 0) {
    return <p className="p-5 text-sm text-ink-subtle">{emptyLabel}</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead numeric>#</TableHead>
          <TableHead>Student</TableHead>
          <TableHead numeric>Score</TableHead>
          <TableHead numeric>Percentage</TableHead>
          <TableHead numeric>Correct</TableHead>
          <TableHead>Grade</TableHead>
          <TableHead numeric>Pass mark</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((row, index) => {
          const tone = percentTone(row.percentage);
          const passed = row.percentage >= PASS_MARK;
          return (
            <TableRow key={row.studentId}>
              <TableCell numeric className="text-ink-subtle">{index + 1}</TableCell>
              <TableCell asHeader className="min-w-40">
                <Link
                  href={`/teacher/exams/${examId}/results`}
                  className="font-medium text-ink hover:text-brand-700 hover:underline"
                >
                  {row.studentName ?? "—"}
                </Link>
              </TableCell>
              <TableCell numeric>
                {row.score} / {row.maxScore}
              </TableCell>
              <TableCell numeric>
                <span className={`font-semibold tabular-nums ${TONE_TEXT[tone]}`}>
                  {formatMetricPercent(row.percentage)}
                </span>
              </TableCell>
              <TableCell numeric>
                {row.correctCount}
                <span className="text-ink-subtle"> / {row.totalQuestions}</span>
              </TableCell>
              <TableCell>
                <Badge tone={passed ? "success" : "danger"}>{gradeForPercentage(row.percentage)}</Badge>
              </TableCell>
              <TableCell numeric>
                <Badge tone={passed ? "success" : "danger"} dot>
                  {passed ? "Pass" : "Fail"}
                </Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// --- Page --------------------------------------------------------------------

/**
 * Class performance analytics (prompt 27) — an authorised teacher's or
 * institution admin's descriptive view of one exam's class results.
 *
 * The exam is resolved through the tenant-scoped analytics read, so an id that
 * is not this institution's exam renders a plain not-found (existence elsewhere
 * is never confirmed — AGENTS.md §5). Every number is a recount of stored,
 * server-graded facts; nothing is recomputed from a client value and no
 * predictive "at risk" claim is made (AGENTS.md §6, §7). Missing data renders
 * "—", never a misleading zero.
 */
export default async function ExamAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  await connection();

  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher/exams",
  });
  const institutionId = principal.institutionId as string;
  const { id } = await params;
  const { view: rawView } = await searchParams;
  const view = resolveView(rawView);

  let bundle: ExamAnalyticsBundle | null = null;
  let subjectNames = new Map<string, string>();
  let loadError: "unconfigured" | "unavailable" | null = null;

  try {
    bundle = await getExamClassAnalytics(institutionId, id);
    if (bundle) {
      const ids = bundle.rows.flatMap((row) => row.subjects.map((subject) => subject.subjectId));
      subjectNames = await resolveSubjectNames(institutionId, ids);
    }
  } catch (error) {
    loadError =
      error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  if (!loadError && !bundle) notFound();

  if (loadError || !bundle) {
    return (
      <>
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
          <h1 className="text-xl font-bold tracking-tight text-ink">Class analytics</h1>
          <Link href="/teacher/exams">
            <Button type="button" variant="ghost" size="sm">
              Back to exams
            </Button>
          </Link>
        </header>
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            {loadError === "unconfigured" ? (
              <Alert variant="warning" title="Analytics data is not configured">
                Supabase connection variables are missing on the server.
              </Alert>
            ) : loadError === "unavailable" ? (
              <Alert variant="danger" title="Analytics data is unavailable">
                These metrics could not be loaded. This is expected until the
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

  const summary = computeClassSummary(bundle.rows, bundle.rosterSize, PASS_MARK);
  const classLabel =
    bundle.classes.length === 0
      ? "Directly assigned students"
      : bundle.classes.map((cls) => cls.name).join(", ");

  return (
    <>
      <header className="flex shrink-0 flex-col gap-3 border-b border-border bg-surface px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <Breadcrumbs
            items={[
              { label: "Exams", href: "/teacher/exams" },
              { label: bundle.exam.title, href: `/teacher/exams/${bundle.exam.id}` },
              { label: "Class performance" },
            ]}
          />
          <h1 className="mt-1 text-xl font-bold tracking-tight text-ink">
            Class Performance Analytics
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            {bundle.exam.subjectName} · {classLabel} · {formatDuration(bundle.exam.durationMinutes)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link href={`/teacher/exams/${bundle.exam.id}/results`}>
            <Button type="button" variant="secondary" size="sm">
              View results
            </Button>
          </Link>
          <Link href={`/teacher/exams/${bundle.exam.id}`}>
            <Button type="button" variant="ghost" size="sm">
              Back to exam
            </Button>
          </Link>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          {/* Reporting period + sample size, so metrics are interpretable. */}
          <p className="text-xs text-ink-subtle">
            Reporting period: {formatDateTime(bundle.exam.startsAt)} – {formatDateTime(bundle.exam.endsAt)}
            {" · "}
            Sample: {summary.graded} of {bundle.rosterSize} assigned students graded.
            Averages reflect only graded attempts.
          </p>

          <section aria-label="Class summary" className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <SummaryCard
              label="Total students"
              value={String(bundle.rosterSize)}
              tone="brand"
            />
            <SummaryCard
              label="Submitted"
              value={String(summary.graded)}
              sub={formatShare(summary.graded, bundle.rosterSize)}
              tone="success"
            />
            <SummaryCard
              label="Not submitted"
              value={String(summary.notSubmitted)}
              sub={formatShare(summary.notSubmitted, bundle.rosterSize)}
              tone="warning"
            />
            <SummaryCard
              label="Class average"
              value={formatMetricPercent(summary.average)}
              tone="neutral"
            />
            <SummaryCard
              label="Highest score"
              value={formatMetricPercent(summary.highest)}
              tone="success"
            />
            <SummaryCard
              label="Lowest score"
              value={formatMetricPercent(summary.lowest)}
              tone="danger"
            />
          </section>

          {summary.graded === 0 ? (
            <EmptyState
              title="No graded results yet"
              description="Analytics appear once students submit and their attempts are graded. Averages are intentionally blank rather than showing zero, so an untested class never looks like a failed one."
              action={
                <Link href={`/teacher/exams/${bundle.exam.id}`}>
                  <Button type="button" variant="secondary" size="sm">
                    Back to exam
                  </Button>
                </Link>
              }
            />
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <ScoreDistribution rows={bundle.rows} />
                <PassFailOverview
                  passed={summary.passed}
                  failed={summary.failed}
                  notSubmitted={summary.notSubmitted}
                  graded={summary.graded}
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <GradeDistribution rows={bundle.rows} />
                <TopicPerformance rows={bundle.rows} />
                <SubjectPerformance rows={bundle.rows} names={subjectNames} />
              </div>

              <KeyInsights rows={bundle.rows} />

              <StudentTable bundle={bundle} view={view} examId={bundle.exam.id} />
            </>
          )}
        </div>
      </main>
    </>
  );
}
