import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import {
  resolveSessionListQuery,
  sessionPageHref,
  orgTotalPages,
  ORG_STATUS_LABELS,
  type OrgStatus,
} from "@/lib/classes";
import { listSessions, type AcademicSession } from "@/lib/data/classes";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  Alert,
  Badge,
  Button,
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

export const metadata: Metadata = {
  title: "Academic sessions",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

function StatusBadge({ status }: { status: OrgStatus }) {
  return (
    <Badge tone={status === "active" ? "success" : "neutral"} dot>
      {ORG_STATUS_LABELS[status]}
    </Badge>
  );
}

/** Sessions header with the link back to classes and the primary create action. */
function SessionsToolbar() {
  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Academic sessions</h1>
        <p className="text-sm text-ink-muted">
          The academic years your classes and assessments are grouped by.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Link href="/institution/classes">
          <Button type="button" variant="secondary" size="sm">
            Back to classes
          </Button>
        </Link>
        <Link href="/institution/classes/sessions/new">
          <Button type="button" variant="primary" size="sm">
            Add session
          </Button>
        </Link>
      </div>
    </header>
  );
}

/** Search + status filters as a plain GET form (server-rendered, shareable URL). */
function SessionsFilters({
  q,
  status,
}: {
  q: string;
  status: OrgStatus | null;
}) {
  return (
    <form
      method="get"
      action="/institution/classes/sessions"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <Input
        label="Search"
        name="q"
        type="search"
        defaultValue={q}
        placeholder="Session name (e.g. 2025/2026)"
      />
      <Select label="Status" name="status" defaultValue={status ?? ""}>
        <option value="">All statuses</option>
        {(["active", "archived"] as const).map((s) => (
          <option key={s} value={s}>
            {ORG_STATUS_LABELS[s]}
          </option>
        ))}
      </Select>
      <div className="flex items-end gap-2">
        <Button type="submit" variant="primary" size="md">
          Apply
        </Button>
        {(q || status) && (
          <Link href="/institution/classes/sessions">
            <Button type="button" variant="ghost" size="md">
              Clear
            </Button>
          </Link>
        )}
      </div>
    </form>
  );
}

function SessionRows({ sessions }: { sessions: AcademicSession[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Session</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((s) => (
          <TableRow key={s.id}>
            <TableCell asHeader>
              <Link
                href={`/institution/classes/sessions/${s.id}`}
                className="font-medium text-ink hover:text-brand-700 hover:underline"
              >
                {s.name}
              </Link>
            </TableCell>
            <TableCell>
              <StatusBadge status={s.status} />
            </TableCell>
            <TableCell>{new Date(s.createdAt).toLocaleDateString()}</TableCell>
            <TableCell className="text-right">
              <Link href={`/institution/classes/sessions/${s.id}/edit`}>
                <Button type="button" variant="secondary" size="sm">
                  Edit
                </Button>
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  // Authorization (defense in depth alongside the layout). Queries below scope
  // to this trusted tenant id; the session list never reads another's rows.
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes/sessions",
  });
  const institutionId = principal.institutionId as string;

  const query = resolveSessionListQuery(await searchParams);

  let sessions: AcademicSession[] = [];
  let total = 0;
  let loadError: "unconfigured" | "unavailable" | null = null;

  try {
    const list = await listSessions(institutionId, query);
    sessions = list.rows;
    total = list.total;
  } catch (error) {
    loadError = error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  const totalPages = orgTotalPages(total, query.pageSize);
  const hasFilters = Boolean(query.q || query.status);

  return (
    <>
      <SessionsToolbar />

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <SessionsFilters q={query.q} status={query.status} />

          {loadError === "unconfigured" ? (
            <Alert variant="warning" title="Session data source is not configured">
              Supabase connection variables are missing on the server. Set
              <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
              <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to
              enable the directory.
            </Alert>
          ) : loadError === "unavailable" ? (
            <Alert variant="danger" title="Session data is unavailable">
              The academic-session list could not be loaded. This is expected
              until the tenant database migration is applied to your Supabase
              project (<span className="font-mono">supabase/migrations</span>). No
              data is shown to avoid presenting anything that has not been
              created.
            </Alert>
          ) : total === 0 ? (
            <EmptyState
              title={hasFilters ? "No sessions match your filters" : "No academic sessions yet"}
              description={
                hasFilters
                  ? "Try a different search term or status."
                  : "Create a session (e.g. 2025/2026) so classes can be grouped by academic year."
              }
              action={
                hasFilters ? (
                  <Link href="/institution/classes/sessions">
                    <Button type="button" variant="secondary" size="sm">
                      Clear filters
                    </Button>
                  </Link>
                ) : (
                  <Link href="/institution/classes/sessions/new">
                    <Button type="button" variant="primary" size="sm">
                      Add session
                    </Button>
                  </Link>
                )
              }
            />
          ) : (
            <>
              <SessionRows sessions={sessions} />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink-subtle">
                  Showing {sessions.length} of {total.toLocaleString()} session
                  {total === 1 ? "" : "s"}.
                </p>
                <Pagination
                  page={query.page}
                  totalPages={totalPages}
                  label="Session pages"
                  hrefFor={(page) =>
                    sessionPageHref("/institution/classes/sessions", query, page)
                  }
                />
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
