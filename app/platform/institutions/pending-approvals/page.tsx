import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { inspectAccess } from "@/lib/auth/guards";
import {
  getApplicationSummaryCounts,
  getInstitutionApplicationDetail,
  listInstitutionApplications,
  type ApplicationList,
  type ApplicationSummaryCounts,
} from "@/lib/data/institution-applications";
import { listApplicationDecisionActivity } from "@/lib/data/audit";
import type { MetricState } from "@/lib/data/platform-overview";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  APPLICATION_DATE_RANGES,
  APPLICATION_QUEUE_STATUSES,
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUS_TONES,
  INSTITUTION_TYPES,
  applicationQueueHref,
  formatApplicationLocation,
  institutionTypeLabel,
  resolveApplicationQueueQuery,
  type ApplicationQueueQuery,
} from "@/lib/institution-applications";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Pagination,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { PlatformMetricCard } from "@/components/platform/metric-card";
import { ApplicationReviewDrawer } from "@/components/platform/application-review-drawer";
import {
  BuildingIcon,
  CheckCircleIcon,
  ClockIcon,
  InboxIcon,
  SearchIcon,
  ShieldAlertIcon,
} from "@/components/platform/icons";

export const metadata: Metadata = {
  title: "Pending Institution Approvals",
};

// Reads the live session and query params — never prerendered.
export const instant = false;

const QUEUE_BASE = "/platform/institutions/pending-approvals";

