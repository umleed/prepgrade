import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import {
  getAssessmentStatusCounts,
  listPlatformAssessments,
  type PlatformAssessmentListResult,
} from "@/lib/data/platform-assessments";
import { listInstitutionOptions } from "@/lib/data/platform-usage";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  EXAM_STATUSES,
  assessmentDirectoryHref,
  resolveAssessmentDirectoryQuery,
  type ExamStatus,
  type PlatformAssessmentRow,
} from "@/lib/platform-assessments";
import {
  EXAM_STATUS_LABELS,
  examDisplayState,
} from "@/lib/exams";
import {
  Alert,
  Badge,
  Breadcrumbs,
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
import { DocumentIcon, SearchIcon } from "@/components/platform/icons";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Assessments",
};

// Reads the live session and query params — never prerendered.
export const instant = false;

const BASE_PATH = "/platform/assessments";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Assessments — the Super Admin cross-tenant exam directory (read-only).
 *
 * Every row is a live exam; every count (questions, attempts) is a real
 * head count whose failure renders "—" rather than a fabricated 0. Exam
 * lifecycle actions (publish/close/archive) intentionally do NOT live here:
 * they belong to the owning institution, and an unscoped platform write would
 * break the tenant boundary rules of AGENTS.md §5. The detail page mirrors
 * that — operational metadata and aggregates only, no question content and
 * no answer keys (AGENTS.md §6).
 *
 * Authorization: SUPER_ADMIN only, enforced server-side in the platform
 * layout and again here before any cross-tenant query runs.
 */
