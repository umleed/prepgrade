import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { getSystemHealth } from "@/lib/data/platform-health";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  auditLivenessPresentation,
  assertConfigurationRowSafe,
  configurationRow,
  healthSignalPresentation,
  isPostureDegraded,
} from "@/lib/platform-settings";
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
  type BadgeTone,
} from "@/components/ui";
import { SectionHeading } from "@/components/platform/activity-feed";
import { SettingsIcon } from "@/components/platform/icons";

export const metadata: Metadata = {
  title: "Platform settings",
};

// Reads the live session and runs the health probes — never prerendered.
export const instant = false;

const BASE_PATH = "/platform/settings";

/** Badge tones this view uses are a subset of the UI Badge tones. */
function toBadgeTone(tone: "success" | "warning" | "info" | "neutral"): BadgeTone {
  return tone;
}

/**
 * Platform Settings — READ-ONLY configuration and health posture for the
 * Super Admin area.
 *
 * Everything shown here comes from a source that already exists and can be
 * safely established: the server-side health probes in lib/data/platform-
 * health.ts (the service-role connection reachability, the audit table
 * readability, audit-pipeline liveness, and the PRESENCE — never the value —
 * of server environment variables). There are deliberately no inputs,
 * toggles, save buttons, or actions: no configuration is written, no table or
 * migration is introduced, and no secret value is ever read or rendered.
 *
 * This screen does not replace the operational System Health page
 * (`/platform/health`) — it answers the configuration question ("what is this
 * deployment wired up to?") and links out to the dedicated Health and Audit
 * surfaces for the full operational view, rather than duplicating their
 * charts.
 *
 * Authorization: SUPER_ADMIN only, enforced server-side before any probe runs
 * (in the platform layout and again here), so a cross-cutting read never
 * happens for an unauthorised visitor.
 */
export default async function PlatformSettingsPage() {
  await connection();

  // Guard BEFORE any probe: a denial's redirect() must propagate untouched.
  await requireSuperAdmin({ next: BASE_PATH });

  let health: Awaited<ReturnType<typeof getSystemHealth>> | null = null;
  let dataSourceConfigured = true;
  try {
    health = await getSystemHealth();
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      dataSourceConfigured = false;
    } else {
      health = null;
    }
  }

  const rows = (health?.configuration ?? []).map((signal) =>
    assertConfigurationRowSafe(configurationRow(signal)),
  );

  const posture = health
    ? isPostureDegraded([health.dataSource, health.auditLog])
    : true;

  const dataSignal = health
    ? healthSignalPresentation(health.dataSource, "Reachable", "Unreachable")
    : { tone: "neutral" as const, label: "Unavailable" };
  const auditSignal = health
    ? healthSignalPresentation(health.auditLog, "Readable", "Not readable")
    : { tone: "neutral" as const, label: "Unavailable" };
  const liveness = health
    ? auditLivenessPresentation(health.latestAuditEvent)
    : { tone: "neutral" as const, label: "Unavailable", detail: "Could not check" };

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        <Breadcrumbs
          items={[{ label: "Platform", href: "/platform" }, { label: "Settings" }]}
        />

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-1 flex h-9 w-9 items-center justify-center rounded-field bg-brand-50 text-brand-600"
            >
              <SettingsIcon />
            </span>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-ink lg:text-3xl">
                Platform Settings
              </h1>
              <p className="mt-1 text-sm text-ink-muted">
                Read-only configuration and health posture for this deployment.
                Nothing here can be edited — secrets are never shown, and the
                full operational view lives on the System Health page.
              </p>
            </div>
          </div>
          <Badge tone={posture ? "warning" : "success"} dot>
            {posture ? "Some checks degraded" : "Checks passing"}
          </Badge>
        </div>

        {!dataSourceConfigured || !health ? (
          <Alert variant="warning" title="Health signals unavailable">
            The server could not reach its Supabase connection, so the
            configuration and health signals below could not be established.
            This is a connectivity problem, not a statement that anything is
            misconfigured — no substitute values are shown.
          </Alert>
        ) : posture ? (
          <Alert variant="warning" title="Some platform checks are degraded">
            One or more core signals (data connection, audit table) are not
            currently readable. See the cards below for exactly which, then the
            System Health page for detail.
          </Alert>
        ) : null}

        {/* Core posture — real signals only, unavailable is its own state. */}
        <section
          className="grid gap-4 sm:grid-cols-3"
          aria-label="Platform posture"
        >
          <PostureCard
            title="Data connection"
            description="Supabase service-role client reachable from the server."
            tone={dataSignal.tone}
            label={dataSignal.label}
          />
          <PostureCard
            title="Audit table"
            description="The append-only platform_audit_log is readable."
            tone={auditSignal.tone}
            label={auditSignal.label}
          />
          <PostureCard
            title="Audit pipeline"
            description="Newest recorded platform event."
            tone={liveness.tone}
            label={liveness.label}
            detail={liveness.detail}
          />
        </section>

        {/* Configuration metadata — names and status only, never values. */}
        <Card>
          <div className="flex flex-col gap-3 p-5">
            <SectionHeading
              title="Server configuration"
              description="Presence of server-side environment variables — the variable name and whether it is set. Values are never read or displayed."
            />
            {rows.length === 0 ? (
              <p className="text-sm text-ink-subtle">
                No configuration signals could be established for this request.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Capability</TableHead>
                    <TableHead>Variable</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.variable}>
                      <TableCell>
                        <p className="font-medium text-ink">{row.label}</p>
                        {row.missingNote ? (
                          <p className="mt-0.5 text-xs text-ink-muted">
                            {row.missingNote}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs break-all text-ink-muted">
                          {row.variable}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge tone={toBadgeTone(row.tone)}>{row.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </Card>

        {/* Cross-links to the dedicated operational surfaces (no duplication). */}
        <Card>
          <div className="flex flex-col gap-3 p-5">
            <SectionHeading
              title="Related operational views"
              description="This screen intentionally shows only configuration and a posture summary. Live checks, security signals, and the full audit trail are on their own pages."
            />
            <div className="flex flex-wrap gap-3">
              <Link
                href="/platform/health"
                className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline"
              >
                System Health — full operational checks
              </Link>
              <span aria-hidden="true" className="text-ink-subtle">
                ·
              </span>
              <Link
                href="/platform/audit"
                className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline"
              >
                Platform Audit Log — every recorded event
              </Link>
            </div>
          </div>
        </Card>

        <p className="text-xs leading-5 text-ink-subtle">
          Read-only by design. Configuration changes are not offered from this
          area, and no secret value is ever rendered — only the presence of a
          named variable.
        </p>
      </div>
    </main>
  );
}

function PostureCard({
  title,
  description,
  tone,
  label,
  detail,
}: {
  title: string;
  description: string;
  tone: "success" | "warning" | "info" | "neutral";
  label: string;
  detail?: string;
}) {
  return (
    <Card className="flex flex-col gap-2 p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <Badge tone={toBadgeTone(tone)} dot>
          {label}
        </Badge>
      </div>
      <p className="text-xs leading-5 text-ink-muted">{description}</p>
      {detail ? (
        <p className="text-xs font-medium text-ink-subtle">{detail}</p>
      ) : null}
    </Card>
  );
}
