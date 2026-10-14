import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import {
  resolveTeacherListQuery,
  teacherTotalPages,
  teacherPageHref,
  TEACHER_STATUS_LABELS,
  type TeacherStatus,
} from "@/lib/teachers";
import { listTeachers, type Teacher } from "@/lib/data/teachers";
import { listClasses } from "@/lib/data/students";
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
  title: "Teachers",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

function StatusBadge({ status }: { status: TeacherStatus }) {
  const tone = status === "active" ? "success" : status === "invited" ? "info" : "neutral";
  const dot = status !== "inactive";
  return (
    <Badge tone={tone} dot={dot}>
      {TEACHER_STATUS_LABELS[status]}
    </Badge>
  );
}

/** Directory header with the primary invite action. */
function TeachersToolbar() {
  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Teachers</h1>
        <p className="text-sm text-ink-muted">
          Invite teachers and set the classes they can work with.
        </p>
      </div>
      <Link href="/institution/teachers/new">
        <Button type="button" variant="primary" size="sm">
          Add teacher
        </Button>
      </Link>
    </header>
  );
}

/**
 * Search + class + status filters as a plain GET form, so filtering stays
 * server-rendered and shareable in the URL (no client JS required). The `name`
 * attributes match the keys `resolveTeacherListQuery` reads.
 */
function TeachersFilters({
  q,
  classId,
  status,
  classes,
}: {
  q: string;
  classId: string;
  status: TeacherStatus | null;
  classes: { id: string; name: string }[];
}) {
  return (
    <form
      method="get"
      action="/institution/teachers"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <Input
        label="Search"
        name="q"
        type="search"
        defaultValue={q}
        placeholder="Name, email or employee code"
      />
      <Select label="Class" name="class" defaultValue={classId}>
        <option value="">All classes</option>
        {classes.map((cls) => (
          <option key={cls.id} value={cls.id}>
            {cls.name}
          </option>
        ))}
      </Select>
      <Select label="Status" name="status" defaultValue={status ?? ""}>
        <option value="">All statuses</option>
        {(["invited", "active", "inactive"] as const).map((s) => (
          <option key={s} value={s}>
            {TEACHER_STATUS_LABELS[s]}
          </option>
        ))}
      </Select>
      <div className="flex items-end gap-2">
        <Button type="submit" variant="primary" size="md">
          Apply
        </Button>
        {(q || classId || status) && (
          <Link href="/institution/teachers">
            <Button type="button" variant="ghost" size="md">
              Clear
            </Button>
          </Link>
        )}
      </div>
    </form>
  );
}

function TeacherRows({ teachers }: { teachers: Teacher[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Teacher</TableHead>
          <TableHead>Code</TableHead>
          <TableHead>Classes</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {teachers.map((t) => (
          <TableRow key={t.id}>
            <TableCell asHeader>
              <Link
                href={`/institution/teachers/${t.id}`}
                className="font-medium text-ink hover:text-brand-700 hover:underline"
              >
                {t.fullName}
              </Link>
              <p className="text-xs text-ink-subtle">{t.email}</p>
            </TableCell>
            <TableCell className="font-mono text-xs">{t.employeeCode}</TableCell>
            <TableCell>
              {t.classNames.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {t.classNames.map((name) => (
                    <Badge key={name} tone="neutral">
                      {name}
                    </Badge>
                  ))}
                </span>
              ) : (
                <span className="text-ink-subtle">Unassigned</span>
              )}
            </TableCell>
            <TableCell>
              <StatusBadge status={t.status} />
            </TableCell>
            <TableCell className="text-right">
              <Link href={`/institution/teachers/${t.id}/edit`}>
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

export default async function TeachersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  // Authorization (defense in depth alongside the layout). Queries below scope
  // to this trusted tenant id; the teacher list never reads another's rows.
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/teachers",
  });
  const institutionId = principal.institutionId as string;

  const query = resolveTeacherListQuery(await searchParams);

  // Data + schema may not be available yet (migrations applied later), so a
  // failure here renders an honest state — never a fabricated roster.
  let teachers: Teacher[] = [];
  let total = 0;
  let classes: { id: string; name: string }[] = [];
  let loadError: "unconfigured" | "unavailable" | null = null;

  try {
    const [list, classList] = await Promise.all([
      listTeachers(institutionId, query),
      listClasses(institutionId),
    ]);
    teachers = list.rows;
    total = list.total;
    classes = classList;
  } catch (error) {
    loadError = error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  const totalPages = teacherTotalPages(total, query.pageSize);

  return (
    <>
      <TeachersToolbar />

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <TeachersFilters
            q={query.q}
            classId={query.classId}
            status={query.status}
            classes={classes}
          />

          {loadError === "unconfigured" ? (
            <Alert variant="warning" title="Teacher data source is not configured">
              Supabase connection variables are missing on the server. Set
              <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
              <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to
              enable the directory.
            </Alert>
          ) : loadError === "unavailable" ? (
            <Alert variant="danger" title="Teacher data is unavailable">
              The teacher directory could not be loaded. This is expected until
              the teacher management migration is applied to your Supabase
              project (<span className="font-mono">supabase/migrations</span>).
              No data is shown to avoid presenting anything that has not been
              created.
            </Alert>
          ) : total === 0 ? (
            <EmptyState
              title={
                query.q || query.classId || query.status
                  ? "No teachers match your filters"
                  : "No teachers yet"
              }
              description={
                query.q || query.classId || query.status
                  ? "Try a different search term, class, or status."
                  : "Invite your first teacher to help set questions, build exams, and grade results."
              }
              action={
                query.q || query.classId || query.status ? (
                  <Link href="/institution/teachers">
                    <Button type="button" variant="secondary" size="sm">
                      Clear filters
                    </Button>
                  </Link>
                ) : (
                  <Link href="/institution/teachers/new">
                    <Button type="button" variant="primary" size="sm">
                      Add teacher
                    </Button>
                  </Link>
                )
              }
            />
          ) : (
            <>
              <TeacherRows teachers={teachers} />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink-subtle">
                  Showing {teachers.length} of {total.toLocaleString()} teacher
                  {total === 1 ? "" : "s"}.
                </p>
                <Pagination
                  page={query.page}
                  totalPages={totalPages}
                  label="Teacher pages"
                  hrefFor={(page) =>
                    teacherPageHref("/institution/teachers", query, page)
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
