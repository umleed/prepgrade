import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { INSTITUTION_EXAMS_PATH } from "@/lib/navigation/institution-nav";
import { classBelongsToInstitution } from "@/lib/data/classes";
import { resolveSubjectNames } from "@/lib/data/analytics";
import {
  getInstitutionAnalytics,
  type InstitutionAnalyticsBundle,
} from "@/lib/data/institution-analytics";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  buildMonthlyTrend,
  computeClassBreakdown,
  computeClassSummary,
  computeStudentTopicPerformance,
  computeSubjectPerformance,
  computeTopicPerformance,
  formatMetricPercent,
  formatShare,
  topicAttentionList,
  DEFAULT_PASS_MARK,
  type AnalyticsResultRow,
  type ClassBreakdownRow,
  type MonthlyTrendPoint,
  type TopicPerformance,
} from "@/lib/analytics";
import {
  Alert,
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
  title: "Analytics",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

const PASS_MARK = DEFAULT_PASS_MARK;
const BASE_PATH = "/institution/analytics";

// --- Reporting-period filters -------------------------------------------------

const PERIODS = [
  { key: "all", label: "All time", days: null },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "365", label: "Last 12 months", days: 365 },
] as const;

type Period = (typeof PERIODS)[number];

function resolvePeriod(raw: string | string[] | undefined): Period {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return PERIODS.find((period) => period.key === value) ?? PERIODS[0];
}

/** The current filter state, normalised (unknown ids drop out). */
type Filters = {
  period: string;
  classId: string | null;
  subjectId: string | null;
  topicId: string | null;
};

/**
 * Rebuild the page URL with changed filters. A `null` value clears a filter;
 * anything absent stays as it was. Links (not forms) keep the whole page
 * server-rendered — no client JS needed.
 */
function buildHref(
  current: Filters,
  changes: Partial<Record<keyof Filters, string | null>>,
): string {
  const merged: Filters = {
    period: changes.period ?? current.period,
    classId: changes.classId !== undefined ? changes.classId : current.classId,
    subjectId: changes.subjectId !== undefined ? changes.subjectId : current.subjectId,
    topicId: changes.topicId !== undefined ? changes.topicId : current.topicId,
  };
  const params = new URLSearchParams();
  if (merged.period && merged.period !== "all") params.set("period", merged.period);
  if (merged.classId) params.set("classId", merged.classId);
  if (merged.subjectId) params.set("subjectId", merged.subjectId);
  if (merged.topicId) params.set("topicId", merged.topicId);
  const query = params.toString();
  return query ? `${BASE_PATH}?${query}` : BASE_PATH;
}

// --- Shared display rules (same tones as the per-exam analytics view) ---------

function percentTone(percentage: number): "success" | "warning" | "danger" {
  if (percentage >= 75) return "success";
  if (percentage >= PASS_MARK) return "warning";
  return "danger";
}

const TONE_BAR: Record<"success" | "warning" | "danger" | "brand" | "neutral", string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  brand: "bg-brand",
  neutral: "bg-ink-subtle",
};

const TONE_TEXT: Record<"success" | "warning" | "danger", string> = {
  success: "text-success-strong",
  warning: "text-warning-strong",
  danger: "text-danger-strong",
};

// --- Summary cards ------------------------------------------------------------

function SummaryCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <div className="flex flex-col gap-1 p-4">
        <p className="truncate text-xs text-ink-muted">{label}</p>
        <p className="truncate text-2xl font-bold tracking-tight text-ink tabular-nums">
          {value}
        </p>
        {sub ? <p className="truncate text-2xs text-ink-subtle">{sub}</p> : null}
      </div>
    </Card>
  );
}

// --- Filter bar ----------------------------------------------------------------

