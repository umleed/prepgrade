import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { roleLabel, type UserRole } from "@/lib/auth/roles";
import { platformAuditActionLabel } from "@/lib/audit/platform";
import {
  getUsageSnapshot,
  getUsageTimeSeries,
  listInstitutionOptions,
  listUsageActivity,
  type InstitutionOptionsResult,
  type UsageActivityRow,
  type UsageSeriesState,
} from "@/lib/data/platform-usage";
import type { MetricState } from "@/lib/data/platform-overview";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  USAGE_ACTIVITY_CATEGORIES,
  USAGE_ACTIVITY_CATEGORY_LABELS,
  USAGE_GRANULARITY_LABELS,
  USAGE_RANGE_PRESETS,
  USAGE_TIMEZONE,
  applicableSeriesFor,
  buildUsageBuckets,
  categorizeAuditAction,
  resolveUsageFilters,
  resolveUsageRange,
  seriesHaveNoActivity,
  usageHref,
  type UsageHrefState,
} from "@/lib/platform-usage";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Pagination,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type BadgeTone,
} from "@/components/ui";
import { SectionHeading } from "@/components/platform/activity-feed";
import { PanelNote } from "@/components/platform/panel-note";
import { PlatformMetricCard } from "@/components/platform/metric-card";
import { TrendChart, type TrendChartSeries } from "@/components/platform/trend-chart";
import {
  BuildingIcon,
  CalendarIcon,
  ClockIcon,
  DocumentIcon,
  GridIcon,
  ShieldIcon,
  UsersIcon,
} from "@/components/platform/icons";

export const metadata: Metadata = {
  title: "Usage & Activity",
};

// Reads the live session, live counts, and query params — never prerendered.
export const instant = false;

const BASE_PATH = "/platform/usage";

/** Series colors from design tokens — same wiring as the donut chart. */
const SERIES_COLORS: Record<string, string> = {
  institutions: "var(--color-accent-purple)",
  accounts: "var(--color-brand-600)",
  questions: "var(--color-success)",
  exams: "var(--color-warning)",
  exam_attempts: "var(--color-info)",
};

const OUTCOME_TONES: Record<string, BadgeTone> = {
  success: "success",
  failed: "warning",
  denied: "danger",
};

/** Actor labels mirroring the audit screen: the two non-role values get
 *  their own honest wording instead of roleLabel's "Unassigned" default. */
function actorRoleLabel(role: string): string {
  if (role === "unknown") return "Unknown (anonymous)";
  if (role === "unassigned") return "Unassigned";
  return roleLabel(role as UserRole);
}

/** The storage/quota metric has NO data source in the schema (no usage,
 *  quota, or storage tables in migrations 0001–0017). Rendered as a pinned
 *  "Not available" tile — the truthful alternative, never a fabricated 0. */
const STORAGE_METRIC_UNAVAILABLE: MetricState<number> = {
  state: "unavailable",
  reason: "missing_table",
};

/** Audit timestamps are absolute; the screen's timezone definition is UTC. */
function formatUtcTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

function formatUtcDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Institution usage & platform activity — the super-admin operational view.
 *
 * SUPER_ADMIN only, enforced server-side twice (layout + this page). The
 * screen separates CURRENT USAGE (live head-counts as of now) from ACTIVITY
 * OVER TIME (UTC-bucketed creation counts from the 0018 SQL aggregate).
 * Metrics with no real data source (storage/quota consumption) state that
 * plainly; a successful empty window says "no activity in this period"; a
 * failed query never renders as zero. Personal-data minimization (AGENTS.md
 * §7): counts, institution names, and audit actor ids only — no learner rows.
 */
