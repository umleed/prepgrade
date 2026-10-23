import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import {
  examDisplayState,
  examPageHref,
  formatDuration,
  orgTotalPages,
  resolveExamListQuery,
  EXAM_STATUSES,
  EXAM_STATUS_LABELS,
} from "@/lib/exams";
import { getExamFormOptions, listExamsPage, type ExamRecord } from "@/lib/data/exams";
import { INSTITUTION_EXAMS_NEW_PATH } from "@/lib/navigation/institution-nav";
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
  title: "Exams",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

/** This page's own base — filters and pagination must stay in the institution shell. */
const EXAMS_BASE = "/institution/exams";

/**
 * Exam detail routes. Building, publishing, monitoring, and results
 * live in the shared exam workspace (`/teacher/exams/…`), which institution
 * admins legitimately hold via ROLE_AREAS and which authorizes
 * INSTITUTION_ADMIN server-side on every page. Duplicating that whole tree
 * here would fork the exam lifecycle, so this route owns only the
 * institution-facing management list and creation.
 *
 * Creation is institution-owned (`/institution/exams/new`) — an admin creating
 * an exam must not be bounced into the teaching workspace shell.
 */
const EXAM_WORKSPACE_BASE = "/teacher/exams";

/** "5 Oct 2026, 9:00 AM – 11:00 AM" or an honest placeholder when unscheduled. */
function formatWindow(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt && !endsAt) return "Not scheduled";
  const dateFmt = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const parts = (iso: string | null): string => {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return `${dateFmt.format(date)}, ${timeFmt.format(date)}`;
  };
  if (!endsAt) return `From ${parts(startsAt)}`;
  if (!startsAt) return `Until ${parts(endsAt)}`;
  return `${parts(startsAt)} → ${parts(endsAt)}`;
}

/**
 * Search + subject + status filters as a plain GET form, so filtering stays
 * server-rendered and shareable in the URL. The `name` attributes match the
 * keys `resolveExamListQuery` reads.
 */
function ExamFilters({
  q,
  subjectId,
  status,
  subjects,
}: {
  q: string;
  subjectId: string;
  status: string;
  subjects: { id: string; name: string }[];
}) {
  return (
    <form method="get" action={EXAMS_BASE} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Input
        label="Search"
        name="q"
        type="search"
        defaultValue={q}
        placeholder="Exam title"
      />
      <Select label="Subject" name="subject" defaultValue={subjectId}>
        <option value="">All subjects</option>
        {subjects.map((subject) => (
          <option key={subject.id} value={subject.id}>
            {subject.name}
          </option>
        ))}
      </Select>
      <Select label="Status" name="status" defaultValue={status}>
        <option value="">All statuses</option>
        {EXAM_STATUSES.map((value) => (
          <option key={value} value={value}>
            {EXAM_STATUS_LABELS[value]}
          </option>
        ))}
      </Select>
      <div className="flex items-end pb-1">
        <Button type="submit" variant="primary" size="md">
          Apply
        </Button>
      </div>
    </form>
  );
}

