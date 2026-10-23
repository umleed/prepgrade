import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { roleLabel, type UserRole } from "@/lib/auth/roles";
import {
  getPlatformInstitutionDetail,
  type InstitutionProfile,
  type MetricState,
  type RoleCount,
} from "@/lib/data/platform-overview";
import {
  listInstitutionAuditActivity,
  type PlatformAuditEntry,
} from "@/lib/data/audit";
import { platformAuditActionLabel } from "@/lib/audit/platform";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  INSTITUTION_DETAIL_TAB_LABELS,
  INSTITUTION_STATUS_HINTS,
  INSTITUTION_STATUS_LABELS,
  INSTITUTION_STATUS_TONES,
  institutionTypeLabel,
  institutionDetailTabHref,
  resolveInstitutionDetailTab,
  type InstitutionDetailTab,
} from "@/lib/institutions";
import { InstitutionStatusControl } from "@/components/platform/institution-status-control";
import { ActivityFeed, SectionHeading } from "@/components/platform/activity-feed";
import { PanelNote } from "@/components/platform/panel-note";
import { PlatformMetricCard } from "@/components/platform/metric-card";
import {
  BuildingIcon,
  CheckCircleIcon,
  DocumentIcon,
  UsersIcon,
} from "@/components/platform/icons";
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  EmptyState,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type BadgeTone,
  type TabDefinition,
} from "@/components/ui";

export const metadata: Metadata = {
  title: "Institution detail",
};

// Reads the live session and the tenant record — never prerendered.
export const instant = false;

const OUTCOME_TONES: Record<string, BadgeTone> = {
  success: "success",
  failed: "warning",
  denied: "danger",
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

function formatTimestamp(iso: string): string {
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

/** A labelled field row in the profile card (label left, value right). */
function DetailField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-1 py-2.5">
      <span className="text-sm text-ink-muted">{label}</span>
      <span className="text-sm font-medium text-ink">{value}</span>
    </div>
  );
}

/** Profile values render "Not set" when absent — never a guess (0015). */
function profileText(value: string | null): string {
  return value && value.trim().length > 0 ? value : "Not set";
}

/** Country / state / city as one line, skipping unset parts. */
function profileLocation(profile: InstitutionProfile): string {
  const parts = [profile.city, profile.state, profile.country].filter(
    (part): part is string => Boolean(part && part.trim().length > 0),
  );
  return parts.length > 0 ? parts.join(", ") : "Not set";
}

/** Project the role-bucketed membership metric into one role's count. */
function roleMetric(
  members: MetricState<RoleCount[]>,
  role: UserRole,
): MetricState<number> {
  if (members.state === "unavailable") {
    return { state: "unavailable", reason: members.reason };
  }
  return {
    state: "available",
    value: members.value.find((row) => row.role === role)?.count ?? 0,
  };
}