function formatSubmitted(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

/** Turn one live summary figure into a MetricState for a card. An
 *  unavailable breakdown degrades every card, never a partial set. */
function summaryMetric(
  counts: MetricState<ApplicationSummaryCounts>,
  pick: (value: ApplicationSummaryCounts) => number,
): MetricState<number> {
  return counts.state === "available"
    ? { state: "available", value: pick(counts.value) }
    : { state: "unavailable", reason: counts.reason };
}

/**
 * Pending Institution Approvals — the SUPER_ADMIN review queue for
 * pre-tenant registration applications (migration 0016).
 *
 * AUTHORITATIVE SOURCE. This lists `institution_applications` rows, NOT
 * institutions. An institution with status `active`/`suspended` is an
 * operational tenant and is deliberately absent here — only a real submitted
 * application (pending_review / needs_information / approved / rejected) lives
 * in this queue. Summary figures are live filtered counts, never invented.
 *
 * AUTHORIZATION (AGENTS.md §5). The layout already gates /platform, and this
 * page re-checks with `inspectAccess` as defense in depth: a non-super-admin
 * sees the access-denied state, not the queue. The service-role data layer
 * carries no auth of its own, so THIS check is the enforcement point, and the
 * decision itself is re-authorized inside the server action.
 *
 * REVIEW MODEL. A row's "Review" action navigates to `?review=<id>`; the page
 * then server-renders the detail + real decision history into a side panel.
 * Nothing is fetched client-side, so a tenant's data can never leak into a
 * client cache and no unauthorised id can bypass the server check.
 */
export default async function PendingApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  // Defense-in-depth SUPER_ADMIN check (the layout guard runs first). A denial
  // renders the access-denied state instead of any queue data.
  const access = await inspectAccess({ roles: ["SUPER_ADMIN"] });
  if (!access.allowed) {
    return (
      <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <EmptyState
            icon={<ShieldAlertIcon className="h-5 w-5" />}
            title="Access restricted"
            description="This review queue is for authorised platform super admins only. Your account is not permitted to view or decide institution applications."
            action={
              <Link href="/platform">
                <Button type="button" variant="secondary">
                  Back to dashboard
                </Button>
              </Link>
            }
          />
        </div>
      </main>
    );
  }

  const params = await searchParams;
  const query = resolveApplicationQueueQuery(params);

  // --- Optional review drawer (server-rendered from the requested id) -------
  const rawReview =
    typeof params.review === "string" ? params.review.trim() : "";
  let drawer: React.ReactNode = null;
  if (rawReview) {
    const detail = await safeGetDetail(rawReview);
    if (detail) {
      // Lean, privacy-minimised decision history: the action label, outcome,
      // time, and trusted summary only — no actor id crosses to the client.
      const history = (await safeGetHistory(detail.id)).map((entry) => ({
        id: entry.id,
        action: entry.action,
        outcome: entry.outcome,
        createdAt: entry.createdAt,
        summary: entry.summary,
      }));
      drawer = (
        <ApplicationReviewDrawer
          application={detail}
          decisionHistory={history}
          closeHref={applicationQueueHref(QUEUE_BASE, query, 1)}
        />
      );
    }
  }

  // --- Queue + summary ------------------------------------------------------
  let result: ApplicationList | null = null;
  let dataSourceConfigured = true;
  let loadFailed = false;
  try {
    result = await listInstitutionApplications({
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
      status: query.status,
      type: query.type,
      withinDays: query.withinDays,
    });
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      dataSourceConfigured = false;
    } else if (isMissingTable(error)) {
      dataSourceConfigured = false;
    } else {
      loadFailed = true;
    }
  }

  const summary = await getApplicationSummaryCounts();

  const total = result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const isFiltered =
    query.q.length > 0 ||
    query.status !== null ||
    query.type !== null ||
    query.withinDays !== null;
  const rangeFrom = total === 0 ? 0 : (query.page - 1) * query.pageSize + 1;
  const rangeTo = Math.min(query.page * query.pageSize, total);

  // Reviewing a missing / unauthorised id: show an honest notice rather than an
  // empty drawer that looks like a loading bug.
  const reviewRequested = rawReview.length > 0;
  const reviewNotFound = reviewRequested && drawer === null;

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        {/* Title block */}
        <div>
          <p className="text-2xs font-semibold uppercase tracking-wider text-ink-subtle">
            Institutions
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink lg:text-3xl">
            Pending Institution Approvals
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Review registration applications from prospective schools, tutorial
            centres, and CBT centres. Approving an application creates the
            institution and grants the applicant access as its first
            administrator; a partial grant is shown as needing attention and can
            be safely retried.
          </p>
        </div>

        {!dataSourceConfigured ? (
          <Alert variant="warning" title="Approval queue not available">
            The applications table is not reachable from the server (it may not
            be migrated on this environment yet). No placeholder rows or counts
            are shown.
          </Alert>
        ) : loadFailed ? (
          <Alert variant="danger" title="Applications unavailable">
            The applications could not be read right now. Reload to try again.
          </Alert>
        ) : null}

        {reviewNotFound ? (
          <Alert variant="warning" title="Application not found">
            The application you tried to open no longer exists or was never
            visible to you. Choose one from the list below.
          </Alert>
        ) : null}

        {/* Summary cards — live counts; unavailable ≠ zero. Shown together
            (all-or-nothing) so a partial breakdown never looks complete. */}
        <section aria-label="Application summary">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <PlatformMetricCard
              label="Pending review"
              metric={summaryMetric(
                summary,
                (v) => v.pending,
              )}
              tone="warning"
              icon={<ClockIcon />}
              hint="Awaiting a decision"
              missingHint="Applications not yet available on this environment"
              href={applicationQueueHref(
                QUEUE_BASE,
                { ...query, status: "pending_review" },
                1,
              )}
            />
            <PlatformMetricCard
              label="Submitted this week"
              metric={summaryMetric(summary, (v) => v.submittedThisWeek)}
              tone="purple"
              icon={<InboxIcon />}
              hint="New applications in the last 7 days"
              missingHint="Applications not yet available on this environment"
              href={applicationQueueHref(
                QUEUE_BASE,
                { ...query, withinDays: 7 },
                1,
              )}
            />
            <PlatformMetricCard
              label="Awaiting information"
              metric={summaryMetric(summary, (v) => v.needsInformation)}
              tone="brand"
              icon={<SearchIcon />}
              hint="More detail requested from applicant"
              missingHint="Applications not yet available on this environment"
              href={applicationQueueHref(
                QUEUE_BASE,
                { ...query, status: "needs_information" },
                1,
              )}
            />
            <PlatformMetricCard
              label="Reviewed this month"
              metric={summaryMetric(summary, (v) => v.reviewedThisMonth)}
              tone="success"
              icon={<CheckCircleIcon />}
              hint="Approved or decided this month"
              missingHint="Applications not yet available on this environment"
              href={applicationQueueHref(
                QUEUE_BASE,
                { ...query, status: "approved" },
                1,
              )}
            />
          </div>
        </section>

        {/* Filters (server-side GET form; every value re-sanitised by the
            resolver). A plain form keeps the queue linkable and works without
            client JavaScript. */}
        <Card className="p-4">
          <form
            method="get"
            action={QUEUE_BASE}
            role="search"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_repeat(3,auto)_auto] lg:items-end"
          >
            <Input
              type="search"
              name="q"
              defaultValue={query.q}
              placeholder="Search institution or applicant name"
              aria-label="Search applications"
              label="Search"
            />
            <Select
              name="status"
              label="Status"
              defaultValue={query.status ?? ""}
              aria-label="Filter by application status"
            >
              <option value="">All statuses</option>
              {APPLICATION_QUEUE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {APPLICATION_STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
            <Select
              name="type"
              label="Institution type"
              defaultValue={query.type ?? ""}
              aria-label="Filter by institution type"
            >
              <option value="">All types</option>
              {INSTITUTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {institutionTypeLabel(type)}
                </option>
              ))}
            </Select>
            <Select
              name="range"
              label="Submitted"
              defaultValue={rangeValue(query)}
              aria-label="Filter by submission date"
            >
              {APPLICATION_DATE_RANGES.map((range) => (
                <option key={range.value} value={range.value}>
                  {range.label}
                </option>
              ))}
            </Select>
            <Button type="submit" size="md">
              <SearchIcon className="h-4 w-4" />
              Apply
            </Button>
            {isFiltered ? (
              <Link href={QUEUE_BASE}>
                <Button type="button" variant="ghost" size="md">
                  Clear
                </Button>
              </Link>
            ) : null}
          </form>
        </Card>

        {/* Queue table / states */}
        {result && result.rows.length === 0 ? (
          <EmptyState
            icon={<InboxIcon className="h-5 w-5" />}
            title={isFiltered ? "No matching applications" : "No applications yet"}
            description={
              isFiltered
                ? "No application matches these filters. Try clearing them."
                : "No institution has submitted a registration application. This is a real zero, not missing data."
            }
            action={
              isFiltered ? (
                <Link href={QUEUE_BASE}>
                  <Button type="button" variant="secondary">
                    Clear filters
                  </Button>
                </Link>
              ) : undefined
            }
          />
        ) : result && result.rows.length > 0 ? (
          <Card className="overflow-hidden p-0">
            <Table className="rounded-none border-0 shadow-none">
              <TableHeader>
                <TableRow>
                  <TableHead>Institution</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Applicant</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead numeric>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <span
                          aria-hidden="true"
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"
                        >
                          <BuildingIcon className="h-4.5 w-4.5" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink">
                            {row.institutionName}
                          </p>
                          <p className="font-mono text-2xs text-ink-subtle break-all">
                            {row.id}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-ink-muted">
                      {institutionTypeLabel(row.institutionType)}
                    </TableCell>
                    <TableCell>
                      <p className="text-ink">{row.contactPerson}</p>
                      <p className="truncate text-2xs text-ink-subtle">
                        {row.contactEmail}
                      </p>
                    </TableCell>
                    <TableCell className="text-ink-muted">
                      {formatSubmitted(row.submittedAt)}
                    </TableCell>
                    <TableCell className="text-ink-muted">
                      {formatApplicationLocation({
                        city: row.city,
                        state: row.state,
                        country: row.country,
                      })}
                    </TableCell>
                    <TableCell>
                      <Badge tone={APPLICATION_STATUS_TONES[row.status]} dot>
                        {APPLICATION_STATUS_LABELS[row.status]}
                      </Badge>
                    </TableCell>
                    <TableCell numeric>
                      <Link
                        href={`${QUEUE_BASE}?${queueParamsWith(query, "review", row.id)}`}
                        className="text-sm font-medium text-brand hover:underline"
                      >
                        Review
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
              <p className="text-xs text-ink-muted">
                Showing {rangeFrom.toLocaleString()} to{" "}
                {rangeTo.toLocaleString()} of {total.toLocaleString()}{" "}
                applications
              </p>
              <Pagination
                page={query.page}
                totalPages={totalPages}
                hrefFor={(page) => applicationQueueHref(QUEUE_BASE, query, page)}
                label="Application queue pages"
              />
            </div>
          </Card>
        ) : null}

        <p className="text-xs leading-5 text-ink-subtle">
          Applications are reviewed here before any workspace exists. Approval
          creates the institution and provisions the applicant as its first
          administrator, behind the SUPER_ADMIN-only server action; if the grant
          only partially completes it is recorded as needing attention and
          retried without duplicating the tenant or membership. Every decision
          and grant is confirmed and audit-logged.
        </p>
      </div>

      {drawer}
    </main>
  );
}

