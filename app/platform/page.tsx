import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { getAuthContext } from "@/lib/auth/context";
import { roleLabel, type UserRole } from "@/lib/auth/roles";
import {
  getPlatformOverview,
  listPlatformInstitutions,
  type PlatformInstitutionList,
  type PlatformOverview,
  type RoleCount,
} from "@/lib/data/platform-overview";
import {
  listPlatformAuditEntries,
  type PlatformAuditEntry,
} from "@/lib/data/audit";
import {
  getSystemHealth,
  type SystemHealth,
} from "@/lib/data/platform-health";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import { institutionTypeLabel } from "@/lib/institutions";
import {
  Alert,
  Badge,
  Card,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import {
  ActivityFeed,
  SectionHeading,
} from "@/components/platform/activity-feed";
import { DonutChart, type DonutSegment } from "@/components/platform/donut-chart";
import { PanelNote } from "@/components/platform/panel-note";
import { PlatformMetricCard } from "@/components/platform/metric-card";
import {
  BuildingIcon,
  CalendarIcon,
  CheckCircleIcon,
  DocumentIcon,
  UsersIcon,
} from "@/components/platform/icons";

export const metadata: Metadata = {
  title: "Platform overview",
};

// Reads the live session and live counts — never prerendered.
export const instant = false;

/** Segment colors for the role donut, wired to design-token CSS variables. */
const ROLE_COLORS: Partial<Record<UserRole, string>> = {
  STUDENT: "var(--color-brand-600)",
  TEACHER: "var(--color-success)",
  INSTITUTION_ADMIN: "var(--color-accent-purple)",
};

/**
 * Platform operations overview — prompt 31, restyled to the approved
 * super-admin dashboard design.
 *
 * SUPER_ADMIN only, enforced server-side twice (layout + this page). Every
 * figure comes from a live count against tables that exist today
 * (institutions, profiles, institution_memberships, questions); the chart
 * panels whose data sources do not exist yet (time-series usage, revenue,
 * subscription plans) render explicit "not yet available" notes instead of
 * invented numbers, the Recent Activity feed shows real platform-audit events
 * only, and the System Health panel summarises the prompt-33 probes.
 */
export default async function PlatformDashboardPage() {
  await connection();

  // Defense in depth alongside the layout guard (same pattern as
  // /institution): this page's cross-tenant queries must only ever run for
  // a verified super admin.
  const principal = await requireSuperAdmin({ next: "/platform" });
  const context = await getAuthContext();

  const overview: PlatformOverview = await getPlatformOverview();
  const dataSourceDown =
    overview.institutions.state === "unavailable" &&
    overview.institutions.reason === "error";

  const greeting = context.displayName || context.email || "Super Admin";

  // Top-institutions card and the activity feed degrade independently: a
  // failed read shows an honest note, never sample rows.
  let topInstitutions: PlatformInstitutionList | null = null;
  let topInstitutionsFailed = false;
  try {
    topInstitutions = await listPlatformInstitutions({ page: 1, pageSize: 5 });
  } catch (error) {
    if (!(error instanceof DataSourceUnavailableError)) topInstitutionsFailed = true;
  }

  let recentActivity: PlatformAuditEntry[] | null = null;
  try {
    const audit = await listPlatformAuditEntries({ page: 1, pageSize: 5 });
    recentActivity = audit.rows;
  } catch {
    recentActivity = null;
  }

  // System-health summary (prompt 33): the same probes the dedicated screen
  // runs, degraded independently so a failed check never blanks the dashboard.
  let health: SystemHealth | null = null;
  try {
    health = await getSystemHealth();
  } catch {
    health = null;
  }

  const asOf = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        {/* Page title block */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink lg:text-3xl">
              Welcome back, {greeting}
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              Here&apos;s what&apos;s happening on PrepGrade today. Figures are
              live counts from the platform database.
            </p>
          </div>
          <span className="flex items-center gap-2 rounded-field border border-border bg-surface px-3 py-2 text-sm font-medium text-ink-muted">
            <CalendarIcon className="h-4 w-4 text-ink-subtle" />
            As of {asOf}
          </span>
        </div>

        {dataSourceDown ? (
          <Alert variant="warning" title="Data source unavailable">
            Supabase could not be reached, so no counts are shown — a
            connection failure never renders as a zero. Check the server
            environment configuration and reload.
          </Alert>
        ) : null}

        {/* Summary metrics — real data only; unavailable ≠ zero. */}
        <section aria-label="Platform metrics">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <PlatformMetricCard
              label="Total Institutions"
              metric={overview.institutions}
              tone="purple"
              icon={<BuildingIcon />}
              hint="Institutions created on the platform"
              missingHint="Not yet available — institutions table missing"
              href="/platform/institutions"
            />
            <PlatformMetricCard
              label="Total Users"
              metric={overview.accounts}
              tone="brand"
              icon={<UsersIcon />}
              hint={
                overview.activeAccounts.state === "available"
                  ? `${overview.activeAccounts.value.toLocaleString()} active accounts`
                  : "Provisioned platform accounts (profiles)"
              }
              missingHint="Not yet available — profiles table missing"
            />
            <PlatformMetricCard
              label="Active Questions"
              metric={overview.questions}
              tone="success"
              icon={<DocumentIcon />}
              hint="Live items across all institution banks"
              missingHint="Not yet available — questions table missing"
            />
            <PlatformMetricCard
              label="Total Assessments"
              metric={overview.assessments}
              tone="warning"
              icon={<CheckCircleIcon />}
              missingHint="Not yet available — the exam builder ships in a later phase"
            />
          </div>
        </section>

        {/* Usage + user distribution */}
        <section aria-label="Usage and user distribution" className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="flex h-full flex-col gap-4 p-5">
              <SectionHeading
                title="Platform Usage Overview"
                description="Assessments taken, active users and new registrations over time."
              />
              <PanelNote>
                Time-series usage is not recorded yet — the platform has no
                exam attempts or daily-activity data (prompts 17–25). This
                panel will chart real activity once those systems ship; no
                sample curve is invented in the meantime.
              </PanelNote>
            </div>
          </Card>

          <Card>
            <div className="flex h-full flex-col gap-4 p-5">
              <SectionHeading
                title="User Distribution"
                description="Breakdown of all registered users."
              />
              {overview.roleDistribution.state === "available" ? (
                <RoleDonut distribution={overview.roleDistribution.value} />
              ) : (
                <p className="text-sm text-ink-muted">
                  {overview.roleDistribution.reason === "missing_table"
                    ? "Not yet available — the memberships table has not been created."
                    : "Temporarily unavailable — the memberships could not be read."}
                </p>
              )}
              <p className="text-2xs leading-4 text-ink-subtle">
                Institution memberships by role. SUPER_ADMIN is platform-scoped
                and holds no membership rows.
              </p>
            </div>
          </Card>
        </section>

        {/* Top institutions + recent activity */}
        <section aria-label="Institutions and activity" className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="flex h-full flex-col gap-4 p-5">
              <SectionHeading
                title="Top Institutions"
                description="Most recently created institutions with live membership counts."
                viewAllHref="/platform/institutions"
              />
              {topInstitutions && topInstitutions.rows.length > 0 ? (
                <div className="flex-1">
                  <Table className="rounded-none border-0 shadow-none">
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>Institution</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead numeric>Members</TableHead>
                        <TableHead numeric>Students</TableHead>
                        <TableHead numeric>Teachers</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {topInstitutions.rows.map((row, index) => (
                        <TableRow key={row.id}>
                          <TableCell className="text-ink-muted tabular-nums">
                            {index + 1}
                          </TableCell>
                          <TableCell>
                            <Link
                              href={`/platform/institutions/${row.id}`}
                              className="font-medium text-brand hover:underline"
                            >
                              {row.name}
                            </Link>
                          </TableCell>
                          <TableCell className="text-ink-muted">
                            {institutionTypeLabel(row.type)}
                          </TableCell>
                          <TableCell>
                            <Badge
                              tone={
                                row.status === "active"
                                  ? "success"
                                  : row.status === "suspended"
                                    ? "warning"
                                    : "neutral"
                              }
                              dot
                            >
                              {row.status === "active"
                                ? "Active"
                                : row.status === "suspended"
                                  ? "Suspended"
                                  : "Archived"}
                            </Badge>
                          </TableCell>
                          {row.members ? (
                            <>
                              <TableCell numeric>{row.members.total.toLocaleString()}</TableCell>
                              <TableCell numeric>{row.members.students.toLocaleString()}</TableCell>
                              <TableCell numeric>{row.members.teachers.toLocaleString()}</TableCell>
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
                </div>
              ) : topInstitutions ? (
                <p className="text-sm text-ink-muted">
                  No institution has registered on this environment yet — a
                  real zero, not missing data.
                </p>
              ) : (
                <p className="text-sm text-ink-muted">
                  {topInstitutionsFailed
                    ? "Temporarily unavailable — the institutions could not be read."
                    : "Not configured — Supabase is not reachable from the server."}
                </p>
              )}
            </div>
          </Card>

          <Card>
            <div className="flex h-full flex-col gap-4 p-5">
              <SectionHeading
                title="Recent Activity"
                description="Latest platform events."
                viewAllHref="/platform/audit"
              />
              {recentActivity ? (
                <ActivityFeed entries={recentActivity} />
              ) : (
                <p className="text-sm text-ink-muted">
                  Temporarily unavailable — the audit log could not be read.
                </p>
              )}
            </div>
          </Card>
        </section>

        {/* Planned operational panels — kept from the design, filled with
            honest "not yet available" notes (no billing/health data exists). */}
        <section aria-label="Planned operational panels" className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card>
            <div className="flex h-full flex-col gap-4 p-5">
              <SectionHeading
                title="Revenue Overview"
                description="Subscription revenue and growth."
              />
              <PanelNote>
                Billing and revenue are not implemented on the platform yet
                (future phase) — there is no money data to chart, so nothing
                is shown.
              </PanelNote>
            </div>
          </Card>

          <Card>
            <div className="flex h-full flex-col gap-4 p-5">
              <SectionHeading
                title="Subscription Plans"
                description="Distribution of active subscriptions."
              />
              <PanelNote>
                Subscription plans are a future phase — institutions have no
                plan records yet, so this distribution stays empty rather
                than invented.
              </PanelNote>
            </div>
          </Card>

          <Card>
            <div className="flex h-full flex-col gap-4 p-5">
              <SectionHeading
                title="System Health"
                description="Platform services status."
                viewAllHref="/platform/health"
                viewAllLabel="All checks"
              />
              {health ? (
                <ul className="flex flex-col gap-2 text-sm">
                  <HealthRow
                    label="Server data connection"
                    ok={health.dataSource.state === "available"}
                    okNote="Reachable"
                    failNote="Unreachable — checks could not run"
                  />
                  <HealthRow
                    label="Audit log (append-only)"
                    ok={health.auditLog.state === "available"}
                    okNote={
                      health.latestAuditEvent.state === "live"
                        ? "Readable and recording events"
                        : health.latestAuditEvent.state === "empty"
                          ? "Readable — no events recorded yet"
                          : "Readable"
                    }
                    failNote={
                      health.auditLog.state === "unavailable" &&
                      health.auditLog.reason === "missing_table"
                        ? "Table not migrated in this environment"
                        : "Could not be read"
                    }
                  />
                  <HealthRow
                    label="Denied actions (24h)"
                    ok={
                      health.deniedLast24h.state === "available" &&
                      health.deniedLast24h.value === 0
                    }
                    okNote="None recorded"
                    failNote={
                      health.deniedLast24h.state === "available"
                        ? `${health.deniedLast24h.value.toLocaleString()} recorded — review the audit log`
                        : "Window unknown — the audit table could not be read"
                    }
                  />
                </ul>
              ) : (
                <PanelNote>
                  The health probes could not run in this request. The dedicated
                  checks remain available on the System Health screen.
                </PanelNote>
              )}
            </div>
          </Card>
        </section>

        {/* Trust note — truthful about the current trust source (prompt 31
            documentation requirement). */}
        <p className="text-xs leading-5 text-ink-subtle">
          Signed in as <span className="font-mono break-all">{principal.userId}</span>{" "}
          with the platform-scoped role resolved server-side from trusted
          data. SUPER_ADMIN is assigned only through the auth provider&apos;s
          secret-key metadata channel — never through signup or browser-writable
          fields — and this area grants no tenant workspace access.
        </p>
      </div>
    </main>
  );
}

/** Donut + legend from real membership role buckets. */
function RoleDonut({ distribution }: { distribution: RoleCount[] }) {
  const total = distribution.reduce((sum, row) => sum + row.count, 0);

  if (total === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No memberships exist yet — the count is a real zero, not missing data.
      </p>
    );
  }

  const segments: DonutSegment[] = distribution
    .filter((row) => row.count > 0)
    .map((row) => ({
      label: roleLabel(row.role),
      value: row.count,
      color: ROLE_COLORS[row.role] ?? "var(--color-warning)",
    }));

  return (
    <div className="flex flex-1 flex-col items-center gap-5 sm:flex-row lg:flex-col xl:flex-row">
      <DonutChart
        segments={segments}
        centerValue={total.toLocaleString()}
        centerLabel="Total members"
      />
      <ul className="flex w-full flex-col gap-2.5">
        {segments.map((segment) => (
          <li key={segment.label} className="flex items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: segment.color }}
            />
            <span className="min-w-0 flex-1 truncate text-ink">{segment.label}</span>
            <span className="tabular-nums text-ink-muted">
              {segment.value.toLocaleString()}
            </span>
            <span className="w-10 text-right tabular-nums text-ink-subtle">
              {Math.round((segment.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One measured health line for the dashboard summary (prompt 33). `ok` is
 *  the honest check result — a failing/unavailable check never renders as a
 *  green row, and the note says what is actually true. */
function HealthRow({
  label,
  ok,
  okNote,
  failNote,
}: {
  label: string;
  ok: boolean;
  okNote: string;
  failNote: string;
}) {
  return (
    <li className="flex items-start justify-between gap-3">
      <span className="text-ink">{label}</span>
      <Badge tone={ok ? "success" : "warning"} dot>
        {ok ? okNote : failNote}
      </Badge>
    </li>
  );
}