/** Membership head-count bucketed by role; personal rows are never shown. */
function MembershipList({ members }: { members: RoleCount[] }) {
  const SUPER_ADMIN_LABEL = "Super admin";
  // SUPER_ADMIN is platform-scoped and never holds a membership row; show it
  // only if a count somehow exists, to avoid a misleading permanent zero.
  const rows = members.filter(
    (row) => row.count > 0 || roleLabel(row.role) !== SUPER_ADMIN_LABEL,
  );
  const total = members.reduce((sum, row) => sum + row.count, 0);

  if (total === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No members yet — a real zero, not missing data.
      </p>
    );
  }

  return (
    <dl className="flex flex-col divide-y divide-border">
      {rows.map((row) => (
        <div
          key={row.role}
          className="flex items-baseline justify-between gap-3 py-2"
        >
          <dt className="text-sm text-ink-muted">{roleLabel(row.role)}</dt>
          <dd className="text-sm font-semibold text-ink tabular-nums">
            {row.count.toLocaleString()}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Recent platform-audit activity attributed to this tenant. */
function ActivityList({ entries }: { entries: PlatformAuditEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No recorded platform actions for this institution yet. An empty log
        means nothing has been done here — not that logging is broken.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Actor</TableHead>
          <TableHead>Outcome</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell className="whitespace-nowrap text-ink-muted">
              {formatTimestamp(entry.createdAt)}
            </TableCell>
            <TableCell>
              <p className="font-medium text-ink">
                {platformAuditActionLabel(entry.action)}
              </p>
              {entry.summary ? (
                <p className="text-xs text-ink-muted">{entry.summary}</p>
              ) : null}
            </TableCell>
            <TableCell>
              <span className="font-mono text-xs break-all">{entry.actorId}</span>
            </TableCell>
            <TableCell>
              <Badge tone={OUTCOME_TONES[entry.outcome] ?? "neutral"} dot>
                {entry.outcome}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Institution detail — a consolidated, tabbed view of one tenant for an
 * authorised SUPER_ADMIN (prompt 32, extended into a detail dashboard).
 *
 * Every query is scoped server-side to the selected institution id, and the
 * SUPER_ADMIN gate runs before any cross-tenant read. Only implemented
 * capabilities appear as tabs (overview, users, settings, activity); there is
 * no assessments/results/subscription tab because those systems do not exist
 * yet — assessments are instead surfaced as an honest "unavailable" metric.
 * Personal data stays minimal: role-bucketed head-counts, never a learner
 * roster. The only write is an approved status change (confirmed + audited in
 * the server action). A bad id is a genuine not-found, not a silent empty page.
 */
export default async function PlatformInstitutionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  // Guard first, outside the try/catch, so a denial redirects cleanly and the
  // service-role reads below only ever run for a verified super admin.
  await requireSuperAdmin({ next: "/platform/institutions" });

  const { id } = await params;
  const activeTab = resolveInstitutionDetailTab(await searchParams);

  let detail: Awaited<ReturnType<typeof getPlatformInstitutionDetail>> = null;
  let activity: PlatformAuditEntry[] | null = null;
  let dataSourceConfigured = true;
  let loadFailed = false;

  try {
    // Both reads are scoped to the same trusted id and run after the guard.
    const [detailResult, activityResult] = await Promise.all([
      getPlatformInstitutionDetail(id),
      listInstitutionAuditActivity(id),
    ]);
    detail = detailResult;
    activity = activityResult;
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      dataSourceConfigured = false;
    } else {
      loadFailed = true;
    }
  }

  // A resolved-but-missing record is a true 404; only a successful read that
  // returned no row qualifies. A data-source failure must NOT 404.
  if (dataSourceConfigured && !loadFailed && detail === null) {
    notFound();
  }

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <Breadcrumbs
          items={[
            { label: "Platform", href: "/platform" },
            { label: "Institutions", href: "/platform/institutions" },
            { label: detail?.name ?? "Institution" },
          ]}
        />

        {!dataSourceConfigured ? (
          <Alert variant="warning" title="Data source not configured">
            Supabase is not reachable from the server, so this institution
            cannot be read. No placeholder data is shown.
          </Alert>
        ) : loadFailed ? (
          <Alert variant="danger" title="Institution unavailable">
            This institution could not be read right now. Reload to try again.
          </Alert>
        ) : null}

        {detail ? (
          <>
            {/* Identity card — logo tile, name, status, and the approved
                lifecycle actions (confirmed + audit-logged server-side). */}
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-4 p-5">
                <div className="flex min-w-0 items-center gap-4">
                  <span
                    aria-hidden="true"
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-600"
                  >
                    <BuildingIcon className="h-7 w-7" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <h1 className="text-xl font-bold tracking-tight text-ink lg:text-2xl">
                        {detail.name}
                      </h1>
                      <Badge tone={INSTITUTION_STATUS_TONES[detail.status]} dot>
                        {INSTITUTION_STATUS_LABELS[detail.status]}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-sm text-ink-muted">
                      {institutionTypeLabel(detail.type)} • Registered{" "}
                      {formatDate(detail.createdAt)}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Link href="/platform/institutions">
                    <Button type="button" variant="secondary" size="md">
                      All institutions
                    </Button>
                  </Link>
                  <InstitutionStatusControl
                    institutionId={detail.id}
                    currentStatus={detail.status}
                  />
                </div>
              </div>
            </Card>

            <InstitutionTabs detail={detail} activity={activity} initialTab={activeTab} />
          </>
        ) : dataSourceConfigured && !loadFailed ? (
          <EmptyState
            title="Institution not found"
            description={
              <Link
                href="/platform/institutions"
                className="font-medium text-brand hover:underline"
              >
                Back to the institution directory
              </Link>
            }
          />
        ) : null}
      </div>
    </main>
  );
}

function InstitutionTabs({
  detail,
  activity,
  initialTab,
}: {
  detail: NonNullable<Awaited<ReturnType<typeof getPlatformInstitutionDetail>>>;
  activity: PlatformAuditEntry[] | null;
  initialTab: InstitutionDetailTab;
}) {
  const tabs: TabDefinition[] = [
    {
      value: "overview",
      label: INSTITUTION_DETAIL_TAB_LABELS.overview,
      content: (
        <div className="flex flex-col gap-5">
          {/* Tenant metrics — icon-tile cards; unavailable renders "—". */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <PlatformMetricCard
              label="Students"
              metric={roleMetric(detail.members, "STUDENT")}
              tone="brand"
              icon={<UsersIcon />}
              hint="Student memberships"
              missingHint="Not yet available — memberships table missing"
            />
            <PlatformMetricCard
              label="Teachers"
              metric={roleMetric(detail.members, "TEACHER")}
              tone="purple"
              icon={<UsersIcon />}
              hint="Teacher memberships"
              missingHint="Not yet available — memberships table missing"
            />
            <PlatformMetricCard
              label="Active Questions"
              metric={detail.questions}
              tone="success"
              icon={<DocumentIcon />}
              hint="Live items in this bank"
              missingHint="Not yet available — questions table missing"
            />
            <PlatformMetricCard
              label="Completed Attempts"
              metric={detail.assessments}
              tone="warning"
              icon={<CheckCircleIcon />}
              missingHint="Not yet available — the exam builder ships in a later phase"
            />
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <div className="flex h-full flex-col gap-3 p-5">
                <SectionHeading
                  title="Institution Information"
                  description="Core tenant profile — read-only; fields are set by the institution during setup."
                />
                <div className="flex flex-col divide-y divide-border">
                  <DetailField label="Institution Name" value={detail.name} />
                  <DetailField label="Type" value={institutionTypeLabel(detail.type)} />
                  <DetailField
                    label="Status"
                    value={
                      <Badge tone={INSTITUTION_STATUS_TONES[detail.status]} dot>
                        {INSTITUTION_STATUS_LABELS[detail.status]}
                      </Badge>
                    }
                  />
                  <DetailField
                    label="Registration Date"
                    value={formatDate(detail.createdAt)}
                  />
                  <DetailField
                    label="Classes"
                    value={
                      detail.classes.state === "available"
                        ? detail.classes.value.toLocaleString()
                        : detail.classes.reason === "missing_table"
                          ? "Not yet available"
                          : "Unavailable"
                    }
                  />
                  <DetailField
                    label="Institution ID"
                    value={<span className="font-mono text-xs break-all">{detail.id}</span>}
                  />
                  {/* Location & contact block — collected by the platform
                      registration form (0015). Legacy tenants have none and
                      honestly show "Not set" per field. */}
                  <DetailField
                    label="Short Name"
                    value={profileText(detail.profile.shortName)}
                  />
                  <DetailField
                    label="Location"
                    value={profileLocation(detail.profile)}
                  />
                  <DetailField
                    label="Address"
                    value={profileText(detail.profile.address)}
                  />
                  <DetailField
                    label="Contact Person"
                    value={profileText(detail.profile.contactPerson)}
                  />
                  <DetailField
                    label="Contact Email"
                    value={profileText(detail.profile.contactEmail)}
                  />
                  <DetailField
                    label="Contact Phone"
                    value={profileText(detail.profile.contactPhone)}
                  />
                </div>
                <p className="text-xs leading-5 text-ink-subtle">
                  {INSTITUTION_STATUS_HINTS[detail.status]}
                </p>
              </div>
            </Card>

            <Card>
              <div className="flex h-full flex-col gap-3 p-5">
                <SectionHeading title="Subscription Details" />
                <PanelNote>
                  Plans, billing, and renewal data are a future phase — this
                  institution has no plan records, so nothing is shown here
                  rather than invented figures.
                </PanelNote>
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <div className="flex h-full flex-col gap-3 p-5">
                <SectionHeading
                  title="Usage Overview"
                  description="Assessments created and completed attempts over time."
                />
                <PanelNote>
                  Time-series usage is not recorded yet — exams and attempts
                  arrive with the assessment workflow (prompts 17–25), so this
                  chart has no real data to plot.
                </PanelNote>
              </div>
            </Card>

            <Card>
              <div className="flex h-full flex-col gap-3 p-5">
                <SectionHeading
                  title="Recent Activity"
                  description="Latest platform actions for this institution."
                  viewAllHref={institutionDetailTabHref(
                    `/platform/institutions/${detail.id}`,
                    "activity",
                  )}
                />
                {activity ? (
                  <ActivityFeed
                    entries={activity.slice(0, 5)}
                    emptyMessage="No recorded platform actions for this institution yet."
                  />
                ) : (
                  <p className="text-sm text-ink-muted">
                    Temporarily unavailable — the audit activity could not be
                    read.
                  </p>
                )}
              </div>
            </Card>
          </div>

          <p className="text-xs leading-5 text-ink-subtle">
            Metrics are lifetime totals for this tenant — there is no
            time-series source yet, so no period-over-period change is shown.
            Billing, subscription, and impersonation are out of scope: those
            systems are not implemented, and no figures are invented for them.
          </p>
        </div>
      ),
    },
    {
      value: "users",
      label: INSTITUTION_DETAIL_TAB_LABELS.users,
      content: (
        <Card>
          <div className="flex flex-col gap-3 p-5">
            <div>
              <h2 className="text-base font-semibold text-ink">Members by role</h2>
              <p className="mt-0.5 text-xs text-ink-subtle">
                Head-count only. Names, emails, and learner-level records are
                deliberately not exposed to platform administration.
              </p>
            </div>
            {detail.members.state === "available" ? (
              <MembershipList members={detail.members.value} />
            ) : (
              <p className="text-sm text-ink-muted">
                {detail.members.reason === "missing_table"
                  ? "Not yet available — the memberships table is missing."
                  : "Temporarily unavailable — memberships could not be read."}
              </p>
            )}
          </div>
        </Card>
      ),
    },
    {
      value: "settings",
      label: INSTITUTION_DETAIL_TAB_LABELS.settings,
      content: (
        <div className="flex flex-col gap-5">
          <Card>
            <div className="flex flex-col gap-3 p-5">
              <div>
                <h2 className="text-base font-semibold text-ink">Institution profile</h2>
                <p className="mt-0.5 text-xs text-ink-subtle">
                  Core profile fields are read-only here; they are set by the
                  institution during setup.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
                <DetailField label="Name" value={detail.name} />
                <DetailField label="Type" value={institutionTypeLabel(detail.type)} />
              </div>
            </div>
          </Card>

          <Card>
            <div className="flex flex-col gap-3 p-5">
              <div>
                <h2 className="text-base font-semibold text-ink">
                  Operational status
                </h2>
                <p className="mt-0.5 text-xs text-ink-subtle">
                  Only approved transitions are offered. Every change is
                  confirmed and recorded in the platform audit log.
                </p>
              </div>
              <InstitutionStatusControl
                institutionId={detail.id}
                currentStatus={detail.status}
              />
            </div>
          </Card>
        </div>
      ),
    },
    {
      value: "activity",
      label: INSTITUTION_DETAIL_TAB_LABELS.activity,
      content:
        activity === null ? (
          <Alert variant="danger" title="Activity unavailable">
            The audit activity could not be read right now. Reload to try again.
          </Alert>
        ) : (
          <Card>
            <div className="flex flex-col gap-3 p-5">
              <div>
                <h2 className="text-base font-semibold text-ink">
                  Recent activity
                </h2>
                <p className="mt-0.5 text-xs text-ink-subtle">
                  Platform-audit actions recorded against this institution,
                  newest first.
                </p>
              </div>
              <ActivityList entries={activity} />
            </div>
          </Card>
        ),
    },
  ];

  return (
    <Tabs
      tabs={tabs}
      defaultValue={initialTab}
      // Re-key when the URL tab changes so a fresh server render (e.g. a
      // shared ?tab=activity link) selects the requested section.
      key={`${detail.id}:${initialTab}`}
    />
  );
}