export default async function PlatformAssessmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  // Guard first, outside the try/catch, so a denial redirects cleanly.
  await requireSuperAdmin({ next: BASE_PATH });

  const params = await searchParams;
  const query = resolveAssessmentDirectoryQuery(params);

  let result: PlatformAssessmentListResult | null = null;
  let dataSourceConfigured = true;
  let loadFailed = false;

  try {
    result = await listPlatformAssessments(query);
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      dataSourceConfigured = false;
    } else {
      loadFailed = true;
    }
  }

  // Live per-status counts for the tabs; null degrades badges, not rows.
  const statusCounts = await getAssessmentStatusCounts(query.institutionId).catch(
    () => null,
  );

  // Institution filter options (id/name only — the same helper the
  // Analytics surface uses; no duplicate option query is introduced).
  let institutionOptions: Awaited<ReturnType<typeof listInstitutionOptions>> = {
    options: [],
    total: 0,
    truncated: false,
  };
  try {
    institutionOptions = await listInstitutionOptions();
  } catch {
    // Auxiliary control: a failure leaves the "All institutions" option only.
  }

  const total = result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const isFiltered =
    query.q.length > 0 || query.status !== null || query.institutionId !== null;
  const rangeFrom = total === 0 ? 0 : (query.page - 1) * query.pageSize + 1;
  const rangeTo = Math.min(query.page * query.pageSize, total);
  const now = new Date();

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <Breadcrumbs
          items={[
            { label: "Platform", href: "/platform" },
            { label: "Assessments" },
          ]}
        />

        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink lg:text-3xl">
            Assessments
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Every exam created by institutions on PrepGrade. This is a
            read-only operational view — creation, publishing, and lifecycle
            changes happen inside the owning institution.
          </p>
        </div>

        {!dataSourceConfigured ? (
          <Alert variant="warning" title="Data source not configured">
            Supabase is not reachable from the server, so the directory
            cannot be read. No placeholder rows are shown.
          </Alert>
        ) : loadFailed ? (
          <Alert variant="danger" title="Assessments unavailable">
            The exams could not be read right now. Reload to try again.
          </Alert>
        ) : null}

        {/* Status tabs + search + filters (GET form, linkable, server-clamped). */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="group"
            aria-label="Filter by exam status"
            className="flex min-w-0 flex-wrap items-center gap-1 border-b border-border"
          >
            <Link
              href={assessmentDirectoryHref(BASE_PATH, query, {
                status: null,
                page: 1,
              })}
              className={cn(
                "-mb-px rounded-t-field border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                query.status === null
                  ? "border-brand text-brand-700"
                  : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink",
              )}
              aria-current={query.status === null ? "page" : undefined}
            >
              All Assessments
              <span className="ml-1 text-ink-subtle tabular-nums">
                ({total.toLocaleString()})
              </span>
            </Link>
            {EXAM_STATUSES.map((status) => {
              const active = query.status === status;
              const count = statusCounts?.[status];
              return (
                <Link
                  key={status}
                  href={assessmentDirectoryHref(BASE_PATH, query, {
                    status: status as ExamStatus,
                    page: 1,
                  })}
                  className={cn(
                    "-mb-px rounded-t-field border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                    active
                      ? "border-brand text-brand-700"
                      : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  {EXAM_STATUS_LABELS[status]}
                  {count !== undefined ? (
                    <span className="ml-1 text-ink-subtle tabular-nums">
                      ({count.toLocaleString()})
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>

          <form method="get" action={BASE_PATH} role="search" className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="status" value={query.status ?? ""} />
            <Select
              aria-label="Filter by institution"
              name="institution"
              defaultValue={query.institutionId ?? ""}
            >
              <option value="">All institutions</option>
              {institutionOptions.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
            <div className="w-56 sm:w-64">
              <Input
                type="search"
                name="q"
                defaultValue={query.q}
                placeholder="Search exam titles..."
                aria-label="Search by exam title"
              />
            </div>
            <Button type="submit" variant="secondary" size="md" aria-label="Search">
              <SearchIcon className="h-4 w-4" />
            </Button>
            {isFiltered ? (
              <Link href={BASE_PATH}>
                <Button type="button" variant="ghost" size="md">
                  Clear filters
                </Button>
              </Link>
            ) : null}
          </form>
        </div>

        {result && result.rows.length === 0 ? (
          <EmptyState
            title={isFiltered ? "No matching assessments" : "No assessments yet"}
            description={
              isFiltered
                ? "No exam matches this search or filter. Try clearing the filters."
                : "No institution has created an exam yet. This is a real zero, not missing data."
            }
            icon={<DocumentIcon className="h-5 w-5" />}
          />
        ) : result && result.rows.length > 0 ? (
          <Card className="overflow-hidden p-0">
            <Table className="rounded-none border-0 shadow-none">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Exam</TableHead>
                  <TableHead>Institution</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead numeric>Questions</TableHead>
                  <TableHead numeric>Attempts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row, index) => (
                  <AssessmentRow key={row.id} row={row} index={index} query={query} now={now} />
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
              <p className="text-xs text-ink-muted">
                Showing {rangeFrom.toLocaleString()} to {rangeTo.toLocaleString()}{" "}
                of {total.toLocaleString()} assessments
              </p>
              <Pagination
                page={query.page}
                totalPages={totalPages}
                hrefFor={(page) => assessmentDirectoryHref(BASE_PATH, query, { page })}
                label="Assessment directory pages"
              />
            </div>
          </Card>
        ) : null}

        <p className="text-xs leading-5 text-ink-subtle">
          Counts come from live aggregate queries; a failed count shows
          &ldquo;—&rdquo; and is never printed as zero. Question content and
          answer keys are tenant-owned and are not exposed in this area.
        </p>
      </div>
    </main>
  );
}

function AssessmentRow({
  row,
  index,
  query,
  now,
}: {
  row: PlatformAssessmentRow;
  index: number;
  query: ReturnType<typeof resolveAssessmentDirectoryQuery>;
  now: Date;
}) {
  // Derived display state (Active/Completed) uses the SAME pure rule the
  // tenant surfaces use — published + window vs the server clock.
  const chip = row.status
    ? examDisplayState(row.status, row.startsAt, row.endsAt, now)
    : null;

  return (
    <TableRow>
      <TableCell className="text-ink-muted tabular-nums">
        {(query.page - 1) * query.pageSize + index + 1}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"
          >
            <DocumentIcon className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <Link
              href={`/platform/assessments/${row.id}`}
              className="font-medium text-brand hover:underline"
            >
              {row.title}
            </Link>
            <p className="text-2xs text-ink-subtle">
              {row.durationMinutes !== null
                ? `${row.durationMinutes} min`
                : "Duration not recorded"}
            </p>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <Link
          href={`/platform/institutions/${row.institutionId}`}
          className="text-ink hover:text-brand hover:underline"
        >
          {row.institutionName ?? "View institution"}
        </Link>
      </TableCell>
      <TableCell className="text-ink-muted">
        {row.subjectName ?? <span className="text-ink-subtle">—</span>}
      </TableCell>
      <TableCell>
        {chip ? (
          <Badge tone={chip.tone} dot>
            {chip.label}
          </Badge>
        ) : (
          <Badge tone="neutral">Unknown status</Badge>
        )}
      </TableCell>
      <TableCell className="text-ink-muted">{formatDate(row.createdAt)}</TableCell>
      <TableCell numeric>
        {row.questionCount === null ? "—" : row.questionCount.toLocaleString()}
      </TableCell>
      <TableCell numeric>
        {row.attemptCount === null ? "—" : row.attemptCount.toLocaleString()}
      </TableCell>
    </TableRow>
  );
}