export default async function PlatformUsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  // Guard BEFORE any cross-tenant read; a denial's redirect() must propagate
  // untouched (same ordering as /platform/audit).
  await requireSuperAdmin({ next: BASE_PATH });

  const params = await searchParams;
  const now = new Date();
  const range = resolveUsageRange(params, now);
  const buckets = buildUsageBuckets(range.fromMs, range.toMs, range.granularity);
  const filters = resolveUsageFilters(params);
  const { sources, omitted } = applicableSeriesFor(filters.institution);

  const hrefState: UsageHrefState = {
    from: range.preset === null ? range.fromDay : null,
    to: range.preset === null ? range.toDay : null,
    preset: range.preset,
    institution: filters.institution,
    category: filters.category,
    page: filters.page,
  };

  // Independent degradation everywhere: one failed read changes one panel,
  // never the whole page, and never to a disguised zero.
  const snapshot = await getUsageSnapshot(filters.institution);
  const seriesState: UsageSeriesState = await getUsageTimeSeries(
    range,
    buckets,
    sources,
    filters.institution,
  );

  let options: InstitutionOptionsResult | null = null;
  try {
    options = await listInstitutionOptions();
  } catch {
    options = null;
  }

  let activity: Awaited<ReturnType<typeof listUsageActivity>> | null = null;
  let activityFailed = false;
  let activityDataSource = true;
  try {
    activity = await listUsageActivity({
      range,
      institution: filters.institution,
      category: filters.category,
      page: filters.page,
      pageSize: filters.pageSize,
    });
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      activityDataSource = false;
    } else {
      activityFailed = true;
    }
  }

  const totalEvents = filters.institution
    ? "events attributed to this institution"
    : "platform-wide events";

  const chartSeries: TrendChartSeries[] =
    seriesState.state === "available"
      ? seriesState.series.map((s) => ({
          label: s.label,
          color: SERIES_COLORS[s.source] ?? "var(--color-brand-600)",
          points: s.points,
        }))
      : [];

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        {/* Title + window chip */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink lg:text-3xl">
              Usage &amp; Activity
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              Current platform usage and activity over time. Every figure is a
              live query; {USAGE_TIMEZONE} defines all dates, windows, and
              buckets.
            </p>
          </div>
          <span className="flex items-center gap-2 rounded-field border border-border bg-surface px-3 py-2 text-sm font-medium text-ink-muted">
            <CalendarIcon className="h-4 w-4 text-ink-subtle" />
            {formatUtcDay(range.fromMs)} – {formatUtcDay(range.toMs - 1)} ·{" "}
            {USAGE_GRANULARITY_LABELS[range.granularity]}
          </span>
        </div>

        {snapshot.totalInstitutions.state === "unavailable" &&
        snapshot.totalInstitutions.reason === "error" ? (
          <Alert variant="warning" title="Data source unavailable">
            Supabase could not be reached, so no usage counts are shown — a
            connection failure never renders as a zero. Check the server
            environment configuration and reload.
          </Alert>
        ) : null}

        {filters.rejectedInstitutionFilter ? (
          <Alert variant="warning" title="Institution filter ignored">
            The institution value in the URL is not a valid institution id, so
            it was refused rather than applied. The view shows all institutions
            — pick one from the filter list to narrow it.
          </Alert>
        ) : null}

        {range.clamped ? (
          <Alert variant="info" title="Window shortened">
            The requested range exceeded the 366-day limit, so it was shortened
            to the most recent 366 days.
          </Alert>
        ) : null}

        {/* --- Date-range + institution filters (server-side GET form) ------ */}
        <Card>
          <div className="flex flex-col gap-4 p-5">
            <SectionHeading
              title="Filters"
              description="Date range and institution apply server-side to both panels below."
            />
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Date range presets">
              {USAGE_RANGE_PRESETS.map((days) => {
                const active = range.preset === days;
                return (
                  <Link
                    key={days}
                    href={usageHref(BASE_PATH, hrefState, {
                      preset: days,
                      from: null,
                      to: null,
                    })}
                  >
                    <Button type="button" size="sm" variant={active ? "primary" : "secondary"}>
                      Last {days} days
                    </Button>
                  </Link>
                );
              })}
            </div>
            <form method="GET" action={BASE_PATH} className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="usage-from">From (UTC)</Label>
                <Input
                  id="usage-from"
                  type="date"
                  name="from"
                  defaultValue={range.fromDay}
                  className="w-40"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="usage-to">To (UTC, inclusive)</Label>
                <Input
                  id="usage-to"
                  type="date"
                  name="to"
                  defaultValue={range.toDay}
                  className="w-40"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="usage-institution">Institution</Label>
                <Select
                  id="usage-institution"
                  name="institution"
                  defaultValue={filters.institution ?? ""}
                  className="w-64"
                >
                  <option value="">All institutions</option>
                  {options?.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              </div>
              {filters.category ? (
                <input type="hidden" name="category" value={filters.category} />
              ) : null}
              <Button type="submit" size="sm" variant="secondary">
                Apply
              </Button>
              <Link href={BASE_PATH}>
                <Button type="button" size="sm" variant="ghost">
                  Reset
                </Button>
              </Link>
            </form>
            {options === null ? (
              <p className="text-2xs leading-4 text-ink-subtle">
                The institution list could not be loaded, so the dropdown only
                offers &quot;All institutions&quot;. Paste an institution link
                from the directory to filter by tenant.
              </p>
            ) : options.truncated ? (
              <p className="text-2xs leading-4 text-ink-subtle">
                Showing the first {options.options.length} of{" "}
                {options.total.toLocaleString()} institutions alphabetically —
                the list is capped, not complete.
              </p>
            ) : null}
          </div>
        </Card>

        {/* --- Current usage (live head-counts, as of now) ------------------ */}
        <section aria-label="Current usage">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Current usage — totals as of now
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <PlatformMetricCard
              label="Active institutions"
              metric={snapshot.activeInstitutions}
              tone="purple"
              icon={<BuildingIcon />}
              hint={
                snapshot.totalInstitutions.state === "available"
                  ? `status = active, of ${snapshot.totalInstitutions.value.toLocaleString()} created`
                  : "Operational status flag (status = active)"
              }
              missingHint="Not yet available — institutions table missing"
              href={filters.institution ? `${BASE_PATH}?institution=${filters.institution}` : "/platform/institutions"}
            />
            {filters.institution ? (
              <PlatformMetricCard
                label="Members (this institution)"
                metric={snapshot.members}
                tone="brand"
                icon={<UsersIcon />}
                hint="institution_memberships rows — the tenant-attributable user count"
                missingHint="Temporarily unavailable — memberships could not be read"
                href={`/platform/institutions/${filters.institution}?tab=users`}
              />
            ) : (
              <PlatformMetricCard
                label="Registered accounts"
                metric={snapshot.accounts}
                tone="brand"
                icon={<UsersIcon />}
                hint={
                  snapshot.activeAccounts.state === "available"
                    ? `${snapshot.activeAccounts.value.toLocaleString()} active (profiles.is_active)`
                    : "Provisioned platform accounts (profiles rows)"
                }
                missingHint="Not yet available — profiles table missing"
              />
            )}
            <PlatformMetricCard
              label="Active questions"
              metric={snapshot.questions}
              tone="success"
              icon={<GridIcon />}
              hint="Live question-bank items (status = active)"
              missingHint="Not yet available — questions table missing"
            />
            <PlatformMetricCard
              label="Exams created"
              metric={snapshot.exams}
              tone="warning"
              icon={<DocumentIcon />}
              hint={
                snapshot.publishedExams.state === "available"
                  ? `${snapshot.publishedExams.value.toLocaleString()} published`
                  : "All exam rows, any status"
              }
              missingHint="Not yet available — exams table missing"
            />
            <PlatformMetricCard
              label="Exam attempts"
              metric={snapshot.attempts}
              tone="neutral"
              icon={<ClockIcon />}
              hint={
                snapshot.submittedAttempts.state === "available"
                  ? `${snapshot.submittedAttempts.value.toLocaleString()} submitted`
                  : "Attempts started (exam_attempts rows)"
              }
              missingHint="Not yet available — attempts table missing"
            />
            <PlatformMetricCard
              label="Storage & quota usage"
              metric={STORAGE_METRIC_UNAVAILABLE}
              tone="neutral"
              icon={<ShieldIcon />}
              missingHint="Not available — the platform does not track storage or quotas yet"
            />
          </div>
        </section>

        {/* --- Activity over time (UTC buckets, real aggregates) ------------ */}
        <section aria-label="Activity over time">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Activity over time — {totalEvents}
          </h2>
          <Card>
            <div className="flex flex-col gap-4 p-5">
              <SectionHeading
                title="Creation activity per calendar bucket"
                description={`New institutions, accounts, questions, exams, and attempts started, counted in UTC ${USAGE_GRANULARITY_LABELS[range.granularity]} buckets${
                  range.granularity === "week" ? " (weeks start Monday)" : ""
                }.`}
              />
              {seriesState.state === "available" ? (
                <>
                  <TrendChart
                    buckets={buckets}
                    series={chartSeries}
                    unitLabel={`new records ${USAGE_GRANULARITY_LABELS[range.granularity]} (UTC)`}
                    emptyNote={
                      seriesHaveNoActivity(seriesState.series)
                        ? "No activity in this period — the query succeeded and every bucket is a real zero, not missing data."
                        : undefined
                    }
                  />
                  {omitted.length > 0 ? (
                    <p className="text-2xs leading-4 text-ink-subtle">
                      &quot;New registered accounts&quot; is hidden while an
                      institution filter is active: accounts carry no tenant
                      column, so a platform-wide total must never be charted as
                      one institution&apos;s figure.
                    </p>
                  ) : null}
                </>
              ) : (
                <PanelNote>
                  {seriesState.reason === "missing_table"
                    ? "Time-series aggregates are not available in this environment — the usage query function has not been migrated in (supabase/migrations/0018). No sample curve is invented in the meantime."
                    : "Temporarily unavailable — the aggregate query failed. This is not zero usage; the counts above are unaffected."}
                </PanelNote>
              )}
            </div>
          </Card>
        </section>

        {/* --- Server-filtered activity table -------------------------------- */}
        <section aria-label="Platform activity log">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Platform activity in this period
          </h2>
          <Card>
            <div className="flex flex-col gap-4 p-5">
              <SectionHeading
                title="Activity log"
                description={
                  filters.institution
                    ? "Audit events directly attributed to the filtered institution (server-side filter)."
                    : "Append-only platform audit events within the selected window."
                }
                viewAllHref="/platform/audit"
                viewAllLabel="Full audit log"
              />

              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Activity category filters">
                <span className="text-xs font-medium text-ink-muted">Category:</span>
                <Link href={usageHref(BASE_PATH, hrefState, { category: null })}>
                  <Button type="button" size="sm" variant={filters.category === null ? "primary" : "secondary"}>
                    All
                  </Button>
                </Link>
                {USAGE_ACTIVITY_CATEGORIES.map((category) => (
                  <Link
                    key={category}
                    href={usageHref(BASE_PATH, hrefState, { category })}
                  >
                    <Button
                      type="button"
                      size="sm"
                      variant={filters.category === category ? "primary" : "secondary"}
                    >
                      {USAGE_ACTIVITY_CATEGORY_LABELS[category]}
                    </Button>
                  </Link>
                ))}
              </div>

              {!activityDataSource ? (
                <Alert variant="warning" title="Data source not configured">
                  Supabase is not reachable from the server, so the activity
                  log cannot be read. Nothing is shown in place of real records.
                </Alert>
              ) : activityFailed ? (
                <Alert variant="danger" title="Activity unavailable">
                  The activity entries could not be read (the audit table may
                  not be migrated in this environment yet). This is a failure,
                  not &quot;no activity&quot; — reload to try again.
                </Alert>
              ) : activity && activity.rows.length === 0 ? (
                <EmptyState
                  title="No activity in this period"
                  description={
                    filters.category || filters.institution
                      ? "No events match the current window and filters. Widen the date range or clear a filter."
                      : "The audit query succeeded and found nothing in this window — nothing happened; logging is not broken."
                  }
                />
              ) : activity && activity.rows.length > 0 ? (
                <>
                  {activity.namesUnavailable ? (
                    <p className="text-2xs leading-4 text-ink-subtle">
                      Institution names could not be loaded, so the table shows
                      institution ids instead.
                    </p>
                  ) : null}
                  <div className="overflow-x-auto">
                    <Table className="rounded-none border-0 shadow-none">
                      <TableHeader>
                        <TableRow>
                          <TableHead>When (UTC)</TableHead>
                          <TableHead>Institution</TableHead>
                          <TableHead>Category</TableHead>
                          <TableHead>Event</TableHead>
                          <TableHead>Actor</TableHead>
                          <TableHead>Outcome</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {activity.rows.map((row: UsageActivityRow) => {
                          const category = categorizeAuditAction(row.action);
                          return (
                            <TableRow key={row.id}>
                              <TableCell className="whitespace-nowrap text-ink-muted">
                                <time dateTime={row.createdAt}>
                                  {formatUtcTimestamp(row.createdAt)}
                                </time>
                              </TableCell>
                              <TableCell>
                                {row.linksToInstitution && row.targetId ? (
                                  <Link
                                    href={`/platform/institutions/${row.targetId}`}
                                    className="font-medium text-brand hover:underline"
                                  >
                                    {row.institutionName ?? `Institution ${row.targetId.slice(0, 8)}…`}
                                  </Link>
                                ) : (
                                  <span className="text-ink-subtle" title="Not attributed to one institution">
                                    —
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                {category ? (
                                  USAGE_ACTIVITY_CATEGORY_LABELS[category]
                                ) : (
                                  <span title="Out-of-catalog stored action — shown raw, never reclassified">
                                    Other
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                <p className="font-medium text-ink">
                                  {platformAuditActionLabel(row.action)}
                                </p>
                                {row.summary ? (
                                  <p className="text-xs text-ink-muted">{row.summary}</p>
                                ) : null}
                              </TableCell>
                              <TableCell>
                                <span className="font-mono text-2xs break-all">{row.actorId}</span>
                                <p className="text-2xs text-ink-subtle">
                                  {actorRoleLabel(row.actorRole)}
                                </p>
                              </TableCell>
                              <TableCell>
                                <Badge tone={OUTCOME_TONES[row.outcome] ?? "neutral"} dot>
                                  {row.outcome}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  <Pagination
                    page={filters.page}
                    totalPages={Math.max(1, Math.ceil(activity.total / filters.pageSize))}
                    hrefFor={(page) => usageHref(BASE_PATH, hrefState, { page })}
                    label="Platform activity pages"
                  />
                </>
              ) : null}
            </div>
          </Card>
        </section>

        {/* --- Metric definitions (every time-based metric is defined) ------ */}
        <Card>
          <div className="flex flex-col gap-2 p-5">
            <h2 className="text-sm font-semibold text-ink">How each figure is defined</h2>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-xs leading-5 text-ink-muted">
              <li>
                <strong>Time zone:</strong> all windows, buckets, and log
                timestamps are UTC; windows are half-open [from, to).
              </li>
              <li>
                <strong>Active institutions:</strong> rows with the operational
                status flag &quot;active&quot; (0008) — a suspension marker,
                not an access-enforced session state.
              </li>
              <li>
                <strong>Registered accounts:</strong> rows in the platform
                profile table. This is never presented as an
                &quot;active users&quot; count; the active hint uses
                is_active only. Under an institution filter the tenant
                membership count replaces it.
              </li>
              <li>
                <strong>Questions created / exams created:</strong> rows per
                creation bucket, all statuses (rows are archived, never
                deleted).
              </li>
              <li>
                <strong>Exam attempts:</strong> attempts started, counted at
                attempt creation; the card hint reports submitted attempts.
              </li>
              <li>
                <strong>Storage &amp; quota:</strong> no data source exists in
                the platform schema, so the metric states
                &quot;Not available&quot; instead of a number.
              </li>
              <li>
                <strong>Activity attribution:</strong> audit rows carry no
                tenant column; only rows the server tagged with an institution
                target appear under an institution filter.
              </li>
            </ul>
          </div>
        </Card>
      </div>
    </main>
  );
}
