import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import {
  getQuestionBankTotals,
  listPlatformQuestions,
  type PlatformQuestionListResult,
} from "@/lib/data/platform-question-bank";
import { listPlatformAuditEntries } from "@/lib/data/audit";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  QUESTION_STATUS_LABELS,
  questionDirectoryHref,
  resolveQuestionDirectoryQuery,
  type PlatformQuestionRow,
  type QuestionStatus,
} from "@/lib/platform-question-bank";
import {
  MODERATION_STATUS_TABS,
  MODERATION_TAB_LABELS,
  presentAuditEvent,
  type ModerationStatusTab,
} from "@/lib/platform-moderation";
import {
  Alert,
  Badge,
  Breadcrumbs,
  Card,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type BadgeTone,
} from "@/components/ui";
import { PlatformMetricCard } from "@/components/platform/metric-card";
import { SectionHeading } from "@/components/platform/activity-feed";
import {
  ArchiveIcon,
  CheckCircleIcon,
  ShieldIcon,
} from "@/components/platform/icons";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Moderation" };

// Reads the live session and query params — never prerendered.
export const instant = false;

const BASE_PATH = "/platform/moderation";
const AUDIT_PREVIEW_LIMIT = 5;

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

const TAB_TO_STATUS: Record<ModerationStatusTab, QuestionStatus | null> = {
  all: null,
  active: "active",
  archived: "archived",
};

/**
 * Moderation — a READ-ONLY oversight view for the Super Admin area.
 *
 * It shows exactly two things the schema genuinely supports:
 *   1. cross-tenant question VISIBILITY in its real stored states (active /
 *      archived), metadata only — the same privacy posture as the Question
 *      Bank screen: question text, options, correct answers, and explanations
 *      are never read here (the reader selects content METADATA only);
 *   2. recent platform AUDIT events, through the established audit reader.
 *
 * There is NO moderation workflow on this platform: no review queue, no
 * approve/reject/hold states, no submitted reports, and no moderation history
 * table. This screen therefore offers no approve/reject/archive/delete/edit
 * controls and makes no claim to run one. The audit events shown are immutable
 * governance/security records, presented as what they are — NOT as reports.
 *
 * Authorization: SUPER_ADMIN only, enforced in the platform layout and again
 * here before any cross-tenant query runs. Question reads stay tenant-scoped
 * through the shared reader's institution filter; the audit table is
 * platform-wide by design.
 */
