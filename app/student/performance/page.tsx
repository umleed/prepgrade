import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getStudentByProfileId } from "@/lib/data/students";
import {
  getStudentPerformance,
  type StudentPerformanceBundle,
} from "@/lib/data/student-analytics";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  computeSubjectPerformance,
  computeTopicPerformance,
  formatMetricPercent,
  DEFAULT_PASS_MARK,
  type TopicPerformance,
} from "@/lib/analytics";
import {
  computeStudentTrend,
  sampleConfidence,
  sampleConfidenceLabel,
  studentAreaHighlightsFromRows,
  summarizeStudentPerformance,
  type SampleConfidence,
} from "@/lib/student-performance";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  type BadgeTone,
} from "@/components/ui";

export const metadata: Metadata = {
  title: "My Performance",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

const PASS_MARK = DEFAULT_PASS_MARK;

// --- Shared display rules (same tones as the staff analytics views) ----------

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

const CONFIDENCE_TONE: Record<SampleConfidence, BadgeTone> = {
  none: "neutral",
  insufficient: "neutral",
  low: "warning",
  adequate: "info",
};

function formatGradedDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

// --- Summary cards -----------------------------------------------------------

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
      <div className="flex flex-col gap-1 p-5">
        <p className="truncate text-sm text-ink-muted">{label}</p>
        <p className="text-2xl font-bold tracking-tight text-ink tabular-nums">
          {value}
        </p>
        {sub ? <p className="text-2xs leading-4 text-ink-subtle">{sub}</p> : null}
      </div>
    </Card>
  );
}

// --- Trend -------------------------------------------------------------------

const TREND_BADGE: Record<"improving" | "steady" | "needs_support", {
  tone: BadgeTone;
  label: string;
}> = {
  improving: { tone: "success", label: "Improving" },
  steady: { tone: "info", label: "Steady" },
  needs_support: { tone: "warning", label: "A dip to work on" },
};

function TrendCard({ trend }: { trend: ReturnType<typeof computeStudentTrend> }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">Your overall trend</h2>
        {trend.direction ? (
          <Badge tone={TREND_BADGE[trend.direction].tone} dot>
            {TREND_BADGE[trend.direction].label}
          </Badge>
        ) : (
          <Badge tone="neutral" dot>
            Not enough yet
          </Badge>
        )}
      </div>
      <p className="mt-2 text-sm leading-6 text-ink-muted">{trend.note}</p>
      {trend.direction && trend.earlierAverage !== null && trend.recentAverage !== null ? (
        <p className="mt-3 text-2xs text-ink-subtle">
          Earlier results averaged {formatMetricPercent(trend.earlierAverage)}; your
          most recent averaged {formatMetricPercent(trend.recentAverage)}, across{" "}
          {trend.releasedResults} released{" "}
          {trend.releasedResults === 1 ? "result" : "results"}. This describes what
          has already been recorded — it is not a prediction of a future score.
        </p>
      ) : null}
    </Card>
  );
}

// --- Subject accuracy --------------------------------------------------------

