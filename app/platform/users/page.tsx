import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { roleLabel, USER_ROLES } from "@/lib/auth/roles";
import {
  countUsersByScope,
  listPlatformUsers,
  type PlatformUserListResult,
} from "@/lib/data/platform-users";
import { listInstitutionOptions } from "@/lib/data/platform-usage";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  resolveUserDirectoryQuery,
  USER_DIRECTORY_SCOPES,
  USER_DIRECTORY_SCOPE_LABELS,
  userDirectoryHref,
  displayNameOr,
  membershipStatusLabel,
  rosterStatusLabel,
  statusBadgeTone,
  type UserDirectoryRow,
  type UserDirectoryScope,
} from "@/lib/platform-users";
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
import { SearchIcon, ShieldIcon, UsersIcon } from "@/components/platform/icons";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Users",
};

// Reads the live session and query params — never prerendered.
export const instant = false;

const BASE_PATH = "/platform/users";

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Column plan per scope — every scope reads exactly one real source, so
 *  the header changes with it instead of blending incompatible rows. */
const SCOPE_COLUMNS: Record<UserDirectoryScope, string[]> = {
  accounts: ["Person", "Role", "Institution", "Membership", ""],
  unassigned: ["Person", "Account", "Registered", "", ""],
  students: ["Student", "Code", "Class", "Institution", "Status"],
  teachers: ["Teacher", "Code", "Institution", "Status", ""],
};

function PersonCell({ row }: { row: UserDirectoryRow }) {
  return (
    <TableCell>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"
        >
          <UsersIcon className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0">
          <p className="font-medium text-ink">{displayNameOr(row)}</p>
          {row.email ? (
            <p className="truncate text-xs text-ink-muted">{row.email}</p>
          ) : row.institutionId ? null : (
            <p className="text-xs text-ink-subtle">No email recorded</p>
          )}
        </div>
      </div>
    </TableCell>
  );
}

/**
 * Platform users directory — the Super Admin "Users" section.
 *
 * Read-only operational surface: who is on the platform, in which tenant, in
 * which role, and what their account/roster status is. Every tab is backed by
 * exactly one real table (see lib/platform-users.ts for the scope contract);
 * counts come from live head counts and degrade to "unavailable" rather than
 * zero. No user mutation is offered here by design: accounts are provisioned
 * by the auth flow, memberships by the tenant area, and deactivating someone
 * across tenants is a security-sensitive operation that must happen in the
 * institution that owns them (or via the audited institution lifecycle), not
 * from an unscoped platform table row.
 *
 * Authorization: SUPER_ADMIN only, enforced server-side in the platform
 * layout and again here before any cross-tenant query runs.
 */
