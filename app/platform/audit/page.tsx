import type { Metadata } from "next";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { roleLabel, type UserRole } from "@/lib/auth/roles";
import {
  AUDIT_ENTITY_TYPES,
  PLATFORM_AUDIT_ACTIONS,
  platformAuditActionLabel,
  platformAuditHasFilters,
  auditPageHref,
  resolvePlatformAuditQuery,
  type PlatformAuditQuery,
} from "@/lib/audit/platform";
import { listPlatformAuditEntries } from "@/lib/data/audit";
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
 * event catalog and the operational filters).
 * SUPER_ADMIN only, enforced server-side on every request.
 *
 * There is no edit or delete path anywhere in the app, and the database
 * refuses UPDATE/DELETE for every role (0007 migration), so this page can
 * truthfully promise immutability. Rows carry actor id, trusted role, action,
 * target, outcome, and timestamp — never secrets or personal content.
 *
 * FILTERS (prompt 33): date range, actor, institution, action, outcome, and
 * entity. The form is a plain GET request; every value is re-resolved
 * server-side through the pure `resolvePlatformAuditQuery`, which drops
 * anything unrecognised — the URL is never trusted to name a column or a
 * value that reaches the database.
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
  const hasFilters = platformAuditHasFilters(query);

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

          {/* Filter bar — server-resolved GET form; date range, actor,
              institution, action, outcome, and entity (prompt 33). */}
          <AuditFilterBar query={query} />

          {entries && entries.rows.length === 0 ? (
            <EmptyState
              title={hasFilters ? "No matching audit events" : "No platform audit events yet"}
              description={
                hasFilters
                  ? "No events match these filters on this page. Widen the date range or clear the filters."
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

/** Entity dropdown labels for the controlled target_type vocabulary. `"none"`
 *  is the resolver's sentinel for rows written without a target. */
const ENTITY_LABELS: Record<string, string> = {
  none: "No target",
  area: "Platform area",
  institution: "Institution",
  institution_application: "Institution application",
  exam: "Exam",
};

/**
 * Server-rendered GET filter form. Values come back through searchParams and
 * are re-validated by the pure resolver before any query runs, so this form
 * is presentation only — it holds no authority. Date inputs are `yyyy-mm-dd`
 * (the resolver pins them to UTC day boundaries).
 */
function AuditFilterBar({ query }: { query: PlatformAuditQuery }) {
  return (
    <Card>
      <form
        action="/platform/audit"
        method="get"
        className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
        aria-label="Audit log filters"
      >
        <Input
          type="date"
          name="from"
          label="From (UTC)"
          defaultValue={query.from ? query.from.slice(0, 10) : ""}
        />
        <Input
          type="date"
          name="to"
          label="To (UTC)"
          defaultValue={query.to ? query.to.slice(0, 10) : ""}
        />
        <Input
          type="text"
          name="actor"
          label="Actor ID"
          placeholder="Clerk user id"
          defaultValue={query.actor ?? ""}
        />
        <Input
          type="text"
          name="institution"
          label="Institution ID"
          placeholder="Rows targeted at this tenant"
          defaultValue={query.institutionId ?? ""}
        />
        <Select name="action" label="Action" defaultValue={query.action ?? ""}>
          <option value="">All actions</option>
          {PLATFORM_AUDIT_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {platformAuditActionLabel(action)}
            </option>
          ))}
        </Select>
        <Select name="outcome" label="Outcome" defaultValue={query.outcome ?? ""}>
          <option value="">All outcomes</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
          <option value="denied">Denied</option>
        </Select>
        <Select name="entity" label="Entity" defaultValue={query.entityType ?? ""}>
          <option value="">All entities</option>
          {AUDIT_ENTITY_TYPES.map((entity) => (
            <option key={entity} value={entity}>
              {ENTITY_LABELS[entity] ?? entity}
            </option>
          ))}
        </Select>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3 xl:col-span-6">
          <Button type="submit">Apply filters</Button>
          {platformAuditHasFilters(query) ? (
            <a href="/platform/audit" className="text-sm font-medium text-brand-600 hover:underline">
              Clear filters
            </a>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
