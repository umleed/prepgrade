import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import {
  getInstitutionStatusCounts,
  listPlatformInstitutions,
  type InstitutionStatusCounts,
  type MetricState,
  type PlatformInstitutionList,
} from "@/lib/data/platform-overview";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  INSTITUTION_STATUSES,
  INSTITUTION_STATUS_LABELS,
  INSTITUTION_STATUS_TONES,
  institutionDirectoryHref,
  institutionTypeLabel,
  resolveInstitutionDirectoryQuery,
  type InstitutionStatus,
} from "@/lib/institutions";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Pagination,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { PlatformMetricCard } from "@/components/platform/metric-card";
import {
  ArchiveIcon,
  BuildingIcon,
  CheckCircleIcon,
  ClockIcon,
  PlusIcon,
  SearchIcon,
} from "@/components/platform/icons";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Institutions",
};

// Reads the live session and query params — never prerendered.
export const instant = false;

function formatCreated(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Turn the real status counts into MetricStates for the summary cards. */
function statusMetric(
  counts: MetricState<InstitutionStatusCounts>,
  pick: (value: InstitutionStatusCounts) => number,
): MetricState<number> {
  return counts.state === "available"
    ? { state: "available", value: pick(counts.value) }
    : { state: "unavailable", reason: counts.reason };
}

/**
 * Institution directory — every tenant on the platform, searchable and
 * filterable by operational status (prompt 32, restyled to the approved
 * "Institutions Management" design).
 *
 * Read + status-change surface for SUPER_ADMIN only, enforced server-side
 * before any query runs. Names, status, type, and membership counts leave the
 * tenant tables — no learner-level personal data. The lifecycle actions live
 * on the detail page; this list is a navigable overview, so there is no
 * inline mutation to trust a client-supplied tenant or status with.
 */
export default async function PlatformInstitutionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  // Guard first, outside the try/catch, so a denial redirects cleanly.
  await requireSuperAdmin({ next: "/platform/institutions" });

  const params = await searchParams;
  const query = resolveInstitutionDirectoryQuery(params);

  let result: PlatformInstitutionList | null = null;
  let dataSourceConfigured = true;
  let loadFailed = false;

  try {
    result = await listPlatformInstitutions({
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
      status: query.status,
    });
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      dataSourceConfigured = false;
    } else {
      loadFailed = true;
    }
  }

  // Live per-status counts for the summary cards and tab badges; degrades to
  // an unavailable state (cards show "—", tabs drop their counts).
  const statusCounts = await getInstitutionStatusCounts();

  const total = result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const isFiltered = query.q.length > 0 || query.status !== null;
  const rangeFrom = total === 0 ? 0 : (query.page - 1) * query.pageSize + 1;
  const rangeTo = Math.min(query.page * query.pageSize, total);

  const countOf = (status: InstitutionStatus) =>
    statusCounts.state === "available"
      ? (statusCounts.value.byStatus[status] ?? 0).toLocaleString()
      : null;

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        {/* Page title block */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink lg:text-3xl">
              Institutions Management
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              Manage all schools, centers and institutions on PrepGrade. View
              their details, operational status and activity.
            </p>
          </div>
          {/* Institution creation happens through onboarding; the button is a
              labelled placeholder, not a dead link. */}
          <Button
            type="button"
            disabled
            title="Not yet available — institutions are created through onboarding and admin approval, which ships in a later phase"
            className="cursor-not-allowed"
          >
            <PlusIcon className="h-4 w-4" />
            Add Institution
          </Button>
        </div>

        {!dataSourceConfigured ? (
          <Alert variant="warning" title="Data source not configured">
            Supabase is not reachable from the server, so the directory
            cannot be read. No placeholder rows are shown.
          </Alert>
        ) : loadFailed ? (
          <Alert variant="danger" title="Institutions unavailable">
            The institutions could not be read right now. Reload to try
            again.
          </Alert>
        ) : null}

        {/* Status summary cards — live counts; unavailable ≠ zero. */}
        <section aria-label="Institution status summary">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <PlatformMetricCard
              label="Total Institutions"
              metric={statusMetric(statusCounts, (v) => v.total)}
              tone="purple"
              icon={<BuildingIcon />}
              hint="All tenants on the platform"
              href="/platform/institutions"
            />
            <PlatformMetricCard
              label="Active Institutions"
              metric={statusMetric(statusCounts, (v) => v.byStatus.active ?? 0)}
              tone="success"
              icon={<CheckCircleIcon />}
              hint={
                statusCounts.state === "available" && statusCounts.value.total > 0
                  ? `${Math.round(((statusCounts.value.byStatus.active ?? 0) / statusCounts.value.total) * 100)}% of total`
                  : "Operating normally"
              }
              href={institutionDirectoryHref("/platform/institutions", { ...query, status: "active" }, 1)}
            />
            <PlatformMetricCard
              label="Suspended"
              metric={statusMetric(statusCounts, (v) => v.byStatus.suspended ?? 0)}
              tone="warning"
              icon={<ClockIcon />}
              hint={
                statusCounts.state === "available" && statusCounts.value.total > 0
                  ? `${Math.round(((statusCounts.value.byStatus.suspended ?? 0) / statusCounts.value.total) * 100)}% of total`
                  : "Paused for support follow-up"
              }
              href={institutionDirectoryHref("/platform/institutions", { ...query, status: "suspended" }, 1)}
            />
            <PlatformMetricCard
              label="Archived"
              metric={statusMetric(statusCounts, (v) => v.byStatus.archived ?? 0)}
              tone="neutral"
              icon={<ArchiveIcon />}
              hint={
                statusCounts.state === "available" && statusCounts.value.total > 0
                  ? `${Math.round(((statusCounts.value.byStatus.archived ?? 0) / statusCounts.value.total) * 100)}% of total`
                  : "Retired, kept for history"
              }
              href={institutionDirectoryHref("/platform/institutions", { ...query, status: "archived" }, 1)}
            />
          </div>
        </section>

        {/* Tabs + search */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="group"
            aria-label="Filter by status"
            className="flex min-w-0 flex-wrap items-center gap-1 border-b border-border"
          >
            <Link
              href={institutionDirectoryHref(
                "/platform/institutions",
                { ...query, status: null },
                1,
              )}
              className={cn(
                "-mb-px rounded-t-field border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                query.status === null
                  ? "border-brand text-brand-700"
                  : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink",
              )}
              aria-current={query.status === null ? "page" : undefined}
            >
              All Institutions
              <span className="ml-1 text-ink-subtle tabular-nums">
                (
                  {statusCounts.state === "available"
                    ? statusCounts.value.total.toLocaleString()
                    : total.toLocaleString()}
                )
              </span>
            </Link>
            {INSTITUTION_STATUSES.map((status) => {
              const active = query.status === status;
              const badge = countOf(status);
              return (
                <Link
                  key={status}
                  href={institutionDirectoryHref(
                    "/platform/institutions",
                    { ...query, status },
                    1,
                  )}
                  className={cn(
                    "-mb-px rounded-t-field border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                    active
                      ? "border-brand text-brand-700"
                      : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  {INSTITUTION_STATUS_LABELS[status]}
                  {badge !== null ? (
                    <span className="ml-1 text-ink-subtle tabular-nums">
                      ({badge})
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>

          {/* Search + reset. A plain GET form keeps the directory linkable
              and works without client JavaScript; the resolver clamps every
              value server-side. */}
          <form
            method="get"
            action="/platform/institutions"
            role="search"
            className="flex items-center gap-2"
          >
            <input type="hidden" name="status" value={query.status ?? ""} />
            <div className="w-56 sm:w-64">
              <Input
                type="search"
                name="q"
                defaultValue={query.q}
                placeholder="Search institutions..."
                aria-label="Search by institution name"
              />
            </div>
            <Button type="submit" variant="secondary" size="md" aria-label="Search">
              <SearchIcon className="h-4 w-4" />
            </Button>
            {isFiltered ? (
              <Link href="/platform/institutions">
                <Button type="button" variant="ghost" size="md">
                  Clear filters
                </Button>
              </Link>
            ) : null}
          </form>
        </div>

        {result && result.rows.length === 0 ? (
          <EmptyState
            title={isFiltered ? "No matching institutions" : "No institutions yet"}
            description={
              isFiltered
                ? "No institution matches this search or status filter. Try clearing the filters."
                : "No institution has completed setup on this environment. This is a real zero, not missing data."
            }
          />
        ) : result && result.rows.length > 0 ? (
          <Card className="overflow-hidden p-0">
            <Table className="rounded-none border-0 shadow-none">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Institution Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Registered</TableHead>
                  <TableHead numeric>Members</TableHead>
                  <TableHead numeric>Teachers</TableHead>
                  <TableHead numeric>Students</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row, index) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-ink-muted tabular-nums">
                      {(query.page - 1) * query.pageSize + index + 1}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <span
                          aria-hidden="true"
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"
                        >
                          <BuildingIcon className="h-4.5 w-4.5" />
                        </span>
                        <div className="min-w-0">
                          <Link
                            href={`/platform/institutions/${row.id}`}
                            className="font-medium text-brand hover:underline"
                          >
                            {row.name}
                          </Link>
                          <p className="font-mono text-2xs text-ink-subtle break-all">
                            {row.id}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-ink-muted">
                      {institutionTypeLabel(row.type)}
                    </TableCell>
                    <TableCell>
                      <Badge tone={INSTITUTION_STATUS_TONES[row.status]} dot>
                        {INSTITUTION_STATUS_LABELS[row.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-ink-muted">
                      {formatCreated(row.createdAt)}
                    </TableCell>
                    {row.members ? (
                      <>
                        <TableCell numeric>{row.members.total.toLocaleString()}</TableCell>
                        <TableCell numeric>{row.members.teachers.toLocaleString()}</TableCell>
                        <TableCell numeric>{row.members.students.toLocaleString()}</TableCell>
                      </>
                    ) : (
                      <TableCell colSpan={3} className="text-ink-subtle">
                        <span aria-label="Member counts unavailable">—</span>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Table footer — real range + pagination links. */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
              <p className="text-xs text-ink-muted">
                Showing {rangeFrom.toLocaleString()} to{" "}
                {rangeTo.toLocaleString()} of {total.toLocaleString()}{" "}
                institutions
              </p>
              <Pagination
                page={query.page}
                totalPages={totalPages}
                hrefFor={(page) =>
                  institutionDirectoryHref("/platform/institutions", query, page)
                }
                label="Institution directory pages"
              />
            </div>
          </Card>
        ) : null}

        <p className="text-xs leading-5 text-ink-subtle">
          Open an institution to inspect its membership and activity and to
          make an approved operational-status change (every change is
          confirmed and audit-logged). Billing, subscription, and impersonation
          are not part of this view.
        </p>
      </div>
    </main>
  );
}