function ExamRows({ exams }: { exams: ExamRecord[] }) {
  const now = new Date();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Exam</TableHead>
          <TableHead>Subject</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Questions</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Schedule</TableHead>
          <TableHead>Classes</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {exams.map((exam) => {
          const display = examDisplayState(exam.status, exam.startsAt, exam.endsAt, now);
          return (
            <TableRow key={exam.id}>
              <TableCell asHeader>
                <Link
                  href={`${EXAM_WORKSPACE_BASE}/${exam.id}`}
                  className="line-clamp-2 max-w-md font-medium text-ink hover:text-brand-700 hover:underline"
                >
                  {exam.title}
                </Link>
              </TableCell>
              <TableCell>{exam.subjectName}</TableCell>
              <TableCell>
                <Badge tone={display.tone} dot>
                  {display.label}
                </Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {exam.questionCount}
              </TableCell>
              <TableCell>{formatDuration(exam.durationMinutes)}</TableCell>
              <TableCell>
                <span className={exam.startsAt || exam.endsAt ? "" : "text-ink-subtle"}>
                  {formatWindow(exam.startsAt, exam.endsAt)}
                </span>
              </TableCell>
              <TableCell>
                {exam.assignedClasses.length > 0 ? (
                  <span className="line-clamp-2 max-w-48">
                    {exam.assignedClasses.map((entry) => entry.name).join(", ")}
                  </span>
                ) : (
                  <span className="text-ink-subtle">Not assigned</span>
                )}
              </TableCell>
              <TableCell className="text-right">
                <Link href={`${EXAM_WORKSPACE_BASE}/${exam.id}`}>
                  <Button type="button" variant="secondary" size="sm">
                    View
                  </Button>
                </Link>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * Institution exam management — every assessment created in this institution,
 * listed inside the Institution Admin shell.
 *
 * Routing note (the bug this page fixes): the sidebar's Exams item used to
 * point at `/teacher/exams`, which rendered the teaching workspace for admins.
 * This route is institution-scoped twice over: the guard below admits ONLY
 * INSTITUTION_ADMIN (a teacher visiting it is bounced, not silently shown the
 * teacher view), and `listExamsPage` filters by the trusted
 * `principal.institutionId` — never a client-supplied tenant.
 */
export default async function InstitutionExamsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  // Institution-only gate (defense in depth alongside the layout).
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: EXAMS_BASE,
  });
  const institutionId = principal.institutionId as string;

  const query = resolveExamListQuery(await searchParams);

  // The exams schema may not be applied yet, so a failure here renders an
  // honest state — never a fabricated list.
  let exams: ExamRecord[] = [];
  let total = 0;
  let subjects: { id: string; name: string }[] = [];
  let loadError: "unconfigured" | "unavailable" | null = null;

  try {
    const [list, options] = await Promise.all([
      listExamsPage(institutionId, query),
      getExamFormOptions(institutionId),
    ]);
    exams = list.rows;
    total = list.total;
    subjects = options.subjects;
  } catch (error) {
    loadError = error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  const totalPages = orgTotalPages(total, query.pageSize);
  const hasFilters = Boolean(query.q || query.subjectId || query.status);

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-ink">Exams</h1>
          <p className="text-sm text-ink-muted">
            Every assessment created in your institution.
          </p>
        </div>
        <Link href={INSTITUTION_EXAMS_NEW_PATH}>
          <Button type="button" variant="primary" size="sm">
            Create exam
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
          <ExamFilters
            q={query.q}
            subjectId={query.subjectId}
            status={query.status ?? ""}
            subjects={subjects}
          />

          {loadError === "unconfigured" ? (
            <Alert variant="warning" title="Exam data is not configured">
              Supabase connection variables are missing on the server. Set
              <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
              <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to
              enable the exam list.
            </Alert>
          ) : loadError === "unavailable" ? (
            <Alert variant="danger" title="Exam data is unavailable">
              The exam list could not be loaded. This is expected until the
              exams migration is applied to your Supabase project
              (<span className="font-mono">supabase/migrations</span>). No data
              is shown to avoid presenting anything that has not been created.
            </Alert>
          ) : total === 0 ? (
            <EmptyState
              title={
                hasFilters
                  ? "No exams match your filters"
                  : "No exams yet"
              }
              description={
                hasFilters
                  ? "Try a different search term, subject, or status."
                  : "Exams created by your institution's teachers and admins will appear here."
              }
              action={
                hasFilters ? (
                  <Link href={EXAMS_BASE}>
                    <Button type="button" variant="secondary" size="sm">
                      Clear filters
                    </Button>
                  </Link>
                ) : (
                  <Link href={INSTITUTION_EXAMS_NEW_PATH}>
                    <Button type="button" variant="primary" size="sm">
                      Create exam
                    </Button>
                  </Link>
                )
              }
            />
          ) : (
            <div className="flex flex-col gap-3">
              <ExamRows exams={exams} />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink-subtle">
                  Showing {exams.length} of {total.toLocaleString()} exam
                  {total === 1 ? "" : "s"}.
                </p>
                <Pagination
                  page={query.page}
                  totalPages={totalPages}
                  label="Exam pages"
                  hrefFor={(page) => examPageHref(EXAMS_BASE, query, page)}
                />
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
