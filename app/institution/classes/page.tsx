import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import {
  resolveClassListQuery,
  classPageHref,
  orgTotalPages,
  ORG_STATUS_LABELS,
  type OrgStatus,
} from "@/lib/classes";
import {
  listClassesPage,
  listSessionOptions,
  type ClassRecord,
} from "@/lib/data/classes";
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
  title: "Classes",
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

/** Directory header with the secondary sessions link and primary create action. */
function ClassesToolbar() {
  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Classes</h1>
        <p className="text-sm text-ink-muted">
          Group students into classes so assessments can be assigned to them.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Link href="/institution/classes/sessions">
          <Button type="button" variant="secondary" size="sm">
            Academic sessions
          </Button>
        </Link>
        <Link href="/institution/classes/new">
          <Button type="button" variant="primary" size="sm">
            Add class
          </Button>
        </Link>
      </div>
    </header>
  );
}

/**
 * Search + session + status filters as a plain GET form, so filtering stays
 * server-rendered and shareable in the URL (no client JS required). The `name`
 * attributes match the keys `resolveClassListQuery` reads.
 */
function ClassesFilters({
  q,
  sessionId,
  status,
  sessions,
}: {
  q: string;
  sessionId: string;
  status: OrgStatus | null;
  sessions: { id: string; name: string }[];
}) {
  return (
    <form
      method="get"
      action="/institution/classes"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <Input
        label="Search"
        name="q"
        type="search"
        defaultValue={q}
        placeholder="Class name"
      />
      <Select label="Session" name="session" defaultValue={sessionId}>
        <option value="">All sessions</option>
        {sessions.map((session) => (
          <option key={session.id} value={session.id}>
            {session.name}
          </option>
        ))}
      </Select>
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
        {(q || sessionId || status) && (
          <Link href="/institution/classes">
            <Button type="button" variant="ghost" size="md">
              Clear
            </Button>
          </Link>
        )}
      </div>
    </form>
  );
}

function ClassRows({ classes }: { classes: ClassRecord[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Class</TableHead>
          <TableHead>Session</TableHead>
          <TableHead>Students</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {classes.map((c) => (
          <TableRow key={c.id}>
            <TableCell asHeader>
              <Link
                href={`/institution/classes/${c.id}`}
                className="font-medium text-ink hover:text-brand-700 hover:underline"
              >
                {c.name}
              </Link>
            </TableCell>
            <TableCell>
              {c.academicSessionName ?? <span className="text-ink-subtle">Unassigned</span>}
            </TableCell>
            <TableCell>{c.studentCount}</TableCell>
            <TableCell>
              <StatusBadge status={c.status} />
            </TableCell>
            <TableCell className="text-right">
              <Link href={`/institution/classes/${c.id}/edit`}>
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

export default async function ClassesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  // Authorization (defense in depth alongside the layout). Queries below scope
  // to this trusted tenant id; the class list never reads another's rows.
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes",
  });
  const institutionId = principal.institutionId as string;

  const query = resolveClassListQuery(await searchParams);

  // Data + schema may not be available yet (migrations applied later), so a
  // failure here renders an honest state — never a fabricated directory.
  let classes: ClassRecord[] = [];
  let total = 0;
  let sessions: { id: string; name: string }[] = [];
  let loadError: "unconfigured" | "unavailable" | null = null;

  try {
    const [list, sessionList] = await Promise.all([
      listClassesPage(institutionId, query),
      listSessionOptions(institutionId),
    ]);
    classes = list.rows;
    total = list.total;
    sessions = sessionList;
  } catch (error) {
    loadError = error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  const totalPages = orgTotalPages(total, query.pageSize);
  const hasFilters = Boolean(query.q || query.sessionId || query.status);

  return (
    <>
      <ClassesToolbar />

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <ClassesFilters
            q={query.q}
            sessionId={query.sessionId}
            status={query.status}
            sessions={sessions}
          />

          {loadError === "unconfigured" ? (
            <Alert variant="warning" title="Class data source is not configured">
              Supabase connection variables are missing on the server. Set
              <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
              <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to
              enable the directory.
            </Alert>
          ) : loadError === "unavailable" ? (
            <Alert variant="danger" title="Class data is unavailable">
              The class directory could not be loaded. This is expected until the
              tenant database migration is applied to your Supabase project
              (<span className="font-mono">supabase/migrations</span>). No data
              is shown to avoid presenting anything that has not been created.
            </Alert>
          ) : total === 0 ? (
            <EmptyState
              title={hasFilters ? "No classes match your filters" : "No classes yet"}
              description={
                hasFilters
                  ? "Try a different search term, session, or status."
                  : "Create your first class to organise students and assign assessments."
              }
              action={
                hasFilters ? (
                  <Link href="/institution/classes">
                    <Button type="button" variant="secondary" size="sm">
                      Clear filters
                    </Button>
                  </Link>
                ) : (
                  <Link href="/institution/classes/new">
                    <Button type="button" variant="primary" size="sm">
                      Add class
                    </Button>
                  </Link>
                )
              }
            />
          ) : (
            <>
              <ClassRows classes={classes} />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink-subtle">
                  Showing {classes.length} of {total.toLocaleString()} class
                  {total === 1 ? "" : "es"}.
                </p>
                <Pagination
                  page={query.page}
                  totalPages={totalPages}
                  label="Class pages"
                  hrefFor={(page) =>
                    classPageHref("/institution/classes", query, page)
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
