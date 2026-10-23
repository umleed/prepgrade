import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import {
  orgTotalPages,
  questionPageHref,
  resolveQuestionListQuery,
  QUESTION_DIFFICULTIES,
  QUESTION_DIFFICULTY_LABELS,
  QUESTION_STATUS_LABELS,
  QUESTION_TYPE_LABELS,
  type QuestionDifficulty,
  type QuestionStatus,
} from "@/lib/questions";
import {
  getBankStats,
  getSubjectFacet,
  listQuestionsPage,
  type QuestionBankStats,
  type QuestionRecord,
  type SubjectFacet,
} from "@/lib/data/questions";
import {
  INSTITUTION_QUESTION_BANK_PATH,
  INSTITUTION_QUESTION_IMPORT_PATH,
  INSTITUTION_QUESTION_NEW_PATH,
} from "@/lib/navigation/institution-nav";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
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
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Question Bank",
};

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

/**
 * This page's own base — the list, filters, tree and pagination all stay
 * inside the Institution shell so an admin browsing their bank never sees the
 * teaching sidebar (the reported navigation bug).
 */
const BANK_BASE = INSTITUTION_QUESTION_BANK_PATH;

/**
 * Question detail/edit routes live in the SHARED authoring workspace
 * (`/teacher/questions/…`), which institution admins legitimately hold via
 * ROLE_AREAS and which authorizes INSTITUTION_ADMIN server-side on every page.
 * Duplicating that whole tree here would fork the question lifecycle/version
 * history, so the institution route owns only the bank list and creation. Row
 * "View"/"Add" therefore resolve to either the institution create page or the
 * shared detail page — never a teacher-ONLY route.
 */
const QUESTION_WORKSPACE_BASE = "/teacher/questions";

function difficultyTone(difficulty: string): "success" | "warning" | "danger" {
  if (difficulty === "easy") return "success";
  if (difficulty === "hard") return "danger";
  return "warning";
}

/** Headline counts above the bank (active rows only). */
function StatsCards({ stats }: { stats: QuestionBankStats }) {
  const items = [
    { label: "Total questions", value: stats.total, hint: "Active in your bank" },
    { label: "My questions", value: stats.mine, hint: "Created by you" },
    { label: "Subjects covered", value: stats.subjectsCovered, hint: "Subjects with live questions" },
  ];
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {items.map((item) => (
        <Card key={item.label}>
          <div className="p-5">
            <p className="text-sm font-medium text-ink-muted">{item.label}</p>
            <p className="mt-1 text-3xl font-bold tracking-tight text-ink">
              {item.value.toLocaleString()}
            </p>
            <p className="mt-1 text-2xs text-ink-subtle">{item.hint}</p>
          </div>
        </Card>
      ))}
    </div>
  );
}

/**
 * Search + subject + topic + difficulty + status filters as a plain GET form,
 * so filtering stays server-rendered and shareable in the URL. The `name`
 * attributes match the keys `resolveQuestionListQuery` reads, and the form
 * posts back to the institution bank base to stay in-shell.
 */
function BankFilters({
  q,
  subjectId,
  topicId,
  difficulty,
  status,
  mine,
  subjects,
  topics,
}: {
  q: string;
  subjectId: string;
  topicId: string;
  difficulty: QuestionDifficulty | null;
  status: QuestionStatus | null;
  mine: boolean;
  subjects: { id: string; name: string }[];
  topics: { id: string; name: string }[];
}) {
  return (
    <form
      method="get"
      action={BANK_BASE}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6"
    >
      <Input
        label="Search"
        name="q"
        type="search"
        defaultValue={q}
        placeholder="Question text"
      />
      <Select label="Subject" name="subject" defaultValue={subjectId}>
        <option value="">All subjects</option>
        {subjects.map((subject) => (
          <option key={subject.id} value={subject.id}>
            {subject.name}
          </option>
        ))}
      </Select>
      <Select
        label="Topic"
        name="topic"
        defaultValue={topicId}
        description={subjectId ? undefined : "Pick a subject first"}
      >
        <option value="">All topics</option>
        {topics.map((topic) => (
          <option key={topic.id} value={topic.id}>
            {topic.name}
          </option>
        ))}
      </Select>
      <Select label="Difficulty" name="difficulty" defaultValue={difficulty ?? ""}>
        <option value="">All difficulties</option>
        {QUESTION_DIFFICULTIES.map((value) => (
          <option key={value} value={value}>
            {QUESTION_DIFFICULTY_LABELS[value]}
          </option>
        ))}
      </Select>
      <Select label="Status" name="status" defaultValue={status ?? ""}>
        <option value="">All statuses</option>
        {(["active", "archived"] as const).map((value) => (
          <option key={value} value={value}>
            {QUESTION_STATUS_LABELS[value]}
          </option>
        ))}
      </Select>
      <div className="flex items-end gap-3 pb-1">
        <Checkbox label="My questions" name="mine" value="1" defaultChecked={mine} />
        <Button type="submit" variant="primary" size="md">
          Apply
        </Button>
      </div>
    </form>
  );
}

