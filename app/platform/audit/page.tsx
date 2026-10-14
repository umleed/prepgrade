import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { roleLabel, type UserRole } from "@/lib/auth/roles";
import {
  auditPageHref,
  platformAuditActionLabel,
  resolvePlatformAuditQuery,
  type PlatformAuditAction,
} from "@/lib/audit/platform";
import { listPlatformAuditEntries } from "@/lib/data/audit";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Pagination,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type BadgeTone,
} from "@/components/ui";
import { DataSourceUnavailableError } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Platform audit log",
};

// Reads the live session and query params — never prerendered.
export const instant = false;

const ACTOR_ROLE_LABELS: Record<string, string> = {
  unassigned: "Unassigned",
  unknown: "Unknown (anonymous)",
};

function actorRoleLabel(role: string): string {
  const known = roleLabel(role as UserRole);
  return role in ACTOR_ROLE_LABELS ? ACTOR_ROLE_LABELS[role] : known;
}

const OUTCOME_TONES: Record<string, BadgeTone> = {
  success: "success",
  failed: "warning",
  denied: "danger",
};

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
        second: "2-digit",
      });
}

/**
 * Platform audit log — read-only view over the append-only
 * `platform_audit_log` table (prompt 31 foundation; prompt 33 expands the
 * event catalog). SUPER_ADMIN only, enforced server-side on every request.
 *
 * There is no edit or delete path anywhere in the app, and the database
 * refuses UPDATE/DELETE for every role (0007 migration), so this page can
 * truthfully promise immutability. Rows carry actor id, trusted role, action,
 * target, outcome, and timestamp — never secrets or personal content.
 */
export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  const params = await searchParams;
  const query = resolvePlatformAuditQuery(params);

  // Guard BEFORE any read, outside the try/catch so a denial's redirect()
  // propagates untouched: the audit table is platform-wide, so the
  // service-role query may only run for a verified super admin.
  await requireSuperAdmin({ next: "/platform/audit" });

  let entries: Awaited<ReturnType<typeof listPlatformAuditEntries>> | null = null;
  let loadFailed = false;
  let dataSourceConfigured = true;

  try {
    entries = await listPlatformAuditEntries(query);
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      dataSourceConfigured = false;
    } else {
      loadFailed = true;
    }
  }

  const total = entries?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const filterAction: PlatformAuditAction | null = query.action;

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        {/* Page title block (shared shell header lives in the layout). */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink lg:text-3xl">
              Platform Audit Log
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              Append-only record of platform-level actions. Entries cannot be
              edited or deleted — in this UI or at the database.
            </p>
          </div>
          <Badge tone="neutral">{total.toLocaleString()} events</Badge>
        </div>

          {!dataSourceConfigured ? (
            <Alert variant="warning" title="Data source not configured">
              Supabase is not reachable from the server, so the audit log
              cannot be read. Nothing is shown in place of real records.
            </Alert>
          ) : loadFailed ? (
            <Alert variant="danger" title="Audit log unavailable">
              The audit entries could not be read (the table may not have been
              migrated in this environment yet). Reload to try again; no
              substitute or sample data is shown.
            </Alert>
          ) : null}

          {/* Action filter — the only filter today; keeps the table honest
              without inventing columns the events don't carry. */}
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Audit log filters">
            <span className="text-xs font-medium text-ink-muted">Filter action:</span>
            <Link href={auditPageHref("/platform/audit", { ...query, action: null }, 1)}>
              <Button type="button" size="sm" variant={filterAction === null ? "primary" : "secondary"}>
                All
              </Button>
            </Link>
            <Link href={auditPageHref("/platform/audit", { ...query, action: "platform.access_denied" }, 1)}>
              <Button type="button" size="sm" variant={filterAction === "platform.access_denied" ? "primary" : "secondary"}>
                Access denials
              </Button>
            </Link>
          </div>

          {entries && entries.rows.length === 0 ? (
            <EmptyState
              title={filterAction ? "No matching audit events" : "No platform audit events yet"}
              description={
                filterAction
                  ? "No events match this filter on this page. Try the All filter."
                  : "Denied attempts to open platform administration will appear here as they happen. An empty log means nothing has been denied — not that logging is broken."
              }
            />
          ) : entries && entries.rows.length > 0 ? (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.rows.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap text-ink-muted">
                        {formatTimestamp(entry.createdAt)}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs break-all">{entry.actorId}</span>
                      </TableCell>
                      <TableCell>{actorRoleLabel(entry.actorRole)}</TableCell>
                      <TableCell>
                        <p className="font-medium text-ink">{platformAuditActionLabel(entry.action)}</p>
                        <p className="font-mono text-2xs text-ink-subtle">{entry.action}</p>
                        {entry.summary ? (
                          <p className="mt-0.5 text-xs text-ink-muted">{entry.summary}</p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {entry.targetType ? (
                          <span className="text-xs text-ink-muted">
                            {entry.targetType}
                            {entry.targetId ? (
                              <span className="ml-1 font-mono break-all">{entry.targetId}</span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="text-xs text-ink-subtle">—</span>
                        )}
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
            </Card>
          ) : null}

          {entries && entries.rows.length > 0 ? (
            <Pagination
              page={query.page}
              totalPages={totalPages}
              hrefFor={(page) => auditPageHref("/platform/audit", query, page)}
              label="Platform audit log pages"
            />
          ) : null}
        </div>
    </main>
  );
}