/** The current date-range select value ("all" when no bound is applied). */
function rangeValue(query: ApplicationQueueQuery): string {
  const match = APPLICATION_DATE_RANGES.find((r) => r.days === query.withinDays);
  return match?.value ?? "all";
}

/** Build a queue querystring preserving active filters plus one extra param
 *  (used for the "Review" link so opening the drawer keeps the filters). */
function queueParamsWith(
  query: ApplicationQueueQuery,
  key: string,
  value: string,
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status) params.set("status", query.status);
  if (query.type) params.set("type", query.type);
  const range = APPLICATION_DATE_RANGES.find((r) => r.days === query.withinDays);
  if (range && range.value !== "all") params.set("range", range.value);
  if (query.page > 1) params.set("page", String(query.page));
  params.set(key, value);
  return params.toString();
}

/** Missing-table detection so an un-migrated environment reads as "not
 *  configured" rather than a generic failure. */
function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205";
}

/** Detail read for the drawer: any failure yields null (a "not found" notice),
 *  never a crash of the whole queue render. */
async function safeGetDetail(
  id: string,
): Promise<Awaited<ReturnType<typeof getInstitutionApplicationDetail>>> {
  try {
    return await getInstitutionApplicationDetail(id);
  } catch {
    return null;
  }
}

async function safeGetHistory(id: string) {
  try {
    return await listApplicationDecisionActivity(id);
  } catch {
    return [];
  }
}
