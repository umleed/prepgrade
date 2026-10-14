import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import {
  resolveSubjectListQuery,
  subjectPageHref,
  orgTotalPages,
  CATALOGUE_ORIGINS,
  CATALOGUE_ORIGIN_LABELS,
  CATALOGUE_STATUSES,
  CATALOGUE_STATUS_LABELS,
  originOf,
  type CatalogueOrigin,
  type CatalogueStatus,
} from "@/lib/subjects";
import {
  listCategories,
  listSubjectsPage,
  type SubjectRecord,
} from "@/lib/data/subjects";
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
  title: "Subjects",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

function StatusBadge({ status }: { status: CatalogueStatus }) {
  return (
    <Badge tone={status === "active" ? "success" : "neutral"} dot>
      {CATALOGUE_STATUS_LABELS[status]}
    </Badge>
  );
}

/** Directory header with the primary create action. */
function SubjectsToolbar() {
  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Subjects</h1>
        <p className="text-sm text-ink-muted">
          The catalogue questions, exams, and performance analytics are filed
          under. Add your institution&apos;s own subjects on top of the shared
          starter catalogue.
        </p>
      </div>
      <Link href="/institution/subjects/new">
        <Button type="button" variant="primary" size="sm">
          Add subject
        </Button>
      </Link>
    </header>
  );
}

/**
 * Search + category + origin + status filters as a plain GET form, so
 * filtering stays server-rendered and shareable in the URL. The `name`
 * attributes match the keys `resolveSubjectListQuery` reads.
 */
function SubjectsFilters({
  q,
  categoryId,
  origin,
  status,
  categories,
}: {
  q: string;
  categoryId: string;
  origin: CatalogueOrigin | null;
  status: CatalogueStatus | null;
  categories: { id: string; name: string }[];
}) {
  return (
    <form
      method="get"
      action="/institution/subjects"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
    >
      <Input
        label="Search"
        name="q"
        type="search"
        defaultValue={q}
        placeholder="Subject name"
      />
      <Select label="Exam category" name="category" defaultValue={categoryId}>
        <option value="">All categories</option>
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </Select>
      <Select label="Source" name="origin" defaultValue={origin ?? ""}>
        <option value="">All sources</option>
        {CATALOGUE_ORIGINS.map((value) => (
          <option key={value} value={value}>
            {CATALOGUE_ORIGIN_LABELS[value]}
          </option>
        ))}
      </Select>
      <Select label="Status" name="status" defaultValue={status ?? ""}>
        <option value="">All statuses</option>
        {CATALOGUE_STATUSES.map((s) => (
          <option key={s} value={s}>
            {CATALOGUE_STATUS_LABELS[s]}
          </option>
        ))}
      </Select>
      <div className="flex items-end gap-2">
        <Button type="submit" variant="primary" size="md">
          Apply
        </Button>
        {(q || categoryId || origin || status) && (
          <Link href="/institution/subjects">
            <Button type="button" variant="ghost" size="md">
              Clear
            </Button>
          </Link>
        )}
      </div>
    </form>
  );
}

function SubjectRows({ subjects }: { subjects: SubjectRecord[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Subject</TableHead>
          <TableHead>Code</TableHead>
          <TableHead>Exam categories</TableHead>
          <TableHead>Topics</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {subjects.map((s) => (
          <TableRow key={s.id}>
            <TableCell asHeader>
              <Link
                href={`/institution/subjects/${s.id}`}
                className="font-medium text-ink hover:text-brand-700 hover:underline"
              >
                {s.name}
              </Link>
            </TableCell>
            <TableCell>
              {s.code ?? <span className="text-ink-subtle">—</span>}
            </TableCell>
            <TableCell>
              {s.categoryNames.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {s.categoryNames.map((name) => (
                    <Badge key={name} tone="info">
                      {name}
                    </Badge>
                  ))}
                </span>
              ) : (
                <span className="text-ink-subtle">None</span>
              )}
            </TableCell>
            <TableCell>{s.topicCount}</TableCell>
            <TableCell>
              {originOf(s) === "platform" ? (
                <Badge tone="brand">
                  Platform{s.isSeed ? " · starter" : ""}
                </Badge>
              ) : (
                <Badge tone="neutral">Your institution</Badge>
              )}
            </TableCell>
            <TableCell>
              <StatusBadge status={s.status} />
            </TableCell>
            <TableCell className="text-right">
              <Link href={`/institution/subjects/${s.id}`}>
                <Button type="button" variant="secondary" size="sm">
                  View
                </Button>
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default async function SubjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  // Authorization (defense in depth alongside the layout). Queries below scope
  // to this trusted tenant id; the directory never reads another's rows.
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/subjects",
  });
  const institutionId = principal.institutionId as string;

  const query = resolveSubjectListQuery(await searchParams);

  // Data + schema may not be available yet (migrations applied later), so a
  // failure here renders an honest state — never a fabricated catalogue.
  let subjects: SubjectRecord[] = [];
  let total = 0;
  let categories: { id: string; name: string }[] = [];
  let loadError: "unconfigured" | "unavailable" | null = null;

  try {
    const [list, categoryList] = await Promise.all([
      listSubjectsPage(institutionId, query),
      listCategories(),
    ]);
    subjects = list.rows;
    total = list.total;
    categories = categoryList.map((category) => ({
      id: category.id,
      name: category.name,
    }));
  } catch (error) {
    loadError = error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  const totalPages = orgTotalPages(total, query.pageSize);
  const hasFilters = Boolean(query.q || query.categoryId || query.origin || query.status);

  return (
    <>
      <SubjectsToolbar />

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <SubjectsFilters
            q={query.q}
            categoryId={query.categoryId}
            origin={query.origin}
            status={query.status}
            categories={categories}
          />

          {loadError === "unconfigured" ? (
            <Alert variant="warning" title="Subject catalogue is not configured">
              Supabase connection variables are missing on the server. Set
              <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
              <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to
              enable the catalogue.
            </Alert>
          ) : loadError === "unavailable" ? (
            <Alert variant="danger" title="Subject data is unavailable">
              The subject catalogue could not be loaded. This is expected until
              the catalogue migration is applied to your Supabase project
              (<span className="font-mono">supabase/migrations</span>). No data
              is shown to avoid presenting anything that has not been created.
            </Alert>
          ) : total === 0 ? (
            <EmptyState
              title={
                hasFilters
                  ? "No subjects match your filters"
                  : "No subjects yet"
              }
              description={
                hasFilters
                  ? "Try a different search term, category, source, or status."
                  : "Add your institution's first subject so questions and exams can be filed under it."
              }
              action={
                hasFilters ? (
                  <Link href="/institution/subjects">
                    <Button type="button" variant="secondary" size="sm">
                      Clear filters
                    </Button>
                  </Link>
                ) : (
                  <Link href="/institution/subjects/new">
                    <Button type="button" variant="primary" size="sm">
                      Add subject
                    </Button>
                  </Link>
                )
              }
            />
          ) : (
            <>
              <SubjectRows subjects={subjects} />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink-subtle">
                  Showing {subjects.length} of {total.toLocaleString()} subject
                  {total === 1 ? "" : "s"}.
                </p>
                <Pagination
                  page={query.page}
                  totalPages={totalPages}
                  label="Subject pages"
                  hrefFor={(page) =>
                    subjectPageHref("/institution/subjects", query, page)
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