/**
 * Subjects & Topics navigation tree. Links are plain GET navigations that set
 * the same `subject`/`topic` params the filter form uses, so the tree and the
 * table stay shareable and server-rendered.
 */
function SubjectTree({
  facets,
  selectedSubjectId,
  selectedTopicId,
}: {
  facets: SubjectFacet[];
  selectedSubjectId: string;
  selectedTopicId: string;
}) {
  if (facets.length === 0) {
    return (
      <p className="text-sm text-ink-subtle">
        No subjects are available yet. Add subjects first so questions can be
        filed under them.
      </p>
    );
  }

  return (
    <nav aria-label="Subjects and topics">
      <ul className="flex flex-col gap-0.5">
        {facets.map((facet) => {
          const isSelected = facet.id === selectedSubjectId;
          return (
            <li key={facet.id}>
              <Link
                href={`${BANK_BASE}?subject=${facet.id}`}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-field px-2.5 py-1.5 text-sm",
                  isSelected
                    ? "bg-brand-50 font-medium text-brand-700"
                    : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                )}
                aria-current={isSelected ? "true" : undefined}
              >
                <span className="truncate">{facet.name}</span>
                <span className="shrink-0 text-2xs text-ink-subtle">
                  {facet.questionCount}
                </span>
              </Link>
              {isSelected && facet.topics.length > 0 ? (
                <ul className="mt-0.5 flex flex-col gap-0.5 pl-4">
                  {facet.topics
                    .filter((topic) => !topic.parentId)
                    .map((topic) => (
                      <TopicNode
                        key={topic.id}
                        subjectId={facet.id}
                        topic={topic}
                        subtopics={facet.topics.filter((t) => t.parentId === topic.id)}
                        selectedTopicId={selectedTopicId}
                      />
                    ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function TopicNode({
  subjectId,
  topic,
  subtopics,
  selectedTopicId,
}: {
  subjectId: string;
  topic: SubjectFacet["topics"][number];
  subtopics: SubjectFacet["topics"];
  selectedTopicId: string;
}) {
  const isActive = topic.id === selectedTopicId;
  return (
    <li>
      <Link
        href={`${BANK_BASE}?subject=${subjectId}&topic=${topic.id}`}
        className={cn(
          "flex items-center justify-between gap-2 rounded-field px-2.5 py-1 text-sm",
          isActive
            ? "bg-brand-50 font-medium text-brand-700"
            : "text-ink-muted hover:bg-surface-muted hover:text-ink",
        )}
        aria-current={isActive ? "true" : undefined}
      >
        <span className="truncate">{topic.name}</span>
        <span className="shrink-0 text-2xs text-ink-subtle">
          {topic.questionCount}
        </span>
      </Link>
      {subtopics.length > 0 ? (
        <ul className="flex flex-col gap-0.5 pl-4">
          {subtopics.map((child) => (
            <li key={child.id}>
              <Link
                href={`${BANK_BASE}?subject=${subjectId}&topic=${child.id}`}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-field px-2.5 py-1 text-2xs",
                  child.id === selectedTopicId
                    ? "bg-brand-50 font-medium text-brand-700"
                    : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                )}
              >
                <span className="truncate">└ {child.name}</span>
                <span className="shrink-0 text-ink-subtle">{child.questionCount}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function QuestionRows({ questions }: { questions: QuestionRecord[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Question</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Difficulty</TableHead>
          <TableHead>Subject</TableHead>
          <TableHead>Topic</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {questions.map((question) => (
          <TableRow key={question.id}>
            <TableCell asHeader>
              <Link
                href={`${QUESTION_WORKSPACE_BASE}/${question.id}`}
                className="line-clamp-2 max-w-md font-medium text-ink hover:text-brand-700 hover:underline"
              >
                {question.questionText}
              </Link>
            </TableCell>
            <TableCell>
              <Badge tone="info">
                {QUESTION_TYPE_LABELS.mcq_single}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge tone={difficultyTone(question.difficulty)}>
                {QUESTION_DIFFICULTY_LABELS[
                  question.difficulty as QuestionDifficulty
                ] ?? question.difficulty}
              </Badge>
            </TableCell>
            <TableCell>{question.subjectName}</TableCell>
            <TableCell>
              {question.topicName ?? (
                <span className="text-ink-subtle">—</span>
              )}
            </TableCell>
            <TableCell>
              <Badge
                tone={question.status === "active" ? "success" : "neutral"}
                dot
              >
                {QUESTION_STATUS_LABELS[question.status]}
              </Badge>
            </TableCell>
            <TableCell className="text-right">
              <Link href={`${QUESTION_WORKSPACE_BASE}/${question.id}`}>
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

export default async function InstitutionQuestionBankPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  // Institution-only gate (defense in depth alongside the layout). The layout
  // already restricts `/institution/*` to INSTITUTION_ADMIN, so this list is
  // never served to a teacher — a teacher uses `/teacher/questions`.
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: BANK_BASE,
  });
  const institutionId = principal.institutionId as string;
  const userId = principal.userId;

  const query = resolveQuestionListQuery(await searchParams);

  // Data + schema may not be available yet (migrations applied later), so a
  // failure here renders an honest state — never a fabricated bank.
  let questions: QuestionRecord[] = [];
  let total = 0;
  let stats: QuestionBankStats = { total: 0, mine: 0, subjectsCovered: 0 };
  let facets: SubjectFacet[] = [];
  let loadError: "unconfigured" | "unavailable" | null = null;

  try {
    const [list, bankStats, facetList] = await Promise.all([
      listQuestionsPage(institutionId, query, userId),
      getBankStats(institutionId, userId),
      getSubjectFacet(institutionId, query.subjectId),
    ]);
    questions = list.rows;
    total = list.total;
    stats = bankStats;
    facets = facetList;
  } catch (error) {
    loadError = error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  const totalPages = orgTotalPages(total, query.pageSize);
  const selectedTopics = facets.find((facet) => facet.id === query.subjectId)?.topics ?? [];
  const hasFilters = Boolean(
    query.q || query.subjectId || query.topicId || query.difficulty || query.status || query.mine,
  );

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">
            Question Bank
          </h1>
          <p className="text-sm text-ink-muted">
            Create, manage and reuse high-quality questions for your
            examinations.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={INSTITUTION_QUESTION_IMPORT_PATH}>
            <Button type="button" variant="secondary" size="sm">
              Import
            </Button>
          </Link>
          <Link href={INSTITUTION_QUESTION_NEW_PATH}>
            <Button type="button" variant="primary" size="sm">
              Add question
            </Button>
          </Link>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
          <StatsCards stats={stats} />

          <BankFilters
            q={query.q}
            subjectId={query.subjectId}
            topicId={query.topicId}
            difficulty={query.difficulty}
            status={query.status}
            mine={query.mine}
            subjects={facets.map((facet) => ({ id: facet.id, name: facet.name }))}
            topics={selectedTopics}
          />

          {loadError === "unconfigured" ? (
            <Alert variant="warning" title="Question bank is not configured">
              Supabase connection variables are missing on the server. Set
              <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
              <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to
              enable the bank.
            </Alert>
          ) : loadError === "unavailable" ? (
            <Alert variant="danger" title="Question data is unavailable">
              The question bank could not be loaded. This is expected until the
              questions migration is applied to your Supabase project
              (<span className="font-mono">supabase/migrations</span>). No data
              is shown to avoid presenting anything that has not been created.
            </Alert>
          ) : total === 0 ? (
            <EmptyState
              title={
                hasFilters
                  ? "No questions match your filters"
                  : "Your question bank is empty"
              }
              description={
                hasFilters
                  ? "Try a different search term, subject, topic, difficulty, or status."
                  : "Add your institution's first question so exams can be assembled from it."
              }
              action={
                hasFilters ? (
                  <Link href={BANK_BASE}>
                    <Button type="button" variant="secondary" size="sm">
                      Clear filters
                    </Button>
                  </Link>
                ) : (
                  <Link href={INSTITUTION_QUESTION_NEW_PATH}>
                    <Button type="button" variant="primary" size="sm">
                      Add question
                    </Button>
                  </Link>
                )
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
              <Card className="h-fit">
                <div className="p-4">
                  <h2 className="mb-2 text-sm font-semibold text-ink">
                    Subjects &amp; Topics
                  </h2>
                  <SubjectTree
                    facets={facets}
                    selectedSubjectId={query.subjectId}
                    selectedTopicId={query.topicId}
                  />
                  {query.subjectId ? (
                    <Link
                      href={questionPageHref(BANK_BASE, { ...query, subjectId: "", topicId: "" }, 1)}
                      className="mt-3 inline-block text-2xs text-brand-700 hover:underline"
                    >
                      Show all subjects
                    </Link>
                  ) : null}
                </div>
              </Card>

              <div className="flex min-w-0 flex-col gap-3">
                <QuestionRows questions={questions} />
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-ink-subtle">
                    Showing {questions.length} of {total.toLocaleString()} question
                    {total === 1 ? "" : "s"}.
                  </p>
                  <Pagination
                    page={query.page}
                    totalPages={totalPages}
                    label="Question pages"
                    hrefFor={(page) => questionPageHref(BANK_BASE, query, page)}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
