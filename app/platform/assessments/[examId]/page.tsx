import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { getPlatformAssessmentDetail } from "@/lib/data/platform-assessments";
import type { MetricState } from "@/lib/data/platform-overview";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import { assessmentReleaseLabel, isValidExamId } from "@/lib/platform-assessments";
import { EXAM_STATUS_LABELS, examDisplayState } from "@/lib/exams";
import {
  Alert,
  Badge,
  Breadcrumbs,
  Card,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { PlatformMetricCard } from "@/components/platform/metric-card";
import { DocumentIcon } from "@/components/platform/icons";

export const metadata: Metadata = {
  title: "Assessment Detail",
};

// Reads the live session and route params — never prerendered.
export const instant = false;

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** A metric that is genuinely unknown (failed count) is "unavailable", never
 *  0 — the same rule the overview enforces. */
function countMetric(value: number | null): MetricState<number> {
  return value === null
    ? { state: "unavailable", reason: "error" }
    : { state: "available", value };
}

/**
 * Assessment detail — one exam's operational picture for a Super Admin
 * (read-only). Metadata, structure counts, and attempt/result aggregates
 * only. Question content and answer keys are never selected (AGENTS.md §6),
 * and no lifecycle write is offered here: those belong to the owning
 * institution (AGENTS.md §5). Authorization: SUPER_ADMIN, enforced in the
 * layout and again before the query runs.
 */
export default async function PlatformAssessmentDetailPage({
  params,
}: {
  params: Promise<{ examId: string }>;
}) {
  await connection();
  await requireSuperAdmin({ next: "/platform/assessments" });

  const { examId } = await params;
  // Fail-closed on the URL id before touching the data layer.
  if (!isValidExamId(examId)) notFound();

  let detail: Awaited<ReturnType<typeof getPlatformAssessmentDetail>> = null;
  let dataSourceConfigured = true;
  let loadFailed = false;
  try {
    detail = await getPlatformAssessmentDetail(examId);
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      dataSourceConfigured = false;
    } else {
      loadFailed = true;
    }
  }

  if (!dataSourceConfigured) {
    return (
      <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
          <Alert variant="warning" title="Data source not configured">
            Supabase is not reachable from the server, so this assessment
            cannot be read. No placeholder values are shown.
          </Alert>
        </div>
      </main>
    );
  }

  if (loadFailed) {
    return (
      <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
          <Alert variant="danger" title="Assessment unavailable">
            This exam could not be read right now. Reload to try again.
          </Alert>
        </div>
      </main>
    );
  }

  if (detail === null) notFound();

  const chip = detail.status
    ? examDisplayState(detail.status, detail.startsAt, detail.endsAt, new Date())
    : null;
  const attempts = detail.attempts;
  const results = detail.results;

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        <Breadcrumbs
          items={[
            { label: "Platform", href: "/platform" },
            { label: "Assessments", href: "/platform/assessments" },
            { label: detail.title },
          ]}
        />

        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-ink lg:text-3xl">
              {detail.title}
            </h1>
            {chip ? (
              <Badge tone={chip.tone} dot>
                {chip.label}
              </Badge>
            ) : (
              <Badge tone="neutral">Unknown status</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-ink-muted">
            {detail.institutionId ? (
              <Link
                href={`/platform/institutions/${detail.institutionId}`}
                className="font-medium text-brand hover:underline"
              >
                {detail.institutionName ?? "View institution"}
              </Link>
            ) : (
              "Institution unavailable"
            )}
            {" · "}
            {assessmentReleaseLabel(detail.publishedAt, detail.publishedTo)}
          </p>
        </div>

        {/* Structure + delivery aggregates. Failed counts show "unavailable". */}
        <section aria-label="Assessment summary">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <PlatformMetricCard
              label="Questions"
              metric={countMetric(detail.questionCount)}
              tone="brand"
              icon={<DocumentIcon />}
              hint="Attached bank questions"
            />
            <PlatformMetricCard
              label="Published Snapshot"
              metric={countMetric(detail.snapshotCount)}
              tone="purple"
              icon={<DocumentIcon />}
              hint="Frozen content rows (0011)"
            />
            <PlatformMetricCard
              label="Attempts"
              metric={countMetric(attempts ? attempts.total : null)}
              tone="success"
              icon={<DocumentIcon />}
              hint="All states"
            />
            <PlatformMetricCard
              label="Graded Results"
              metric={countMetric(results ? results.total : null)}
              tone="neutral"
              icon={<DocumentIcon />}
              hint={
                results && results.meanPercentage !== null
                  ? `Mean ${results.meanPercentage}%`
                  : "Mean unavailable"
              }
            />
          </div>
        </section>

        {/* Exam metadata — real columns, "Not set" for nulls, never a guess. */}
        <Card className="overflow-hidden p-0">
          <Table className="rounded-none border-0 shadow-none">
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <MetaRow label="Status" value={detail.status ? EXAM_STATUS_LABELS[detail.status] : "Unknown"} />
              <MetaRow label="Subject" value={detail.subjectName ?? "Not set"} />
              <MetaRow
                label="Duration"
                value={
                  detail.durationMinutes !== null
                    ? `${detail.durationMinutes} minutes`
                    : "Not set"
                }
              />
              <MetaRow label="Starts" value={formatDateTime(detail.startsAt)} />
              <MetaRow label="Ends" value={formatDateTime(detail.endsAt)} />
              <MetaRow label="Published at" value={formatDateTime(detail.publishedAt)} />
              <MetaRow label="Created" value={formatDateTime(detail.createdAt)} />
              <MetaRow
                label="Description"
                value={detail.description ?? "No description"}
              />
            </TableBody>
          </Table>
        </Card>

        {/* Attempt breakdown (bounded read; total shown equals rows scanned). */}
        {attempts ? (
          <Card className="overflow-hidden p-0">
            <div className="border-b border-border px-5 py-3">
              <h2 className="text-base font-semibold text-ink">
                Attempt states ({attempts.total.toLocaleString()} scanned)
              </h2>
            </div>
            <Table className="rounded-none border-0 shadow-none">
              <TableHeader>
                <TableRow>
                  <TableHead>In progress</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Expired</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>{attempts.inProgress.toLocaleString()}</TableCell>
                  <TableCell>{attempts.submitted.toLocaleString()}</TableCell>
                  <TableCell>{attempts.expired.toLocaleString()}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            {attempts.total >= 1000 ? (
              <p className="border-t border-border px-5 py-2 text-xs text-ink-subtle">
                Attempt scan is capped at 1,000 rows; the real total may be
                higher.
              </p>
            ) : null}
          </Card>
        ) : (
          <Alert variant="danger" title="Attempt data unavailable">
            The attempt records for this exam could not be read, so the
            breakdown is unknown — not zero.
          </Alert>
        )}

        {results ? (
          <p className="text-xs leading-5 text-ink-subtle">
            {results.total.toLocaleString()} graded result
            {results.total === 1 ? "" : "s"}; {results.released.toLocaleString()}{" "}
            released to students. The mean covers stored result percentages
            only. No individual student score is shown here — per-student
            results live in the owning institution.
          </p>
        ) : null}
      </div>
    </main>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <TableRow>
      <TableCell className="w-48 font-medium text-ink-muted">{label}</TableCell>
      <TableCell className="text-ink">{value}</TableCell>
    </TableRow>
  );
}