export default async function PlatformUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  // Guard first, outside the try/catch, so a denial redirects cleanly.
  await requireSuperAdmin({ next: BASE_PATH });

  // The resolver is pure and clamps every param before it reaches the data
  // layer (unknown scope/dropped filters/clamped pages — see lib tests).
  const params = await searchParams;
  const query = resolveUserDirectoryQuery(params);

  let result: PlatformUserListResult | null = null;
  let dataSourceConfigured = true;
  let loadFailed = false;

  try {
    result = await listPlatformUsers(query);
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      dataSourceConfigured = false;
    } else {
      loadFailed = true;
    }
  }

  // Tab badges: live counts per scope under the active tenant filter.
  const scopeCounts = await countUsersByScope(query.institutionId).catch(
    () => null,
  );

  // Institution filter options (id/name only — same helper the Analytics
  // surface uses; no duplicate option query is introduced here).
  let institutionOptions: Awaited<ReturnType<typeof listInstitutionOptions>> = {
    options: [],
    total: 0,
    truncated: false,
  };
  try {
    institutionOptions = await listInstitutionOptions();
  } catch {
    // Filter options are auxiliary: a failure drops the dropdown to just
    // "All institutions" rather than failing the page.
  }

  const total = result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const isFiltered =
    query.q.length > 0 || query.role !== null || query.institutionId !== null;
  const rangeFrom = total === 0 ? 0 : (query.page - 1) * query.pageSize + 1;
  const rangeTo = Math.min(query.page * query.pageSize, total);

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <Breadcrumbs
          items={[
            { label: "Platform", href: "/platform" },
            { label: "Users" },
          ]}
        />

        {/* Page title block */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink lg:text-3xl">
            Users Management
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Every account, roster record, and tenant membership on PrepGrade.
            Each tab reads one real source — counts and rows below come from
            the live database, never samples.
          </p>
        </div>

        {!dataSourceConfigured ? (
          <Alert variant="warning" title="Data source not configured">
            Supabase is not reachable from the server, so the directory
            cannot be read. No placeholder rows are shown.
          </Alert>
        ) : loadFailed ? (
          <Alert variant="danger" title="Users unavailable">
            The directory could not be read right now. Reload to try again.
          </Alert>
        ) : null}

        {/* Scope tabs with live counts (badge omitted when the count failed —
            a missing badge is honest, a zero would not be). */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="group"
            aria-label="User directory scopes"
            className="flex min-w-0 flex-wrap items-center gap-1 border-b border-border"
          >
            {USER_DIRECTORY_SCOPES.map((scope) => {
              const active = query.scope === scope;
              const count = scopeCounts?.[scope];
              return (
                <Link
                  key={scope}
                  href={userDirectoryHref(BASE_PATH, query, { scope, page: 1 })}
                  className={cn(
                    "-mb-px rounded-t-field border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                    active
                      ? "border-brand text-brand-700"
                      : "border-transparent text-ink-muted hover:border-border-strong hover:text-ink",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  {USER_DIRECTORY_SCOPE_LABELS[scope]}
                  {count !== undefined ? (
                    <span className="ml-1 text-ink-subtle tabular-nums">
                      ({count.toLocaleString()})
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>

          {/* Search + filters. A plain GET form keeps the directory linkable
              and works without client JavaScript; the resolver clamps every
              value server-side. */}
          <form method="get" action={BASE_PATH} role="search" className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="scope" value={query.scope} />
            {query.scope === "accounts" ? (
              <Select
                aria-label="Filter by role"
                name="role"
                defaultValue={query.role ?? ""}
              >
                <option value="">All roles</option>
                {USER_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(role)}
                  </option>
                ))}
              </Select>
            ) : null}
            {query.scope !== "unassigned" ? (
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
            ) : (
              <input
                type="hidden"
                name="institution"
                value={query.institutionId ?? ""}
              />
            )}
            <div className="w-56 sm:w-64">
              <Input
                type="search"
                name="q"
                defaultValue={query.q}
                placeholder="Search name, email, code..."
                aria-label="Search users"
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
            title={isFiltered ? "No matching users" : emptyTitleFor(query.scope)}
            description={
              isFiltered
                ? "No record matches this search or filter. Try clearing the filters."
                : emptyDescriptionFor(query.scope)
            }
          />
        ) : result && result.rows.length > 0 ? (
          <Card className="overflow-hidden p-0">
            <Table className="rounded-none border-0 shadow-none">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  {SCOPE_COLUMNS[query.scope].map((label, index) =>
                    label === "" ? (
                      <TableHead key={index} className="sr-only">
                        Details
                      </TableHead>
                    ) : (
                      <TableHead key={index}>{label}</TableHead>
                    ),
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row, index) => (
                  <TableRow key={row.key}>
                    <TableCell className="text-ink-muted tabular-nums">
                      {(query.page - 1) * query.pageSize + index + 1}
                    </TableCell>
                    <ScopeRow row={row} scope={query.scope} />
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
              <p className="text-xs text-ink-muted">
                Showing {rangeFrom.toLocaleString()} to{" "}
                {rangeTo.toLocaleString()} of {total.toLocaleString()}{" "}
                {USER_DIRECTORY_SCOPE_LABELS[query.scope].toLowerCase()}
              </p>
              <Pagination
                page={query.page}
                totalPages={totalPages}
                hrefFor={(page) => userDirectoryHref(BASE_PATH, query, { page })}
                label="User directory pages"
              />
            </div>
          </Card>
        ) : null}

        {result?.searchTruncated ? (
          <Alert variant="warning" title="Partial search results">
            More records match this search than the directory scans (a
            bounded safety cap). Narrow the term or filter by institution.
          </Alert>
        ) : null}

        {/* Summary tiles for the two headline operational numbers. */}
        <section aria-label="Platform user summary">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <PlatformMetricCard
              label="Tenant Memberships"
              metric={
                scopeCounts && scopeCounts.accounts !== undefined
                  ? { state: "available", value: scopeCounts.accounts }
                  : { state: "unavailable", reason: "error" }
              }
              tone="brand"
              icon={<UsersIcon />}
              hint="Membership rows across all tenants"
            />
            <PlatformMetricCard
              label="Unassigned Accounts"
              metric={
                scopeCounts && scopeCounts.unassigned !== undefined
                  ? { state: "available", value: scopeCounts.unassigned }
                  : { state: "unavailable", reason: "error" }
              }
              tone="warning"
              icon={<ShieldIcon />}
              hint="Signed up, not yet placed in a tenant"
            />
            <PlatformMetricCard
              label="Student Records"
              metric={
                scopeCounts && scopeCounts.students !== undefined
                  ? { state: "available", value: scopeCounts.students }
                  : { state: "unavailable", reason: "error" }
              }
              tone="success"
              icon={<UsersIcon />}
              hint="Live roster rows (soft-deleted excluded)"
            />
            <PlatformMetricCard
              label="Teacher Records"
              metric={
                scopeCounts && scopeCounts.teachers !== undefined
                  ? { state: "available", value: scopeCounts.teachers }
                  : { state: "unavailable", reason: "error" }
              }
              tone="purple"
              icon={<UsersIcon />}
              hint="Live roster rows (soft-deleted excluded)"
            />
          </div>
        </section>

        <p className="text-xs leading-5 text-ink-subtle">
          The directory is read-only by design: accounts are provisioned by
          the sign-up and approval flows, and tenant membership changes happen
          inside the owning institution. SUPER_ADMIN itself holds no tenant
          membership row, so it never appears in the memberships tab. Use an
          institution&apos;s page for tenant-scoped user operations.
        </p>
      </div>
    </main>
  );
}

/* --- Row rendering per scope (same Table primitives, honest columns). ----- */

function ScopeRow({ row, scope }: { row: UserDirectoryRow; scope: UserDirectoryScope }) {
  if (scope === "accounts") {
    return (
      <>
        <PersonCell row={row} />
        <TableCell>{roleLabel(row.role)}</TableCell>
        <TableCell>
          {row.institutionId ? (
            <Link
              href={`/platform/institutions/${row.institutionId}`}
              className="font-medium text-brand hover:underline"
            >
              {row.institutionName ?? "View institution"}
            </Link>
          ) : (
            <span className="text-ink-subtle">—</span>
          )}
        </TableCell>
        <TableCell>
          <Badge tone={statusBadgeTone(row.status)} dot>
            {membershipStatusLabel(row.status)}
          </Badge>
        </TableCell>
        <TableCell />
      </>
    );
  }

  if (scope === "unassigned") {
    return (
      <>
        <PersonCell row={row} />
        <TableCell>
          <Badge tone={statusBadgeTone(row.status)} dot>
            {row.status === "inactive" ? "Deactivated" : "Active"}
          </Badge>
        </TableCell>
        <TableCell className="text-ink-muted">{formatDate(row.createdAt)}</TableCell>
        <TableCell colSpan={2} className="text-ink-subtle">
          Not in any tenant
        </TableCell>
      </>
    );
  }

  if (scope === "students") {
    return (
      <>
        <PersonCell row={row} />
        <TableCell className="font-mono text-xs text-ink-muted">
          {row.code ?? "—"}
        </TableCell>
        <TableCell>{row.className ?? <span className="text-ink-subtle">No class</span>}</TableCell>
        <TableCell>
          {row.institutionId ? (
            <Link
              href={`/platform/institutions/${row.institutionId}`}
              className="font-medium text-brand hover:underline"
            >
              {row.institutionName ?? "View institution"}
            </Link>
          ) : (
            <span className="text-ink-subtle">—</span>
          )}
        </TableCell>
        <TableCell>
          <Badge tone={statusBadgeTone(row.status)} dot>
            {rosterStatusLabel(row.status)}
          </Badge>
        </TableCell>
      </>
    );
  }

  // teachers
  return (
    <>
      <PersonCell row={row} />
      <TableCell className="font-mono text-xs text-ink-muted">
        {row.code ?? "—"}
      </TableCell>
      <TableCell>
        {row.institutionId ? (
          <Link
            href={`/platform/institutions/${row.institutionId}`}
            className="font-medium text-brand hover:underline"
          >
            {row.institutionName ?? "View institution"}
          </Link>
        ) : (
          <span className="text-ink-subtle">—</span>
        )}
      </TableCell>
      <TableCell>
        <Badge tone={statusBadgeTone(row.status)} dot>
          {rosterStatusLabel(row.status)}
        </Badge>
      </TableCell>
      <TableCell />
    </>
  );
}

function emptyTitleFor(scope: UserDirectoryScope): string {
  switch (scope) {
    case "accounts":
      return "No tenant memberships yet";
    case "unassigned":
      return "No unassigned accounts";
    case "students":
      return "No student records yet";
    case "teachers":
      return "No teacher records yet";
  }
}

function emptyDescriptionFor(scope: UserDirectoryScope): string {
  switch (scope) {
    case "accounts":
      return "No institution has members yet on this environment. This is a real zero, not missing data.";
    case "unassigned":
      return "Every registered account already belongs to an institution.";
    case "students":
      return "No institution has enrolled students yet. This is a real zero, not missing data.";
    case "teachers":
      return "No institution has added teachers yet. This is a real zero, not missing data.";
  }
}