function SubjectAccuracy({ bundle }: { bundle: StudentPerformanceBundle }) {
  const subjects = computeSubjectPerformance(bundle.rows).sort(
    (a, b) => (b.percentage ?? -1) - (a.percentage ?? -1),
  );
  if (subjects.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Subject accuracy</h2>
        <p className="mt-2 text-sm text-ink-subtle">
          No subject breakdown is recorded for your released results yet. This is
          missing data, not a score of zero.
        </p>
      </Card>
    );
  }
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Subject accuracy</h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        Marks you earned vs. marks available, per subject.
      </p>
      <ul className="mt-4 flex flex-col gap-3">
        {subjects.map((subject) => {
          const pct = subject.percentage ?? 0;
          const tone = percentTone(pct);
          return (
            <li key={subject.subjectId}>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-medium text-ink">
                  {subject.subjectName}
                </span>
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
                aria-label={`${subject.subjectName}: ${formatMetricPercent(subject.percentage)}`}
              >
                <div
                  className={`h-full ${TONE_BAR[tone]}`}
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
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

// --- Topic accuracy (with per-area sample sizes) -----------------------------

function TopicRow({ topic }: { topic: TopicPerformance }) {
  const accuracy = topic.accuracy ?? 0;
  const tone = percentTone(accuracy);
  const confidence = sampleConfidence(topic.total);
  return (
    <li>
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
        aria-label={`${topic.topicName}: ${formatMetricPercent(topic.accuracy)} accuracy`}
      >
        <div
          className={`h-full ${TONE_BAR[tone]}`}
          style={{ width: `${Math.min(100, accuracy)}%` }}
        />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <p className="text-2xs text-ink-subtle">
          {topic.correct} of {topic.total}{" "}
          {topic.total === 1 ? "question" : "questions"} correct
        </p>
        {confidence !== "adequate" ? (
          <Badge tone={CONFIDENCE_TONE[confidence]} variant="soft">
            {sampleConfidenceLabel(confidence)}
          </Badge>
        ) : null}
      </div>
    </li>
  );
}

function TopicAccuracy({ bundle }: { bundle: StudentPerformanceBundle }) {
  const topics = computeTopicPerformance(bundle.rows).sort(
    (a, b) => (b.accuracy ?? -1) - (a.accuracy ?? -1),
  );
  if (topics.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Topic accuracy</h2>
        <p className="mt-2 text-sm text-ink-subtle">
          Topic accuracy appears once your released results include topic-tagged
          questions. This is missing data, not a score of zero.
        </p>
      </Card>
    );
  }
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Topic accuracy</h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        Your accuracy per topic, from your released answers. A “Limited data” tag
        means only a few questions were answered — treat it as a hint, not a
        verdict.
      </p>
      <ul className="mt-4 flex flex-col gap-3">
        {topics.map((topic) => (
          <TopicRow key={topic.topicId} topic={topic} />
        ))}
      </ul>
    </Card>
  );
}

// --- Strongest / focus areas -------------------------------------------------

function AreasCard({ bundle }: { bundle: StudentPerformanceBundle }) {
  const highlights = studentAreaHighlightsFromRows(bundle.rows);

  if (highlights.reason) {
    return (
      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Strongest &amp; focus areas</h2>
        <p className="mt-2 text-sm text-ink-subtle">{highlights.reason}</p>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Strongest &amp; focus areas</h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        A summary of recorded accuracy across{" "}
        {highlights.comparableAreas} topics with enough questions — a description
        of what has happened, not a diagnosis.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {highlights.strongest ? (
          <div className="rounded-card border border-border bg-surface-muted p-4">
            <p className="text-2xs font-semibold uppercase tracking-wide text-success-strong">
              Your strength
            </p>
            <p className="mt-1 text-sm font-semibold text-ink">
              {highlights.strongest.topicName}
            </p>
            <p className="mt-1 text-2xs text-ink-subtle">
              {formatMetricPercent(highlights.strongest.accuracy)} across{" "}
              {highlights.strongest.total} questions — a good place to build
              confidence.
            </p>
          </div>
        ) : null}
        {highlights.weakest ? (
          <div className="rounded-card border border-border bg-surface-muted p-4">
            <p className="text-2xs font-semibold uppercase tracking-wide text-warning-strong">
              Worth some attention
            </p>
            <p className="mt-1 text-sm font-semibold text-ink">
              {highlights.weakest.topicName}
            </p>
            <p className="mt-1 text-2xs text-ink-subtle">
              {formatMetricPercent(highlights.weakest.accuracy)} across{" "}
              {highlights.weakest.total} questions — a little focused revision here
              could lift your average.
            </p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// --- Released results links --------------------------------------------------

function RecentResults({ bundle }: { bundle: StudentPerformanceBundle }) {
  const links = bundle.releasedLinks.slice(0, 6);
  if (links.length === 0) return null;
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">Released results</h2>
        <Link
          href="/student/results"
          className="text-sm text-brand-700 underline-offset-2 hover:underline"
        >
          View all
        </Link>
      </div>
      <ul className="mt-3 flex flex-col divide-y divide-border">
        {links.map((link) => {
          const tone = percentTone(link.percentage);
          return (
            <li key={link.resultId} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <Link
                  href={`/student/results/${link.resultId}`}
                  className="truncate text-sm font-medium text-ink hover:text-brand-700 hover:underline"
                >
                  {link.examTitle}
                </Link>
                <p className="truncate text-2xs text-ink-subtle">
                  {link.subjectName} · {formatGradedDate(link.gradedAt)}
                </p>
              </div>
              <span className={`shrink-0 text-sm font-semibold tabular-nums ${TONE_TEXT[tone]}`}>
                {formatMetricPercent(link.percentage)}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// --- Page --------------------------------------------------------------------

/**
 * My Performance (prompt 29) — the student's own performance overview.
 *
 * Everything shown is the student's OWN released, server-graded data, read via a
 * query that pins both the trusted tenant and the verified student id — no other
 * student's data or institution-wide private figures can reach this page
 * (AGENTS.md §5). Unreleased results are counted only as "awaiting release";
 * their numbers never enter any metric, because the shared release gate stripped
 * them upstream (AGENTS.md §6). Every figure is a descriptive recount with its
 * sample size shown, small samples are flagged rather than labelled, and no
 * predictive or AI recommendation is made (AGENTS.md §7, prompt 29). Loading,
 * empty, error, and unlinked states are all explicit.
 */
export default async function StudentPerformancePage() {
  await connection();

  const principal = await requireRole(["STUDENT"], { next: "/student/performance" });
  const institutionId = principal.institutionId as string;

  let bundle: StudentPerformanceBundle | null = null;
  let loadError: "unconfigured" | "unavailable" | "unlinked" | null = null;

  try {
    const student = await getStudentByProfileId(institutionId, principal.userId);
    if (!student) {
      loadError = "unlinked";
    } else {
      bundle = await getStudentPerformance(institutionId, student.id);
    }
  } catch (error) {
    loadError =
      error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  return (
    <>
      <header className="flex shrink-0 flex-col gap-1 border-b border-border bg-surface px-6 py-4">
        <h1 className="text-xl font-bold tracking-tight text-ink">My Performance</h1>
        <p className="text-sm text-ink-muted">
          A summary of your own released results — what the recorded data shows,
          explained honestly.
        </p>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          {loadError === "unconfigured" ? (
            <Alert variant="warning" title="Performance data is not configured">
              Supabase connection variables are missing on the server. Set
              <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
              <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to load
              your performance.
            </Alert>
          ) : loadError === "unavailable" ? (
            <Alert variant="danger" title="Your performance could not be loaded">
              The data source is unavailable right now. Nothing is shown rather
              than anything unverified — please reload, and tell your
              institution&apos;s admin if it persists.
            </Alert>
          ) : loadError === "unlinked" ? (
            <EmptyState
              title="Your account isn't linked to a student record yet"
              description="Your performance is drawn from your institution's student roster, linked to your sign-in. Until it's connected there is nothing to summarise for you. Ask your institution's admin to connect it."
              action={
                <Link href="/student/results">
                  <Button type="button" variant="secondary" size="sm">
                    Go to My Results
                  </Button>
                </Link>
              }
            />
          ) : !bundle || bundle.rows.length === 0 ? (
            <EmptyState
              title="No released results to summarise yet"
              description={
                bundle && bundle.pendingResults > 0
                  ? `You have ${bundle.pendingResults} graded ${
                      bundle.pendingResults === 1 ? "result" : "results"
                    } awaiting release. Your performance appears here once your institution releases them — results are only counted after they're released to you.`
                  : "Once you complete an assessment and it's graded and released, your trend, subject and topic accuracy build up here. Scores never appear before your institution releases them."
              }
              action={
                <Link href="/student/exams">
                  <Button type="button" variant="secondary" size="sm">
                    Go to My Exams
                  </Button>
                </Link>
              }
            />
          ) : (
            <PerformanceBody bundle={bundle} />
          )}
        </div>
      </main>
    </>
  );
}

function PerformanceBody({ bundle }: { bundle: StudentPerformanceBundle }) {
  const summary = summarizeStudentPerformance(bundle.rows, bundle.pendingResults);
  const trend = computeStudentTrend(bundle.rows);

  return (
    <>
      <p className="text-xs text-ink-subtle">
        Based on {summary.releasedResults} released{" "}
        {summary.releasedResults === 1 ? "result" : "results"} and{" "}
        {summary.totalQuestions} answered{" "}
        {summary.totalQuestions === 1 ? "question" : "questions"}. Only released
        results are counted, so the sample may be smaller than everything you have
        sat.
      </p>

      <section
        aria-label="Performance summary"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <SummaryCard
          label="Average score"
          value={
            summary.averagePercentage === null
              ? "—"
              : formatMetricPercent(summary.averagePercentage)
          }
          sub={
            summary.confidence !== "adequate"
              ? sampleConfidenceLabel(summary.confidence)
              : `Across ${summary.releasedResults} released results`
          }
        />
        <SummaryCard
          label="Released results"
          value={String(summary.releasedResults)}
          sub={
            summary.pendingResults > 0
              ? `${summary.pendingResults} awaiting release`
              : "All graded results released"
          }
        />
        <SummaryCard
          label="Questions answered"
          value={String(summary.totalQuestions)}
          sub="Across your released results"
        />
        <SummaryCard
          label="Best result"
          value={
            summary.bestResult
              ? formatMetricPercent(summary.bestResult.percentage)
              : "—"
          }
          sub={summary.bestResult?.examTitle}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <TrendCard trend={trend} />
        <AreasCard bundle={bundle} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SubjectAccuracy bundle={bundle} />
        <TopicAccuracy bundle={bundle} />
      </div>

      <RecentResults bundle={bundle} />
    </>
  );
}
