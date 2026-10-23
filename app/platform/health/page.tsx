import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import {
  getSystemHealth,
  type AuditLogLiveness,
  type ConfigSignal,
} from "@/lib/data/platform-health";
import type { MetricState } from "@/lib/data/platform-overview";
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
import { SectionHeading } from "@/components/platform/activity-feed";
import {
  ArchiveIcon,
  ClockIcon,
  HeartPulseIcon,
  ShieldAlertIcon,
} from "@/components/platform/icons";

export const metadata: Metadata = {
  title: "System health",
};

// Runs live server probes on every request — never prerendered.
export const instant = false;

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
        timeZone: "UTC",
      }) + " UTC";
}

/**
 * System health — restricted operational view (prompt 33). SUPER_ADMIN only,
 * enforced server-side before any probe runs.
 *
 * Every signal here is a REAL measurement: the service-role connection, the
 * append-only audit table, and the server's own environment configuration.
 * There is deliberately no uptime figure, no latency chart, and no
 * "all systems operational" banner — a signal this deployment cannot measure
 * is shown as unavailable, never as a green tick or a zero (the same honest
 * metric rule as the platform dashboard).
 */
export default async function PlatformHealthPage() {
  await connection();

  // Guard BEFORE any probe: a denial's redirect() must propagate untouched.
  await requireSuperAdmin({ next: "/platform/health" });

  const health = await getSystemHealth();

  const degraded =
    health.dataSource.state === "unavailable" ||
    health.auditLog.state === "unavailable";

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink lg:text-3xl">
              System Health
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              Live operational checks this deployment can actually measure.
              A check that cannot run is shown as unavailable — never as a
              healthy value.
            </p>
          </div>
          <Badge tone={degraded ? "warning" : "success"} dot>
            {degraded ? "Checks degraded" : "Checks passing"}
          </Badge>
        </div>

        {health.dataSource.state === "unavailable" ? (
          <Alert variant="warning" title="Data source unreachable">
            The server could not build its Supabase connection, so the
            database-backed checks below could not run. This is a
            configuration/connectivity problem, not a zero reading.
          </Alert>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Health checks">
          <CheckCard
            title="Server data connection"
            description="Supabase service-role client reachable from the server."
            metric={health.dataSource.state === "available"
              ? { state: "available", value: 1 }
              : { state: "unavailable", reason: health.dataSource.reason }}
            goodLabel="Reachable"
            badLabel="Unreachable"
            icon={<HeartPulseIcon />}
            unavailableNote="The check could not run."
          />
          <CheckCard
            title="Audit log table"
            description="The append-only platform_audit_log is readable (migration 0007 applied)."
            metric={health.auditLog.state === "available"
              ? { state: "available", value: 1 }
              : { state: "unavailable", reason: health.auditLog.reason }}
            goodLabel="Readable"
            badLabel="Not readable"
            icon={<ArchiveIcon />}
            unavailableNote={
              health.auditLog.state === "unavailable" &&
              health.auditLog.reason === "missing_table"
                ? "The audit table has not been migrated in this environment yet."
                : "The audit table could not be read."
            }
          />
          <LivenessCard liveness={health.latestAuditEvent} />
          <CheckCard
            title="Denied actions (24h)"
            description="Security-relevant denials recorded in the last 24 hours."
            metric={health.deniedLast24h}
            goodLabel="None recorded"
            badLabel="Denials recorded"
            invert
            icon={<ShieldAlertIcon />}
            unavailableNote="The audit log could not be read, so this window is unknown."
            href="/platform/audit?outcome=denied"
          />
        </section>

        <Card>
          <div className="flex flex-col gap-4 p-5">
            <SectionHeading
              title="Recent activity (24h)"
              description="Successful platform actions recorded in the last 24 hours — proof the audit pipeline is being used, not just readable."
              viewAllHref="/platform/audit"
              viewAllLabel="Open audit log"
            />
            <MetricLine
              metric={health.actionsLast24h}
              render={(value) => (
                <p className="text-2xl font-bold tracking-tight text-ink tabular-nums">
                  {value.toLocaleString()} successful actions
                </p>
              )}
              unavailableNote="Unavailable while the audit table cannot be read."
            />
          </div>
        </Card>

        <Card>
          <div className="flex flex-col gap-3 p-5">
            <SectionHeading
              title="Server configuration"
              description="Presence of server-side environment variables — names and status only, values are never read or displayed."
            />
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Capability</TableHead>
                  <TableHead>Variable</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {health.configuration.map((signal) => (
                  <ConfigurationRow key={signal.variable} signal={signal} />
                ))}
              </TableBody>
            </Table>
            <p className="text-xs leading-5 text-ink-subtle">
              Monitoring integrations (external uptime/alerting) reuse the
              current stack and are added only when configured — this screen
              shows what the app can verify itself.{" "}
              <Link href="/platform/audit" className="font-medium text-brand-600 hover:underline">
                View the full audit log
              </Link>
              .
            </p>
          </div>
        </Card>
      </div>
    </main>
  );
}

/** One binary health check rendered on the honest MetricState contract:
 *  0 is a real zero, unavailable is its own visible state. */
function CheckCard({
  title,
  description,
  metric,
  goodLabel,
  badLabel,
  icon,
  unavailableNote,
  invert = false,
  href,
}: {
  title: string;
  description: string;
  /** Binary checks map to 1 = passing / 0 = failing; counts pass through. */
  metric: MetricState<number>;
  goodLabel: string;
  badLabel: string;
  icon: React.ReactNode;
  unavailableNote: string;
  /** When true, a non-zero value is the failing state (e.g. denials). */
  invert?: boolean;
  href?: string;
}) {
  let tone: "success" | "warning" | "danger" = "success";
  let label = unavailableNote;
  if (metric.state === "available") {
    const failing = invert ? metric.value > 0 : metric.value === 0;
    tone = failing ? (invert ? "danger" : "warning") : "success";
    label = invert
      ? `${metric.value.toLocaleString()} — ${failing ? badLabel : goodLabel}`
      : metric.value > 0
        ? goodLabel
        : badLabel;
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-field bg-brand-50 text-brand-600">
          {icon}
        </div>
        <Badge tone={tone} dot>
          {metric.state === "available" ? label : "Unavailable"}
        </Badge>
      </div>
      <div>
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-ink-muted">{description}</p>
        {metric.state === "unavailable" ? (
          <p className="mt-1 text-xs font-medium text-ink-subtle">{unavailableNote}</p>
        ) : null}
        {href && metric.state === "available" ? (
          <Link
            href={href}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
          >
            Inspect in audit log
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

/** Log liveness — three honest branches, never conflating "empty" with "broken". */
function LivenessCard({ liveness }: { liveness: AuditLogLiveness }) {
  const tone = liveness.state === "live" ? "success" : liveness.state === "empty" ? "info" : "warning";
  const label =
    liveness.state === "live"
      ? "Live"
      : liveness.state === "empty"
        ? "No events yet"
        : "Unavailable";
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-field bg-brand-50 text-brand-600">
          <ClockIcon />
        </div>
        <Badge tone={tone} dot>
          {label}
        </Badge>
      </div>
      <div>
        <h2 className="text-sm font-semibold text-ink">Audit pipeline liveness</h2>
        <p className="mt-1 text-xs leading-5 text-ink-muted">
          Newest recorded platform event — the log is being written, not just read.
        </p>
        <p className="mt-1 text-xs font-medium text-ink">
          {liveness.state === "live"
            ? formatTimestamp(liveness.newestEventAt)
            : liveness.state === "empty"
              ? "The table is readable but holds no events yet."
              : "Could not check — the audit table is not readable."}
        </p>
      </div>
    </Card>
  );
}

function MetricLine({
  metric,
  render,
  unavailableNote,
}: {
  metric: MetricState<number>;
  render: (value: number) => React.ReactNode;
  unavailableNote: string;
}) {
  if (metric.state !== "available") {
    return <p className="text-sm text-ink-subtle">{unavailableNote}</p>;
  }
  return <>{render(metric.value)}</>;
}

function ConfigurationRow({ signal }: { signal: ConfigSignal }) {
  return (
    <TableRow>
      <TableCell>
        <p className="font-medium text-ink">{signal.label}</p>
        {!signal.configured ? (
          <p className="mt-0.5 text-xs text-ink-muted">{signal.missingNote}</p>
        ) : null}
      </TableCell>
      <TableCell>
        <span className="font-mono text-xs break-all text-ink-muted">{signal.variable}</span>
      </TableCell>
      <TableCell>
        <Badge tone={signal.configured ? "success" : "warning"}>
          {signal.configured ? "Configured" : "Not configured"}
        </Badge>
      </TableCell>
    </TableRow>
  );
}
