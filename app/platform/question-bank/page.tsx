import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import {
  getQuestionBankTotals,
  getQuestionDifficultyBreakdown,
  listPlatformQuestions,
  type PlatformQuestionListResult,
} from "@/lib/data/platform-question-bank";
import { listInstitutionOptions } from "@/lib/data/platform-usage";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  QUESTION_DIFFICULTIES,
  QUESTION_PROVENANCES,
  QUESTION_STATUS_LABELS,
  QUESTION_PROVENANCE_LABELS,
  questionDirectoryHref,
  questionQueryHasFilters,
  resolveQuestionDirectoryQuery,
  type PlatformQuestionRow,
} from "@/lib/platform-question-bank";
import { buildDifficultySummary } from "@/lib/platform-question-bank";
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
import { PlatformMetricCard } from "@/components/platform/metric-card";
import {
  ArchiveIcon,
  CheckCircleIcon,
  GridIcon,
  HistoryIcon,
  SearchIcon,
} from "@/components/platform/icons";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Question Bank",
};

// Reads the live session and query params — never prerendered.
export const instant = false;

const BASE_PATH = "/platform/question-bank";

const DIFFICULTY_TONES: Record<string, "success" | "warning" | "info"> = {
  easy: "success",
  medium: "warning",
  hard: "info",
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Question Bank — the Super Admin cross-tenant view of authored questions
 * (read-only content METADATA).
 *
 * The answer key and item content are the most sensitive data on the
 * platform and belong to the owning institution (AGENTS.md §6), so this
 * surface lists subject/difficulty/provenance/status/marks/source and never
 * the question text, options, correct answer, or explanation. Authoring,
 * archiving, and content review all happen inside the institution, not here —
 * there are deliberately no write controls.
 *
 * Authorization: SUPER_ADMIN only, enforced in the platform layout and again
 * here before any cross-tenant query runs.
 */
export default async function PlatformQuestionBankPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  await requireSuperAdmin({ next: BASE_PATH });

  const params = await searchParams;
  const query = resolveQuestionDirectoryQuery(params);

  let result: PlatformQuestionListResult | null = null;
  let dataSourceConfigured = true;
  let loadFailed = false;
  try {
    result = await listPlatformQuestions(query);
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      dataSourceConfigured = false;
    } else {
      loadFailed = true;
    }
  }

  const difficultyState = await getQuestionDifficultyBreakdown(query).catch(
    () => ({ state: "unavailable", reason: "error" }) as const,
  );
  const difficultySummary = buildDifficultySummary(
    difficultyState.state === "available" ? difficultyState.value : null,
  );

  const totals = await getQuestionBankTotals(query.institutionId).catch(() => null);

  let institutionOptions: Awaited<ReturnType<typeof listInstitutionOptions>> = {
    options: [],
    total: 0,
    truncated: false,
  };
  try {
    institutionOptions = await listInstitutionOptions();
  } catch {
    // Auxiliary control only.
  }

  const total = result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const isFiltered = questionQueryHasFilters(query);
  const rangeFrom = total === 0 ? 0 : (query.page - 1) * query.pageSize + 1;
  const rangeTo = Math.min(query.page * query.pageSize, total);

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <Breadcrumbs
          items={[
            { label: "Platform", href: "/platform" },
            { label: "Question Bank" },
          ]}
        />

        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink lg:text-3xl">
            Question Bank
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Content metadata for every question institutions have authored —
            subject, difficulty, provenance, and status. Question text and
            answer keys are tenant-owned and are not shown in this area.
          </p>
        </div>

        {!dataSourceConfigured ? (
          <Alert variant="warning" title="Data source not configured">
            Supabase is not reachable from the server, so the bank cannot be
            read. No placeholder rows are shown.
          </Alert>
        ) : loadFailed ? (
          <Alert variant="danger" title="Questions unavailable">
            The question bank could not be read right now. Reload to try
            again.
          </Alert>
        ) : null}

        {/* Summary tiles — live counts; unavailable ≠ zero. */}
        <section aria-label="Question bank summary">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <PlatformMetricCard
              label="Active Questions"
              metric={totals?.active ?? { state: "unavailable", reason: "error" }}
              tone="success"
              icon={<CheckCircleIcon />}
              hint="Live bank rows"
            />
            <PlatformMetricCard
              label="Archived Questions"
              metric={totals?.archived ?? { state: "unavailable", reason: "error" }}
              tone="neutral"
              icon={<ArchiveIcon />}
              hint="Retired, kept for history"
            />
            <PlatformMetricCard
              label="Edit Snapshots"
              metric={totals?.versions ?? { state: "unavailable", reason: "error" }}
              tone="purple"
              icon={<HistoryIcon />}
              hint="Append-only version history"
            />
            <PlatformMetricCard
              label="Listed Here"
              metric={
                difficultySummary
                  ? { state: "available", value: difficultySummary.total }
                  : { state: "unavailable", reason: "error" }
              }
              tone="brand"
              icon={<GridIcon />}
              hint="Active questions matching filters"
            />
          </div>
        </section>

        {/* Difficulty breakdown + filters. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="group"
            aria-label="Filter by difficulty"
            className="flex min-w-0 flex-wrap items-center gap-1 border-b border-border"
          >
            <Link
              href={questionDirectoryHref(BASE_PATH, query, {
                difficulty: null,
                page: 1,
              })}
              className={cn(
                "-mb-px rounded-t-field border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                query.difficulty === null
                  ? "border-brand text-brand-700"
                  : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink",
              )}
              aria-current={query.difficulty === null ? "page" : undefined}
            >
              All difficulties
              {difficultySummary ? (
                <span className="ml-1 text-ink-subtle tabular-nums">
                  ({difficultySummary.total.toLocaleString()})
                </span>
              ) : null}
            </Link>
            {QUESTION_DIFFICULTIES.map((difficulty) => {
              const active = query.difficulty === difficulty;
              const count = difficultySummary?.byDifficulty[difficulty];
              return (
                <Link
                  key={difficulty}
                  href={questionDirectoryHref(BASE_PATH, query, {
                    difficulty,
                    page: 1,
                  })}
                  className={cn(
                    "-mb-px rounded-t-field border-b-2 px-3 py-2.5 text-sm font-medium capitalize transition-colors",
                    active
                      ? "border-brand text-brand-700"
                      : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  {difficulty}
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
            <input type="hidden" name="difficulty" value={query.difficulty ?? ""} />
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
            <Select
              aria-label="Filter by status"
              name="status"
              defaultValue={query.status ?? ""}
            >
              <option value="">All statuses</option>
              {Object.entries(QUESTION_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter by provenance"
              name="provenance"
              defaultValue={query.provenance ?? ""}
            >
              <option value="">All provenance</option>
              {QUESTION_PROVENANCES.map((value) => (
                <option key={value} value={value}>
                  {QUESTION_PROVENANCE_LABELS[value]}
                </option>
              ))}
            </Select>
            <div className="w-52 sm:w-60">
              <Input
                type="search"
                name="q"
                defaultValue={query.q}
                placeholder="Search source label..."
                aria-label="Search by source label"
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
            title={isFiltered ? "No matching questions" : "No questions yet"}
            description={
              isFiltered
                ? "No question matches these filters. Try clearing them."
                : "No institution has authored a question yet. This is a real zero, not missing data."
            }
            icon={<GridIcon className="h-5 w-5" />}
          />
        ) : result && result.rows.length > 0 ? (
          <Card className="overflow-hidden p-0">
            <Table className="rounded-none border-0 shadow-none">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Institution</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Difficulty</TableHead>
                  <TableHead>Provenance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead numeric>Marks</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row, index) => (
                  <QuestionRow
                    key={row.id}
                    row={row}
                    index={(query.page - 1) * query.pageSize + index}
                  />
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
              <p className="text-xs text-ink-muted">
                Showing {rangeFrom.toLocaleString()} to {rangeTo.toLocaleString()}{" "}
                of {total.toLocaleString()} questions
              </p>
              <Pagination
                page={query.page}
                totalPages={totalPages}
                hrefFor={(page) => questionDirectoryHref(BASE_PATH, query, { page })}
                label="Question bank pages"
              />
            </div>
          </Card>
        ) : null}

        <p className="text-xs leading-5 text-ink-subtle">
          Metadata only — question text, options, correct answers, and
          explanations are never read in this view. Editing the bank happens
          inside the owning institution.
        </p>
      </div>
    </main>
  );
}

function QuestionRow({ row, index }: { row: PlatformQuestionRow; index: number }) {
  return (
    <TableRow>
      <TableCell className="text-ink-muted tabular-nums">{index + 1}</TableCell>
      <TableCell>
        <Link
          href={`/platform/institutions/${row.institutionId}`}
          className="font-medium text-brand hover:underline"
        >
          {row.institutionName ?? "View institution"}
        </Link>
      </TableCell>
      <TableCell className="text-ink-muted">
        {row.subjectName ?? <span className="text-ink-subtle">Not set</span>}
      </TableCell>
      <TableCell>
        {row.difficulty ? (
          <Badge tone={DIFFICULTY_TONES[row.difficulty] ?? "neutral"}>
            {row.difficulty}
          </Badge>
        ) : (
          <Badge tone="neutral">Unknown</Badge>
        )}
      </TableCell>
      <TableCell className="text-ink-muted">
        {row.provenance ? QUESTION_PROVENANCE_LABELS[row.provenance] : "—"}
      </TableCell>
      <TableCell>
        <Badge tone={row.status === "active" ? "success" : "neutral"} dot>
          {row.status ? QUESTION_STATUS_LABELS[row.status] : "Unknown"}
        </Badge>
      </TableCell>
      <TableCell numeric>
        {row.marks !== null ? row.marks.toLocaleString() : "—"}
      </TableCell>
      <TableCell className="text-ink-muted">
        {row.sourceLabel ?? <span className="text-ink-subtle">—</span>}
        {row.sourceYear !== null ? ` · ${row.sourceYear}` : ""}
      </TableCell>
      <TableCell className="text-ink-muted">{formatDate(row.createdAt)}</TableCell>
    </TableRow>
  );
}
