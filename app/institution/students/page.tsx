import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import {
  resolveStudentListQuery,
  studentTotalPages,
  studentPageHref,
  STUDENT_STATUS_LABELS,
  type StudentStatus,
} from "@/lib/students";
import { listStudents, listClasses, type Student } from "@/lib/data/students";
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
  title: "Students",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

function StatusBadge({ status }: { status: StudentStatus }) {
  return (
    <Badge tone={status === "active" ? "success" : "neutral"} dot>
      {STUDENT_STATUS_LABELS[status]}
    </Badge>
  );
}

/** Directory header with the primary create action. */
function StudentsToolbar() {
  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Students</h1>
        <p className="text-sm text-ink-muted">
          Enrol and manage student accounts for your institution.
        </p>
      </div>
      <Link href="/institution/students/new">
        <Button type="button" variant="primary" size="sm">
          Add student
        </Button>
      </Link>
    </header>
  );
}

/**
 * Search + class + status filters as a plain GET form, so filtering stays
 * server-rendered and shareable in the URL (no client JS required). The `name`
 * attributes match the keys `resolveStudentListQuery` reads.
 */
function StudentsFilters({
  q,
  classId,
  status,
  classes,
}: {
  q: string;
  classId: string;
  status: StudentStatus | null;
  classes: { id: string; name: string }[];
}) {
  return (
    <form
      method="get"
      action="/institution/students"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <Input
        label="Search"
        name="q"
        type="search"
        defaultValue={q}
        placeholder="Name or student code"
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
        {(["active", "inactive"] as const).map((s) => (
          <option key={s} value={s}>
            {STUDENT_STATUS_LABELS[s]}
          </option>
        ))}
      </Select>
      <div className="flex items-end gap-2">
        <Button type="submit" variant="primary" size="md">
          Apply
        </Button>
        {(q || classId || status) && (
          <Link href="/institution/students">
            <Button type="button" variant="ghost" size="md">
              Clear
            </Button>
          </Link>
        )}
      </div>
    </form>
  );
}

function StudentRows({ students }: { students: Student[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Student</TableHead>
          <TableHead>Code</TableHead>
          <TableHead>Class</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {students.map((s) => (
          <TableRow key={s.id}>
            <TableCell asHeader>
              <Link
                href={`/institution/students/${s.id}`}
                className="font-medium text-ink hover:text-brand-700 hover:underline"
              >
                {s.fullName}
              </Link>
            </TableCell>
            <TableCell className="font-mono text-xs">{s.studentCode}</TableCell>
            <TableCell>{s.className ?? <span className="text-ink-subtle">Unassigned</span>}</TableCell>
            <TableCell>
              <StatusBadge status={s.status} />
            </TableCell>
            <TableCell className="text-right">
              <Link href={`/institution/students/${s.id}/edit`}>
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

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  // Authorization (defense in depth alongside the layout). Queries below scope
  // to this trusted tenant id; the student list never reads another's rows.
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/students",
  });
  const institutionId = principal.institutionId as string;

  const query = resolveStudentListQuery(await searchParams);

  // Data + schema may not be available yet (migrations applied later), so a
  // failure here renders an honest state — never a fabricated roster.
  let students: Student[] = [];
  let total = 0;
  let classes: { id: string; name: string }[] = [];
  let loadError: "unconfigured" | "unavailable" | null = null;

  try {
    const [list, classList] = await Promise.all([
      listStudents(institutionId, query),
      listClasses(institutionId),
    ]);
    students = list.rows;
    total = list.total;
    classes = classList;
  } catch (error) {
    loadError = error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  const totalPages = studentTotalPages(total, query.pageSize);

  return (
    <>
      <StudentsToolbar />

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <StudentsFilters
            q={query.q}
            classId={query.classId}
            status={query.status}
            classes={classes}
          />

          {loadError === "unconfigured" ? (
            <Alert variant="warning" title="Student data source is not configured">
              Supabase connection variables are missing on the server. Set
              <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
              <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to
              enable the directory.
            </Alert>
          ) : loadError === "unavailable" ? (
            <Alert variant="danger" title="Student data is unavailable">
              The student directory could not be loaded. This is expected until
              the tenant database migration is applied to your Supabase project
              (<span className="font-mono">supabase/migrations</span>). No data
              is shown to avoid presenting anything that has not been created.
            </Alert>
          ) : total === 0 ? (
            <EmptyState
              title={
                query.q || query.classId || query.status
                  ? "No students match your filters"
                  : "No students yet"
              }
              description={
                query.q || query.classId || query.status
                  ? "Try a different search term, class, or status."
                  : "Add your first student to enrol them in classes and assessments."
              }
              action={
                query.q || query.classId || query.status ? (
                  <Link href="/institution/students">
                    <Button type="button" variant="secondary" size="sm">
                      Clear filters
                    </Button>
                  </Link>
                ) : (
                  <Link href="/institution/students/new">
                    <Button type="button" variant="primary" size="sm">
                      Add student
                    </Button>
                  </Link>
                )
              }
            />
          ) : (
            <>
              <StudentRows students={students} />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink-subtle">
                  Showing {students.length} of {total.toLocaleString()} student
                  {total === 1 ? "" : "s"}.
                </p>
                <Pagination
                  page={query.page}
                  totalPages={totalPages}
                  label="Student pages"
                  hrefFor={(page) =>
                    studentPageHref("/institution/students", query, page)
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