export default async function PlatformModerationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  await requireSuperAdmin({ next: BASE_PATH });

  const params = await searchParams;
  // Reuse the shared, fail-closed question resolver: the status tab is just
  // the question `status` filter, and any narrowing is validated the same way.
  const query = resolveQuestionDirectoryQuery(params);
  const tab: ModerationStatusTab = query.status ?? "all";

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

  const totals = await getQuestionBankTotals(query.institutionId).catch(() => null);

  let auditEvents: ReturnType<typeof presentAuditEvent>[] = [];
  let auditLoadFailed = false;
  try {
    const audit = await listPlatformAuditEntries({
      page: 1,
      pageSize: AUDIT_PREVIEW_LIMIT,
    });
    auditEvents = audit.rows.map(presentAuditEvent);
  } catch {
    // Auxiliary panel: a failure here must not blank the question visibility.
    auditLoadFailed = true;
  }

  const total = result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const rangeFrom = total === 0 ? 0 : (query.page - 1) * query.pageSize + 1;
  const rangeTo = Math.min(query.page * query.pageSize, total);

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <Breadcrumbs
          items={[{ label: "Platform", href: "/platform" }, { label: "Moderation" }]}
        />

        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-1 flex h-9 w-9 items-center justify-center rounded-field bg-brand-50 text-brand-600"
          >
            <ShieldIcon />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink lg:text-3xl">
              Moderation
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              Read-only visibility into question states and recent platform
              activity. This area has no review queue or approval workflow —
              content editing happens inside the owning institution, and the
              events below are audit records, not reports.
            </p>
          </div>
        </div>

        {!dataSourceConfigured ? (
          <Alert variant="warning" title="Data source not configured">
            Supabase is not reachable from the server, so neither question
            visibility nor audit events can be read. No placeholder rows are
            shown.
          </Alert>
        ) : loadFailed ? (
          <Alert variant="danger" title="Content unavailable">
            The question visibility could not be read right now. Reload to try
            again.
          </Alert>
        ) : null}

        {/* Status visibility tiles — the real stored lifecycle, nothing more. */}
        <section aria-label="Question visibility summary">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <PlatformMetricCard
              label="Active Questions"
              metric={totals?.active ?? { state: "unavailable", reason: "error" }}
              tone="success"
              icon={<CheckCircleIcon />}
              hint="Live bank rows across tenants"
            />
            <PlatformMetricCard
              label="Archived Questions"
              metric={totals?.archived ?? { state: "unavailable", reason: "error" }}
              tone="neutral"
              icon={<ArchiveIcon />}
              hint="Retired, kept for history"
            />
            <PlatformMetricCard
              label="Listed Here"
              metric={{ state: "available", value: total }}
              tone="brand"
              icon={<ShieldIcon />}
              hint="Questions on the current tab & filters"
            />
          </div>
        </section>

        {/* Status tabs + tenant narrowing, reusing the shared reader/href. */}
        <div
          role="group"
          aria-label="Filter question visibility by status"
          className="flex flex-wrap items-center gap-1 border-b border-border"
        >
          {MODERATION_STATUS_TABS.map((tabKey) => {
            const activeTab = tab === tabKey;
            return (
              <Link
                key={tabKey}
                href={questionDirectoryHref(BASE_PATH, query, {
                  status: TAB_TO_STATUS[tabKey],
                  page: 1,
                })}
                className={cn(
                  "-mb-px rounded-t-field border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                  activeTab
                    ? "border-brand text-brand-700"
                    : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink",
                )}
                aria-current={activeTab ? "page" : undefined}
              >
                {MODERATION_TAB_LABELS[tabKey]}
              </Link>
            );
          })}
          {query.institutionId ? (
            <span className="ml-2 text-xs text-ink-muted">
              narrowed to one institution
            </span>
          ) : null}
        </div>

        {result && result.rows.length === 0 ? (
          <EmptyState
            title={
              query.status
                ? `No ${query.status} questions`
                : "No questions yet"
            }
            description={
              query.institutionId
                ? "No question matches this institution and status. Try a different tenant or tab."
                : "No institution has authored a question in this state yet. This is a real zero, not missing data."
            }
            icon={<ShieldIcon className="h-5 w-5" />}
          />
        ) : result && result.rows.length > 0 ? (
          <Card className="overflow-hidden p-0">
            <Table className="rounded-none border-0 shadow-none">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Institution</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Provenance</TableHead>
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

            {total > query.pageSize ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
                <p className="text-xs text-ink-muted">
                  Showing {rangeFrom.toLocaleString()} to {rangeTo.toLocaleString()}{" "}
                  of {total.toLocaleString()} questions
                </p>
                <div className="flex gap-3 text-sm font-medium">
                  {query.page > 1 ? (
                    <Link
                      href={questionDirectoryHref(BASE_PATH, query, {
                        page: query.page - 1,
                      })}
                      className="text-brand-600 hover:underline"
                    >
                      Previous
                    </Link>
                  ) : null}
                  {query.page < totalPages ? (
                    <Link
                      href={questionDirectoryHref(BASE_PATH, query, {
                        page: query.page + 1,
                      })}
                      className="text-brand-600 hover:underline"
                    >
                      Next
                    </Link>
                  ) : null}
                </div>
              </div>
            ) : null}
          </Card>
        ) : null}

        <p className="text-xs leading-5 text-ink-subtle">
          Metadata only — question text, options, correct answers, and
          explanations are never read in this view. Archiving or editing the
          bank happens inside the owning institution, not here.
        </p>

        {/* Recent platform audit events — presented as the immutable log they
            are, never as moderation reports. */}
        <Card>
          <div className="flex flex-col gap-3 p-5">
            <SectionHeading
              title="Recent platform audit events"
              description="The newest records in the append-only platform audit log — governance and security actions taken by trusted server code. These are audit events, not submitted reports or a review queue."
              viewAllHref="/platform/audit"
              viewAllLabel="Open audit log"
            />
            {auditLoadFailed ? (
              <Alert variant="warning" title="Audit events unavailable">
                The audit log could not be read for this request. No substitute
                entries are shown.
              </Alert>
            ) : auditEvents.length === 0 ? (
              <p className="text-sm text-ink-subtle">
                No platform audit events have been recorded yet. An empty log is
                a real state, not a failure.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditEvents.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="whitespace-nowrap text-ink-muted">
                        {formatDate(event.createdAt)}
                      </TableCell>
                      <TableCell>
                        <p className="font-medium text-ink">{event.actionLabel}</p>
                        <p className="font-mono text-2xs text-ink-subtle">
                          {event.actionRaw}
                        </p>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-ink-muted">
                          {event.target ?? <span className="text-ink-subtle">—</span>}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge tone={toBadgeTone(event.outcomeTone)} dot>
                          {event.outcome}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </Card>
      </div>
    </main>
  );
}

/** The pure moderation layer emits a narrow tone union; widen to the UI Badge
 *  tone at the render boundary only. */
function toBadgeTone(tone: "success" | "warning" | "danger" | "neutral"): BadgeTone {
  return tone;
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
        <Badge tone={row.status === "active" ? "success" : "neutral"} dot>
          {row.status ? QUESTION_STATUS_LABELS[row.status] : "Unknown"}
        </Badge>
      </TableCell>
      <TableCell className="text-ink-muted">
        {row.provenance === "licensed"
          ? "Licensed"
          : row.provenance === "teacher_created"
            ? "Teacher-created"
            : "—"}
      </TableCell>
      <TableCell className="text-ink-muted">
        {row.sourceLabel ?? <span className="text-ink-subtle">—</span>}
        {row.sourceYear !== null ? ` · ${row.sourceYear}` : ""}
      </TableCell>
      <TableCell className="text-ink-muted">{formatDate(row.createdAt)}</TableCell>
    </TableRow>
  );
}