function FilterBar({
  filters,
  bundle,
  classNamesById,
  subjectNames,
  topicNames,
}: {
  filters: Filters;
  bundle: InstitutionAnalyticsBundle;
  classNamesById: Map<string, string>;
  subjectNames: Map<string, string>;
  topicNames: Map<string, string>;
}) {
  const activeChips: { label: string; href: string }[] = [];
  if (filters.classId) {
    activeChips.push({
      label: `Class: ${classNamesById.get(filters.classId) ?? "—"}`,
      href: buildHref(filters, { classId: null, topicId: null }),
    });
  }
  if (filters.subjectId) {
    activeChips.push({
      label: `Subject: ${subjectNames.get(filters.subjectId) ?? "—"}`,
      href: buildHref(filters, { subjectId: null, topicId: null }),
    });
  }
  if (filters.topicId) {
    activeChips.push({
      label: `Topic: ${topicNames.get(filters.topicId) ?? "—"}`,
      href: buildHref(filters, { topicId: null }),
    });
  }

  return (
    <section aria-label="Analytics filters" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
          Reporting period
        </span>
        {PERIODS.map((period) => {
          const active = period.key === filters.period;
          return (
            <Link
              key={period.key}
              href={buildHref(filters, { period: period.key })}
              aria-current={active ? "page" : undefined}
              className={
                "rounded-field border px-3 py-1.5 text-sm font-medium transition-colors " +
                (active
                  ? "border-brand bg-brand-50 text-brand-700"
                  : "border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink")
              }
            >
              {period.label}
            </Link>
          );
        })}
      </div>
      {activeChips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            Drill-down
          </span>
          {activeChips.map((chip) => (
            <Link
              key={chip.label}
              href={chip.href}
              className="inline-flex items-center gap-1.5 rounded-field border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:border-brand"
            >
              {chip.label}
              <span aria-hidden="true" className="text-brand-500">
                ×
              </span>
              <span className="sr-only">— clear this filter</span>
            </Link>
          ))}
          <Link
            href={buildHref(filters, { classId: null, subjectId: null, topicId: null })}
            className="text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
          >
            Clear all
          </Link>
        </div>
      ) : null}
      <p className="text-xs text-ink-subtle">
        {bundle.classes.length > 0
          ? "Drill down from the class, subject, and topic tables below — every figure recounts only graded, tenant-scoped results."
          : "Class drill-down arrives once classes exist for your institution."}
      </p>
    </section>
  );
}

// --- Monthly trend --------------------------------------------------------------

function formatMonthKey(month: string): string {
  const [year, part] = month.split("-");
  const date = new Date(Number(year), Number(part) - 1, 1);
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function TrendCard({ points }: { points: MonthlyTrendPoint[] }) {
  if (points.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Monthly trend</h2>
        <p className="mt-2 text-sm text-ink-subtle">
          No dated graded results fall inside this reporting period, so there is
          nothing to trend. This is missing data, not zero.
        </p>
      </Card>
    );
  }
  const max = Math.max(1, ...points.map((point) => point.graded));
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Monthly trend</h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        Graded results per month, with the month&rsquo;s average score. Only
        months with graded results appear.
      </p>
      <div
        role="img"
        aria-label={
          `Monthly trend across ${points.length} ${points.length === 1 ? "month" : "months"}: ` +
          points
            .map((point) => `${formatMonthKey(point.month)}: ${point.graded} graded, average ${formatMetricPercent(point.average)}`)
            .join("; ") +
          "."
        }
        className="mt-4 flex h-40 items-end gap-2"
      >
        {points.map((point) => {
          const heightPct = Math.round((point.graded / max) * 100);
          const tone = percentTone(point.average);
          return (
            <div key={point.month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className="text-2xs font-medium text-ink-subtle tabular-nums">
                {point.graded}
              </span>
              <div className="flex w-full flex-1 items-end">
                <div
                  className={`w-full rounded-t ${TONE_BAR[tone]}`}
                  style={{ height: `${Math.max(heightPct, 4)}%` }}
                  title={`${formatMonthKey(point.month)}: ${point.graded} graded results, ${point.students} students, average ${formatMetricPercent(point.average)}`}
                />
              </div>
              <span className="text-2xs text-ink-subtle">
                {formatMetricPercent(point.average)}
              </span>
              <span className="truncate text-2xs font-medium text-ink">
                {formatMonthKey(point.month)}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-2xs text-ink-subtle">
        Bar height = graded results in the month; the figure under each bar is
        the average score of those results.
      </p>
    </Card>
  );
}

// --- Class breakdown (institution → class drill) --------------------------------

function ClassBreakdownTable({
  rows,
  filters,
}: {
  rows: ClassBreakdownRow[];
  filters: Filters;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-ink">Performance by class</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            Select a class to scope every metric below to its students.
          </p>
        </div>
        {filters.classId ? (
          <Link href={buildHref(filters, { classId: null, topicId: null })}>
            <Button type="button" variant="ghost" size="sm">
              Show all classes
            </Button>
          </Link>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="p-5 text-sm text-ink-subtle">
          No classes with graded results in this period.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Class</TableHead>
              <TableHead numeric>Roster</TableHead>
              <TableHead numeric>Graded</TableHead>
              <TableHead numeric>Average</TableHead>
              <TableHead numeric>Pass rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const active = row.classId !== "" && row.classId === filters.classId;
              const average = row.summary.average;
              const tone = average === null ? null : percentTone(average);
              return (
                <TableRow key={row.classId || "unassigned"}>
                  <TableCell asHeader>
                    {row.classId === "" ? (
                      <span className="font-medium text-ink">{row.className}</span>
                    ) : (
                      <Link
                        href={buildHref(filters, { classId: row.classId, topicId: null })}
                        aria-current={active ? "page" : undefined}
                        className={
                          "font-medium hover:text-brand-700 hover:underline " +
                          (active ? "text-brand-700" : "text-ink")
                        }
                      >
                        {row.className}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell numeric className="text-ink-muted">{row.rosterSize}</TableCell>
                  <TableCell numeric>
                    {row.summary.graded}
                    <span className="text-ink-subtle">
                      {" "}/ {row.studentsGraded} students
                    </span>
                  </TableCell>
                  <TableCell numeric>
                    <span className={tone ? `font-semibold tabular-nums ${TONE_TEXT[tone]}` : "text-ink-subtle"}>
                      {formatMetricPercent(average)}
                    </span>
                  </TableCell>
                  <TableCell numeric className="tabular-nums text-ink-muted">
                    {row.summary.graded > 0
                      ? `${row.summary.passed} passed (${formatShare(row.summary.passed, row.summary.graded)})`
                      : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

// --- Subject performance (class → subject drill) --------------------------------

function SubjectPerformanceCard({
  rows,
  names,
  filters,
  activeSubjectId,
}: {
  rows: AnalyticsResultRow[];
  names: Map<string, string>;
  filters: Filters;
  activeSubjectId: string | null;
}) {
  const labelled: AnalyticsResultRow[] = rows.map((row) => ({
    ...row,
    subjects: row.subjects.map((subject) => ({
      ...subject,
      subjectName: names.get(subject.subjectId) ?? "—",
    })),
  }));
  const subjects = computeSubjectPerformance(labelled).sort(
    (a, b) => (b.percentage ?? -1) - (a.percentage ?? -1),
  );
  if (subjects.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Subject performance</h2>
        <p className="mt-2 text-sm text-ink-subtle">
          No subject breakdown is recorded on the graded results in this scope.
          This is missing data, not zero.
        </p>
      </Card>
    );
  }
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Subject performance</h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        Marks earned vs. available across the period&rsquo;s graded results.
        Select a subject to scope the metrics to results including it.
      </p>
      <ul className="mt-4 flex flex-col gap-3">
        {subjects.map((subject) => {
          const pct = subject.percentage ?? 0;
          const tone = percentTone(pct);
          const active = subject.subjectId === activeSubjectId;
          return (
            <li key={subject.subjectId}>
              <div className="flex items-center justify-between gap-3 text-sm">
                {active || subject.subjectName === "—" ? (
                  <span className={`truncate font-medium ${active ? "text-brand-700" : "text-ink"}`}>
                    {subject.subjectName}
                  </span>
                ) : (
                  <Link
                    href={buildHref(filters, { subjectId: subject.subjectId, topicId: null })}
                    aria-current={active ? "page" : undefined}
                    className="truncate font-medium text-ink hover:text-brand-700 hover:underline"
                  >
                    {subject.subjectName}
                  </Link>
                )}
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
              <p className="mt-0.5 text-2xs text-ink-subtle">
                {subject.score} of {subject.maxScore} marks available
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// --- Weak topics (subject → topic drill) -----------------------------------------

function TopicAttentionCard({
  topics,
  filters,
  activeTopicId,
}: {
  topics: TopicPerformance[];
  filters: Filters;
  activeTopicId: string | null;
}) {
  const attention = topicAttentionList(topics, 5);
  if (attention.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Topics needing attention</h2>
        <p className="mt-2 text-sm text-ink-subtle">
          No topic-tagged questions were answered in the graded results in this
          scope, so no topic accuracy can be reported. This is missing data, not
          zero.
        </p>
      </Card>
    );
  }
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Topics needing attention</h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        Lowest measured accuracy first — a literal ranking of counted answers,
        not a diagnosis. Select a topic to see per-student performance on it.
      </p>
      <ul className="mt-4 flex flex-col gap-3">
        {attention.map((topic) => {
          const accuracy = topic.accuracy ?? 0;
          const tone = percentTone(accuracy);
          const active = topic.topicId === activeTopicId;
          return (
            <li key={topic.topicId}>
              <div className="flex items-center justify-between gap-3 text-sm">
                <Link
                  href={buildHref(filters, { topicId: topic.topicId })}
                  aria-current={active ? "page" : undefined}
                  className={
                    "truncate font-medium hover:text-brand-700 hover:underline " +
                    (active ? "text-brand-700" : "text-ink")
                  }
                >
                  {topic.topicName}
                </Link>
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
      {topics.filter((topic) => topic.accuracy !== null).length < 2 ? (
        <p className="mt-3 text-2xs text-ink-subtle">
          Only one topic carries data in this scope — comparisons between topics
          need at least two.
        </p>
      ) : null}
    </Card>
  );
}

// --- Topic → student drill ---------------------------------------------------------

function TopicStudentsCard({
  rows,
  filters,
  topicName,
}: {
  rows: AnalyticsResultRow[];
  filters: Filters;
  topicName: string;
}) {
  const students = computeStudentTopicPerformance(rows, filters.topicId as string);
  const SHOWN = 25;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-ink">
            Students on &ldquo;{topicName}&rdquo;
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            Accuracy per student across every graded result in scope that
            covered this topic{students.length > SHOWN ? `; showing the top ${SHOWN} of ${students.length}` : ""}.
          </p>
        </div>
        <Link href={buildHref(filters, { topicId: null })}>
          <Button type="button" variant="ghost" size="sm">
            Back to all topics
          </Button>
        </Link>
      </div>
      {students.length === 0 ? (
        <p className="p-5 text-sm text-ink-subtle">
          No graded answers on this topic inside the current scope.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead numeric>#</TableHead>
              <TableHead>Student</TableHead>
              <TableHead>Class</TableHead>
              <TableHead numeric>Correct</TableHead>
              <TableHead numeric>Accuracy</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {students.slice(0, SHOWN).map((student, index) => {
              const accuracy = student.accuracy ?? 0;
              const tone = percentTone(accuracy);
              const rowClass = rows.find((row) => row.studentId === student.studentId);
              return (
                <TableRow key={student.studentId}>
                  <TableCell numeric className="text-ink-subtle">{index + 1}</TableCell>
                  <TableCell asHeader>
                    <Link
                      href={`/institution/students/${student.studentId}`}
                      className="font-medium text-ink hover:text-brand-700 hover:underline"
                    >
                      {student.studentName}
                    </Link>
                  </TableCell>
                  <TableCell>{rowClass?.className ?? "—"}</TableCell>
                  <TableCell numeric>
                    {student.correct}
                    <span className="text-ink-subtle"> / {student.total}</span>
                  </TableCell>
                  <TableCell numeric>
                    <span className={`font-semibold tabular-nums ${TONE_TEXT[tone]}`}>
                      {formatMetricPercent(student.accuracy)}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

// --- Assessments in scope ----------------------------------------------------------

function AssessmentsCard({ rows }: { rows: AnalyticsResultRow[] }) {
  // Group the representative rows by exam, newest first (rows arrive sorted).
  const byExam = new Map<string, { title: string; rows: AnalyticsResultRow[] }>();
  for (const row of rows) {
    if (!row.examId) continue;
    const entry = byExam.get(row.examId);
    if (entry) entry.rows.push(row);
    else byExam.set(row.examId, { title: row.examTitle ?? "—", rows: [row] });
  }
  const exams = [...byExam.entries()];
  if (exams.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Assessments in scope</h2>
        <p className="mt-2 text-sm text-ink-subtle">
          No graded results for any assessment inside the current scope.
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold text-ink">Assessments in scope</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Recounted from stored results. Open an assessment for its full class
          analytics and per-student results.
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Assessment</TableHead>
            <TableHead numeric>Students graded</TableHead>
            <TableHead numeric>Average</TableHead>
            <TableHead numeric>Pass rate</TableHead>
            <TableHead> </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {exams.map(([examId, entry]) => {
            const summary = computeClassSummary(entry.rows, entry.rows.length, PASS_MARK);
            const average = summary.average;
            const tone = average === null ? null : percentTone(average);
            return (
              <TableRow key={examId}>
                <TableCell asHeader className="min-w-40">
                  <span className="font-medium text-ink">{entry.title}</span>
                </TableCell>
                <TableCell numeric>{summary.graded}</TableCell>
                <TableCell numeric>
                  <span className={tone ? `font-semibold tabular-nums ${TONE_TEXT[tone]}` : "text-ink-subtle"}>
                    {formatMetricPercent(average)}
                  </span>
                </TableCell>
                <TableCell numeric className="tabular-nums text-ink-muted">
                  {summary.graded > 0
                    ? `${summary.passed} (${formatShare(summary.passed, summary.graded)})`
                    : "—"}
                </TableCell>
                <TableCell>
                  <Link
                    href={`/teacher/exams/${examId}/analytics`}
                    className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
                  >
                    Class analytics
                  </Link>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

// --- Page ---------------------------------------------------------------------------

/**
 * Institution analytics dashboard (prompt 28) — an institution admin's
 * tenant-wide, descriptive recount of assessment performance.
 *
 * Every number recounts stored, server-graded facts scoped to the admin's own
 * institution (AGENTS.md §5): the period and drill-down filters only narrow
 * that trusted bundle — a client-supplied class/subject/topic id can never
 * widen it, an unknown class id renders not-found, and unknown subject/topic
 * ids simply match nothing. Missing data renders "—" and explanatory empty
 * states, never a fabricated zero or an invented conclusion (AGENTS.md §7);
 * trends exist only where months of data actually support them.
 */
export default async function InstitutionAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{
    period?: string | string[];
    classId?: string | string[];
    subjectId?: string | string[];
    topicId?: string | string[];
  }>;
}) {
  await connection();

  // Layout already gates /institution; enforced again here (defense in depth)
  // because this page's queries must only ever run for an institution admin.
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/analytics",
  });
  const institutionId = principal.institutionId as string;

  const raw = await searchParams;
  const single = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value) || null;
  const period = resolvePeriod(raw.period);

  let bundle: InstitutionAnalyticsBundle | null = null;
  let subjectNames = new Map<string, string>();
  let classValid = true;
  let loadError: "unconfigured" | "unavailable" | null = null;
  const rawClassId = single(raw.classId);

  try {
    bundle = await getInstitutionAnalytics(institutionId, period.days);
    if (rawClassId) {
      classValid = await classBelongsToInstitution(institutionId, rawClassId);
    }
    const subjectIds = bundle.rows.flatMap((row) =>
      row.subjects.map((subject) => subject.subjectId),
    );
    subjectNames = await resolveSubjectNames(institutionId, subjectIds);
  } catch (error) {
    loadError =
      error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  if (!loadError && !bundle) notFound();
  if (!loadError && !classValid) notFound();

  if (loadError || !bundle) {
    return (
      <>
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
          <h1 className="text-xl font-bold tracking-tight text-ink">Analytics</h1>
          <Link href="/institution">
            <Button type="button" variant="ghost" size="sm">
              Back to dashboard
            </Button>
          </Link>
        </header>
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            {loadError === "unconfigured" ? (
              <Alert variant="warning" title="Analytics data is not configured">
                Supabase connection variables are missing on the server.
              </Alert>
            ) : (
              <Alert variant="danger" title="Analytics data is unavailable">
                These metrics could not be loaded. This is expected until the
                results migration is applied to your Supabase project
                (<span className="font-mono">supabase/migrations</span>).
              </Alert>
            )}
          </div>
        </main>
      </>
    );
  }

  // --- Scope the trusted bundle to the (validated) drill-down filters. -------
  const subjectIdPresent = new Set(
    bundle.rows.flatMap((row) => row.subjects.map((subject) => subject.subjectId)),
  );
  const topicIdPresent = new Set(
    bundle.rows.flatMap((row) => row.topics.map((topic) => topic.topicId)),
  );
  const filters: Filters = {
    period: period.key,
    classId: rawClassId,
    subjectId: subjectIdPresent.has(single(raw.subjectId) ?? "")
      ? single(raw.subjectId)
      : null,
    topicId: topicIdPresent.has(single(raw.topicId) ?? "")
      ? single(raw.topicId)
      : null,
  };
  const topicNames = new Map<string, string>();
  for (const row of bundle.rows) {
    for (const topic of row.topics) {
      if (!topicNames.has(topic.topicId)) topicNames.set(topic.topicId, topic.topicName);
    }
  }

  const periodRows = bundle.rows;
  let scopeRows = periodRows;
  if (filters.classId) {
    scopeRows = scopeRows.filter((row) => row.classId === filters.classId);
  }
  if (filters.subjectId) {
    scopeRows = scopeRows.filter((row) =>
      row.subjects.some((subject) => subject.subjectId === filters.subjectId),
    );
  }
  if (filters.topicId) {
    scopeRows = scopeRows.filter((row) =>
      row.topics.some((topic) => topic.topicId === filters.topicId),
    );
  }

  // --- Metrics for the current scope. ----------------------------------------
  const classNamesById = new Map(
    bundle.classes.map((cls) => [cls.id, cls.name]),
  );
  const rosterSize = filters.classId
    ? bundle.classes.find((cls) => cls.id === filters.classId)?.studentCount ?? 0
    : bundle.activeStudents;
  const attemptsInScope = filters.classId
    ? bundle.gradedAttemptsByClass.get(filters.classId) ?? 0
    : bundle.gradedAttempts;

  const summary = computeClassSummary(scopeRows, rosterSize, PASS_MARK);
  const studentsGraded = new Set(scopeRows.map((row) => row.studentId)).size;
  const assessmentsInScope = new Set(
    scopeRows.map((row) => row.examId).filter(Boolean),
  ).size;

  const trend = buildMonthlyTrend(scopeRows).slice(-12);
  // The class table always shows every class (so you can switch), narrowed
  // only by the subject/topic filters — never by the selected class itself.
  let breakdownRowsSource = periodRows;
  if (filters.subjectId) {
    breakdownRowsSource = breakdownRowsSource.filter((row) =>
      row.subjects.some((subject) => subject.subjectId === filters.subjectId),
    );
  }
  if (filters.topicId) {
    breakdownRowsSource = breakdownRowsSource.filter((row) =>
      row.topics.some((topic) => topic.topicId === filters.topicId),
    );
  }
  const breakdown = computeClassBreakdown(bundle.classes, breakdownRowsSource, PASS_MARK);
  const topics = computeTopicPerformance(scopeRows);
  const hasScopedFilters =
    filters.classId !== null ||
    filters.subjectId !== null ||
    filters.topicId !== null;

  return (
    <>
      <header className="flex shrink-0 flex-col gap-3 border-b border-border bg-surface px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <Breadcrumbs
            items={[{ label: "Dashboard", href: "/institution" }, { label: "Analytics" }]}
          />
          <h1 className="mt-1 text-xl font-bold tracking-tight text-ink">
            Institution Analytics
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Assessment performance across your institution — descriptive
            recounts of graded results only.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link href={INSTITUTION_EXAMS_PATH}>
            <Button type="button" variant="secondary" size="sm">
              Assessments
            </Button>
          </Link>
          <Link href="/institution">
            <Button type="button" variant="ghost" size="sm">
              Back to dashboard
            </Button>
          </Link>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <FilterBar
            filters={filters}
            bundle={bundle}
            classNamesById={classNamesById}
            subjectNames={subjectNames}
            topicNames={topicNames}
          />

          {/* Sample-size explainer: what every number below is a recount of. */}
          <p className="text-xs leading-5 text-ink-subtle">
            Reporting period: {period.label}. Sample: {attemptsInScope} graded{" "}
            {attemptsInScope === 1 ? "result" : "results"} (attempts) from{" "}
            {studentsGraded} students
            across {assessmentsInScope} {assessmentsInScope === 1 ? "assessment" : "assessments"}.
            Where a student has several attempts at one assessment, metrics use
            their latest graded result. Averages reflect only graded results —
            nothing here is estimated, and missing data shows &ldquo;—&rdquo;, never 0.
            {bundle.truncated
              ? " Note: this period holds more graded results than one read covers (5,000); figures recount the most recent 5,000 only."
              : ""}
          </p>

          <section
            aria-label="Institution summary"
            className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6"
          >
            <SummaryCard
              label={filters.classId ? "Class roster" : "Active students"}
              value={String(rosterSize)}
            />
            <SummaryCard
              label="Assessments"
              value={String(assessmentsInScope)}
              sub="with graded results in period"
            />
            <SummaryCard
              label="Graded results"
              value={String(attemptsInScope)}
              sub={`from ${studentsGraded} students`}
            />
            <SummaryCard
              label="Average score"
              value={formatMetricPercent(summary.average)}
              sub={summary.graded > 0 ? `from ${summary.graded} results` : "no graded data yet"}
            />
            <SummaryCard
              label="Pass rate"
              value={summary.graded > 0 ? formatShare(summary.passed, summary.graded) : "—"}
              sub={`Pass ≥ ${PASS_MARK}% (reporting, not policy)`}
            />
            <SummaryCard
              label="Completion"
              value={rosterSize > 0 ? formatShare(studentsGraded, rosterSize) : "—"}
              sub={`${studentsGraded} of ${rosterSize} students graded`}
            />
          </section>

          {scopeRows.length === 0 ? (
            <EmptyState
              title="No graded results in this scope"
              description={
                hasScopedFilters
                  ? "The selected period and drill-down filters leave no graded results to recount. Widen the period or clear a filter — an empty scope is shown as empty, never as zero."
                  : "Analytics appear once students submit assessments and their attempts are graded. Averages are intentionally blank rather than showing zero, so an untested institution never reads as a failing one."
              }
              action={
                hasScopedFilters ? (
                  <Link
                    href={buildHref(filters, {
                      classId: null,
                      subjectId: null,
                      topicId: null,
                    })}
                  >
                    <Button type="button" variant="secondary" size="sm">
                      Clear filters
                    </Button>
                  </Link>
                ) : (
                  <Link href={INSTITUTION_EXAMS_PATH}>
                    <Button type="button" variant="secondary" size="sm">
                      Go to assessments
                    </Button>
                  </Link>
                )
              }
            />
          ) : (
            <>
              <TrendCard points={trend} />
              <ClassBreakdownTable rows={breakdown} filters={filters} />
              <div className="grid gap-4 lg:grid-cols-2">
                <SubjectPerformanceCard
                  rows={scopeRows}
                  names={subjectNames}
                  filters={filters}
                  activeSubjectId={filters.subjectId}
                />
                <TopicAttentionCard
                  topics={topics}
                  filters={filters}
                  activeTopicId={filters.topicId}
                />
              </div>
              {filters.topicId ? (
                <TopicStudentsCard
                  rows={scopeRows}
                  filters={filters}
                  topicName={topicNames.get(filters.topicId) ?? "—"}
                />
              ) : null}
              <AssessmentsCard rows={scopeRows} />
            </>
          )}

          <p className="text-xs leading-5 text-ink-subtle">
            Topic figures are reconstructed from recorded answers against each
            question&rsquo;s current topic tag; a question re-tagged in the bank
            after the fact regroup&rsquo;s how historical answers bucket. Subject
            figures come from the frozen breakdown written at grading time.
            Every figure above is scoped to institution{" "}
            <span className="font-mono break-all">{institutionId}</span>.
          </p>
        </div>
      </main>
    </>
  );
}
