/**
 * Exam data access — SERVER-ONLY.
 *
 * Every function takes the trusted `institutionId` (resolved from the session
 * via `AuthPrincipal`, NEVER from a request body or query param) and applies it
 * as a hard filter to both reads and writes — the same tenant-isolation
 * contract as lib/data/questions.ts, classes.ts and subjects.ts (AGENTS.md §5).
 * The service-role client bypasses RLS, so the `.eq("institution_id", …)`
 * filters here are what isolate tenants.
 *
 * WHAT LIVES WHERE (prompts 17–19)
 * Reads serve the exam list, detail views, the builder, and the assignment
 * flow: an exam row plus the facts those screens display — subject and
 * category names, question counts and total marks (`exam_questions`), and
 * the audience (classes via `exam_class_assignments`, individual students
 * via `exam_student_assignments`, both written by the prompt 19 flow).
 * Writes cover the exam's own details, its lifecycle transitions, the
 * builder's question selection, and the audience: add/remove/re-mark/
 * re-order are all refused once the exam leaves draft/scheduled, and the
 * audience may only change while the exam is still pre-publish. The
 * lifecycle rules themselves are pure (`lib/exams.ts`) so the browser and
 * the server enforce one source.
 *
 * LIFECYCLE INTEGRITY (AGENTS.md §6)
 * `updateExam` refuses any change to a field the exam's status has frozen
 * (`examFieldEditable`), so a published exam's configuration can never be
 * edited out from under active or historical attempts. `setExamStatus` only
 * performs transitions the lifecycle allows; publishing additionally
 * requires at least one attached, still-ACTIVE question and copies the
 * whole selection — content, answer keys, marks, order — into the
 * append-only `exam_question_snapshots` table (prompt 18, 0011), so later
 * bank edits never rewrite delivered or historical results. An empty exam
 * is never delivered.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canTransitionExam,
  examBuilderEditable,
  examEffectiveStudentCount,
  examFieldEditable,
  examIsAvailableToStudent,
  examPublishBlocker,
  examQuestionMarksError,
  studentExamBucket,
  studentExamEligibility,
  type StudentExamBucket,
  type StudentExamEligibility,
  normalizeExamInput,
  parseExamDate,
  toOrgContainsPattern,
  validateExam,
  type ExamInput,
  type ExamListQuery,
  type ExamStatus,
} from "@/lib/exams";
import {
  listCategories,
  subjectIsSelectable,
} from "@/lib/data/subjects";
import { questionIsSelectable } from "@/lib/data/questions";
import { recordPlatformAudit } from "@/lib/data/audit";
import { trackProductAnalytics } from "@/lib/product-analytics/server";
import type { UserRole } from "@/lib/auth/roles.ts";

/** An exam as the app uses it (camelCase). Names/counts are read-time joins. */
export type ExamRecord = {
  id: string;
  institutionId: string;
  createdBy: string;
  title: string;
  description: string;
  subjectId: string;
  /** Platform exam category id; "" when unclassified. */
  categoryId: string;
  durationMinutes: number;
  /** ISO strings; null when unscheduled. */
  startsAt: string | null;
  endsAt: string | null;
  maxAttempts: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  resultsRelease: ExamInput["resultsRelease"];
  status: ExamStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Filled by list/detail reads for display; never trusted from input. */
  subjectName: string;
  categoryName: string | null;
  questionCount: number;
  /** Sum of per-question marks across the current selection. */
  totalMarks: number;
  /** Classes the exam is assigned to (prompt 19 populates this). */
  assignedClasses: { id: string; name: string }[];
  /** Directly assigned students, excluding revoked rows (prompt 19). */
  assignedStudentCount: number;
  /** Audience size frozen at publish; null until the exam publishes. */
  publishedTo: number | null;
};

type ExamRow = {
  id: string;
  institution_id: string;
  created_by: string;
  title: string;
  description: string | null;
  subject_id: string;
  exam_category_id: string | null;
  duration_minutes: number;
  starts_at: string | null;
  ends_at: string | null;
  max_attempts: number;
  shuffle_questions: boolean;
  shuffle_options: boolean;
  results_release: string;
  status: string;
  published_at: string | null;
  published_to: number | null;
  created_at: string;
  updated_at: string;
};

const EXAM_SELECT =
  "id, institution_id, created_by, title, description, subject_id, exam_category_id, duration_minutes, starts_at, ends_at, max_attempts, shuffle_questions, shuffle_options, results_release, status, published_at, published_to, created_at, updated_at";

/** Cast a DB status string, failing closed to `draft` for unknown values. */
function toStatus(value: string): ExamStatus {
  switch (value) {
    case "scheduled":
    case "published":
    case "closed":
    case "archived":
      return value;
    default:
      return "draft";
  }
}

/** Cast a DB release policy string, failing closed to the conservative
 *  default for unknown values (mirrors the 0011 CHECK). */
function toResultsRelease(value: string): ExamInput["resultsRelease"] {
  return value === "immediate" || value === "manual" ? value : "after_window";
}

function toExam(row: ExamRow): ExamRecord {
  return {
    id: row.id,
    institutionId: row.institution_id,
    createdBy: row.created_by,
    title: row.title,
    description: row.description ?? "",
    subjectId: row.subject_id,
    categoryId: row.exam_category_id ?? "",
    durationMinutes: row.duration_minutes,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    maxAttempts: row.max_attempts,
    shuffleQuestions: row.shuffle_questions,
    shuffleOptions: row.shuffle_options,
    resultsRelease: toResultsRelease(row.results_release),
    status: toStatus(row.status),
    publishedAt: row.published_at,
    publishedTo: row.published_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subjectName: "—",
    categoryName: null,
    questionCount: 0,
    totalMarks: 0,
    assignedClasses: [],
    assignedStudentCount: 0,
  };
}

/** Row → insert/update payload; "" optional values become NULL. Partial so
 * the edit-safety path can drop locked fields from a write entirely. */
type ExamPayload = Partial<{
  title: string;
  description: string | null;
  subject_id: string;
  exam_category_id: string | null;
  duration_minutes: number;
  starts_at: string | null;
  ends_at: string | null;
  max_attempts: number;
  shuffle_questions: boolean;
  shuffle_options: boolean;
  results_release: string;
}>;

function toPayload(clean: ExamInput): ExamPayload {
  const starts = parseExamDate(clean.startsAt);
  const ends = parseExamDate(clean.endsAt);
  return {
    title: clean.title,
    description: clean.description || null,
    subject_id: clean.subjectId,
    exam_category_id: clean.categoryId || null,
    duration_minutes: clean.durationMinutes,
    starts_at: starts !== null && !Number.isNaN(starts) ? new Date(starts).toISOString() : null,
    ends_at: ends !== null && !Number.isNaN(ends) ? new Date(ends).toISOString() : null,
    max_attempts: clean.maxAttempts,
    shuffle_questions: clean.shuffleQuestions,
    shuffle_options: clean.shuffleOptions,
    results_release: clean.resultsRelease,
  };
}

/**
 * Attach the display facts the list, detail, and builder render: subject and
 * category names, question counts and total marks, and assigned class names.
 * Bounded per page — a handful of small `in`-filtered reads, all scoped to
 * this tenant.
 */
async function fillDisplayFacts(
  institutionId: string,
  records: ExamRecord[],
): Promise<void> {
  if (records.length === 0) return;

  const supabase = createAdminClient();
  const examIds = records.map((record) => record.id);
  const subjectIds = [...new Set(records.map((record) => record.subjectId))];
  const categoryIds = [
    ...new Set(records.map((record) => record.categoryId).filter(Boolean)),
  ];

  const [subjects, questionRows, assignmentRows, studentAssignmentRows] = await Promise.all([
    supabase.from("subjects").select("id, name").in("id", subjectIds),
    supabase
      .from("exam_questions")
      .select("exam_id, marks")
      .eq("institution_id", institutionId)
      .in("exam_id", examIds),
    supabase
      .from("exam_class_assignments")
      .select("exam_id, class_id")
      .eq("institution_id", institutionId)
      .in("exam_id", examIds),
    supabase
      .from("exam_student_assignments")
      .select("exam_id, student_id")
      .eq("institution_id", institutionId)
      .eq("status", "active")
      .in("exam_id", examIds),
  ]);

  if (subjects.error) throw subjects.error;
  if (questionRows.error) throw questionRows.error;
  if (assignmentRows.error) throw assignmentRows.error;
  if (studentAssignmentRows.error) throw studentAssignmentRows.error;

  const subjectNames = new Map<string, string>(
    (subjects.data ?? []).map((row) => [row.id as string, row.name as string]),
  );

  let categoryNames = new Map<string, string>();
  if (categoryIds.length > 0) {
    const categoriesRes = await supabase
      .from("exam_categories")
      .select("id, name")
      .in("id", categoryIds);
    if (categoriesRes.error) throw categoriesRes.error;
    categoryNames = new Map<string, string>(
      (categoriesRes.data ?? []).map((row) => [row.id as string, row.name as string]),
    );
  }

  const questionCounts = new Map<string, number>();
  const marksTotals = new Map<string, number>();
  for (const row of questionRows.data ?? []) {
    const examId = row.exam_id as string;
    questionCounts.set(examId, (questionCounts.get(examId) ?? 0) + 1);
    const marks = typeof row.marks === "number" ? row.marks : 0;
    marksTotals.set(examId, (marksTotals.get(examId) ?? 0) + marks);
  }

  // Class names need one more read keyed by the assignment rows themselves.
  const classIds = [
    ...new Set((assignmentRows.data ?? []).map((row) => row.class_id as string)),
  ];
  let classNames = new Map<string, string>();
  if (classIds.length > 0) {
    const classesRes = await supabase
      .from("classes")
      .select("id, name")
      .eq("institution_id", institutionId)
      .in("id", classIds);
    if (classesRes.error) throw classesRes.error;
    classNames = new Map<string, string>(
      (classesRes.data ?? []).map((row) => [row.id as string, row.name as string]),
    );
  }

  const classesByExam = new Map<string, { id: string; name: string }[]>();
  for (const row of assignmentRows.data ?? []) {
    const examId = row.exam_id as string;
    const classId = row.class_id as string;
    const name = classNames.get(classId);
    if (!name) continue; // class vanished or foreign — display nothing rather than leak
    const list = classesByExam.get(examId) ?? [];
    list.push({ id: classId, name });
    classesByExam.set(examId, list);
  }

  // Direct student assignments (active only — a revoked row is history).
  const studentCountsByExam = new Map<string, number>();
  for (const row of studentAssignmentRows.data ?? []) {
    const examId = row.exam_id as string;
    studentCountsByExam.set(examId, (studentCountsByExam.get(examId) ?? 0) + 1);
  }

  for (const record of records) {
    record.subjectName = subjectNames.get(record.subjectId) ?? "—";
    record.categoryName = record.categoryId
      ? categoryNames.get(record.categoryId) ?? null
      : null;
    record.questionCount = questionCounts.get(record.id) ?? 0;
    record.totalMarks = marksTotals.get(record.id) ?? 0;
    record.assignedClasses = (classesByExam.get(record.id) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    record.assignedStudentCount = studentCountsByExam.get(record.id) ?? 0;
  }
}

// --- Reads -----------------------------------------------------------------------

/** List this institution's exams with filters, newest first, paginated. */
export async function listExamsPage(
  institutionId: string,
  query: ExamListQuery,
): Promise<{ rows: ExamRecord[]; total: number }> {
  const supabase = createAdminClient();

  let builder = supabase
    .from("exams")
    .select(EXAM_SELECT, { count: "exact" })
    .eq("institution_id", institutionId);

  if (query.q) {
    const pattern = toOrgContainsPattern(query.q);
    if (pattern) builder = builder.ilike("title", pattern);
  }
  if (query.subjectId) builder = builder.eq("subject_id", query.subjectId);
  if (query.status) builder = builder.eq("status", query.status);

  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  const { data, error, count } = await builder
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) throw error;

  const rows = (data ?? []).map((row) => toExam(row as unknown as ExamRow));
  await fillDisplayFacts(institutionId, rows);
  return { rows, total: count ?? 0 };
}

/**
 * Fetch one exam of THIS institution, with its display facts. `null` means
 * absent OR another institution's — existence is never leaked (AGENTS.md §5).
 */
export async function getExam(
  institutionId: string,
  id: string,
): Promise<ExamRecord | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("exams")
    .select(EXAM_SELECT)
    .eq("id", id)
    .eq("institution_id", institutionId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const record = toExam(data as unknown as ExamRow);
  await fillDisplayFacts(institutionId, [record]);
  return record;
}

/** Count of questions currently attached to an exam of this tenant. */
export async function countExamQuestions(
  institutionId: string,
  examId: string,
): Promise<number> {
  const supabase = createAdminClient();
  const { count, error } = await supabase
    .from("exam_questions")
    .select("question_id", { count: "exact", head: true })
    .eq("exam_id", examId)
    .eq("institution_id", institutionId);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Everything the exam form needs for one tenant: the active visible subjects
 * the exam can be filed under (platform ∪ own — same visibility rule the
 * question bank applies) and the active platform exam categories.
 * Failures propagate to the page's honest error state.
 */
export async function getExamFormOptions(institutionId: string): Promise<{
  subjects: { id: string; name: string }[];
  categories: { id: string; name: string }[];
}> {
  const supabase = createAdminClient();
  const scope = `institution_id.is.null,institution_id.eq.${institutionId}`;

  const { data, error } = await supabase
    .from("subjects")
    .select("id, name")
    .eq("status", "active")
    .or(scope)
    .order("name", { ascending: true });

  if (error) throw error;
  const categories = await listCategories();
  return {
    subjects: (data ?? []).map((row) => ({
      id: row.id as string,
      name: row.name as string,
    })),
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
    })),
  };
}

/** "" is a legitimate "unclassified"; anything else must be an active platform row. */
async function categoryError(
  categoryId: string,
): Promise<string | null> {
  if (!categoryId) return null;
  const categories = await listCategories();
  return categories.some((category) => category.id === categoryId)
    ? null
    : "Choose one of the available exam categories, or none.";
}

// --- Writes -----------------------------------------------------------------------

export type ExamWriteErrors = Partial<
  Record<
    | "title"
    | "description"
    | "subjectId"
    | "categoryId"
    | "durationMinutes"
    | "startsAt"
    | "endsAt"
    | "maxAttempts"
    | "shuffleQuestions"
    | "shuffleOptions"
    | "resultsRelease"
    | "status",
    string
  >
>;

export type ExamWriteResult =
  | { ok: true; id: string }
  | { ok: false; errors: ExamWriteErrors };

/**
 * Structural validation shared by create and update: the pure contract
 * first, then the tenant-dependent link checks (subject visible+active,
 * category an active platform row). Field errors, never exceptions.
 */
async function examLinkErrors(
  institutionId: string,
  clean: ExamInput,
): Promise<ExamWriteErrors> {
  const errors = validateExam(clean) as ExamWriteErrors;
  if (Object.keys(errors).length > 0) return errors;

  if (!(await subjectIsSelectable(institutionId, clean.subjectId))) {
    errors.subjectId = "Choose an active subject.";
    return errors;
  }

  const catError = await categoryError(clean.categoryId);
  if (catError) errors.categoryId = catError;
  return errors;
}

/**
 * Insert an institution-owned exam as a DRAFT. The tenant id and `created_by`
 * come from the trusted principal, so a crafted payload can never author an
 * exam in another tenant or spoof authorship. Subject and category ids are
 * validated against the caller's tenant and the active platform catalogue
 * BEFORE the write — the load-bearing checks the FKs cannot make.
 */
export async function createExam(
  institutionId: string,
  userId: string,
  input: ExamInput,
  actorRole: UserRole | null = null,
): Promise<ExamWriteResult> {
  const clean = normalizeExamInput(input);

  const errors = await examLinkErrors(institutionId, clean);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("exams")
    .insert({
      ...toPayload(clean),
      institution_id: institutionId,
      created_by: userId,
      status: "draft",
    })
    .select("id")
    .single();

  if (error) throw error;
  const examId = (data as { id: string }).id;

  // Product analytics (prompt 36): the draft-creation moment. The category is
  // resolved to its catalogue NAME server-side (the stable documented
  // dimension); role comes from the trusted principal the caller passed, and
  // the pure layer drops it when absent. Title/text never travel.
  const examCategory = clean.categoryId
    ? (await listCategories()).find(
        (category) => category.id === clean.categoryId,
      )?.name ?? null
    : null;
  await trackProductAnalytics(
    "exam_created",
    { examId, examCategory, role: actorRole },
    { institutionId },
  );
  return { ok: true, id: examId };
}

/**
 * Update an institution-owned exam's details, scoped to the caller's tenant.
 * The row is re-read first so the CURRENT status decides which fields are
 * still editable (`examFieldEditable`): a published exam's delivery-shaping
 * fields are refused here even if a crafted payload sends changed values for
 * them, so active or historical attempts can never be silently altered
 * (AGENTS.md §6). Only the fields the status still allows are written.
 */
export async function updateExam(
  institutionId: string,
  id: string,
  input: ExamInput,
): Promise<ExamWriteResult> {
  const clean = normalizeExamInput(input);

  const current = await getExam(institutionId, id);
  if (!current) return { ok: false, errors: {} };

  // Compare against the stored row so unchanged round-trips of a locked
  // field are not punished — only real changes are refused. Dates compare
  // as parsed epoch ms (unset/invalid both collapse to 0) because the row
  // stores timestamptz while the form carries datetime-local strings.
  const attemptedChanges: ExamWriteErrors = {};
  const lockedMessage = "This exam's status locks that detail — it can no longer be changed here.";

  const refused = (field: keyof ExamInput, changed: boolean): void => {
    if (!examFieldEditable(current.status, field) && changed) {
      attemptedChanges[field as keyof ExamWriteErrors] = lockedMessage;
    }
  };

  const dateValue = (iso: string | null): number =>
    iso ? (parseExamDate(iso) ?? 0) : 0;
  const inputValue = (
    field: "startsAt" | "endsAt",
  ): number => {
    const raw = clean[field];
    const parsed = raw ? parseExamDate(raw) : null;
    return parsed !== null && !Number.isNaN(parsed) ? parsed : 0;
  };

  refused("title", clean.title !== current.title.trim());
  refused("description", clean.description !== current.description.trim());
  refused("subjectId", clean.subjectId !== current.subjectId);
  refused("categoryId", clean.categoryId !== current.categoryId);
  refused("durationMinutes", clean.durationMinutes !== current.durationMinutes);
  refused("maxAttempts", clean.maxAttempts !== current.maxAttempts);
  refused("shuffleQuestions", clean.shuffleQuestions !== current.shuffleQuestions);
  refused("shuffleOptions", clean.shuffleOptions !== current.shuffleOptions);
  refused("resultsRelease", clean.resultsRelease !== current.resultsRelease);
  refused("startsAt", inputValue("startsAt") !== dateValue(current.startsAt));
  refused("endsAt", inputValue("endsAt") !== dateValue(current.endsAt));

  if (Object.keys(attemptedChanges).length > 0) {
    return { ok: false, errors: attemptedChanges };
  }

  // A still-editable subject/category must still be a valid reference —
  // re-checked even though the action validated first, because this is the
  // authoritative write path (AGENTS.md §7).
  const writeErrors = await examLinkErrors(institutionId, clean);
  if (Object.keys(writeErrors).length > 0) {
    return { ok: false, errors: writeErrors };
  }

  const payload = toPayload(clean);

  // Locked-but-present fields are dropped from the write entirely, so a
  // request can never race a stored value back into a frozen column.
  const columnsForField: Record<keyof ExamInput, keyof ExamPayload> = {
    title: "title",
    description: "description",
    subjectId: "subject_id",
    categoryId: "exam_category_id",
    durationMinutes: "duration_minutes",
    startsAt: "starts_at",
    endsAt: "ends_at",
    maxAttempts: "max_attempts",
    shuffleQuestions: "shuffle_questions",
    shuffleOptions: "shuffle_options",
    resultsRelease: "results_release",
  };
  for (const field of Object.keys(columnsForField) as (keyof ExamInput)[]) {
    if (!examFieldEditable(current.status, field)) {
      delete payload[columnsForField[field]];
    }
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("exams")
    .update(payload)
    .eq("id", id)
    .eq("institution_id", institutionId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, errors: {} };
  return { ok: true, id };
}

/**
 * Copy the exam's live selection — content, answer keys, explanations, marks,
 * order — into the append-only `exam_question_snapshots` table (prompt 18,
 * AGENTS.md §6). Runs as the authoritative last step before the status
 * flips to published: every attached question must still be ACTIVE and
 * tenant-owned (archived-after-selection fails the publish with an honest
 * message), and the insert collides on its unique keys if two publishes ever
 * race — that error THROWS, it is never swallowed, so a double-snapshot
 * becomes a failed publish rather than rewritten history. The table grants
 * no UPDATE/DELETE at all, so nothing can revise a published snapshot later.
 */
async function snapshotPublishedQuestions(
  institutionId: string,
  examId: string,
): Promise<string | null> {
  const supabase = createAdminClient();

  const { data: links, error: linksError } = await supabase
    .from("exam_questions")
    .select("question_id, position, marks")
    .eq("exam_id", examId)
    .eq("institution_id", institutionId)
    .order("position", { ascending: true });
  if (linksError) throw linksError;

  const rows = links ?? [];
  if (rows.length < 1) {
    return "Add at least one question in the exam builder before publishing.";
  }

  // Idempotent publish retry: if a previous attempt snapshotted but failed
  // before the status flipped, the frozen set already exists — honour it
  // instead of colliding on the unique keys (the table cannot be rewritten).
  const { count: existingCount, error: existingError } = await supabase
    .from("exam_question_snapshots")
    .select("id", { count: "exact", head: true })
    .eq("exam_id", examId)
    .eq("institution_id", institutionId);
  if (existingError) throw existingError;
  if ((existingCount ?? 0) > 0) return null;

  const questionIds = rows.map((row) => row.question_id as string);
  const { data: questionRows, error: questionsError } = await supabase
    .from("questions")
    .select(
      "id, question_type, difficulty, subject_id, question_text, options, correct_option_index, explanation, status",
    )
    .eq("institution_id", institutionId)
    .in("id", questionIds);
  if (questionsError) throw questionsError;

  const byId = new Map<string, Record<string, unknown>>(
    (questionRows ?? []).map((row) => [row.id as string, row as Record<string, unknown>]),
  );

  const snapshots: Record<string, unknown>[] = [];
  for (const link of rows) {
    const questionId = link.question_id as string;
    const question = byId.get(questionId);
    if (!question || question.status !== "active") {
      return "Some selected questions are archived or no longer in your bank — remove them from the exam (or restore them in the bank) before publishing.";
    }
    snapshots.push({
      exam_id: examId,
      question_id: questionId,
      institution_id: institutionId,
      position: link.position,
      marks: link.marks,
      question_type: question.question_type,
      difficulty: question.difficulty,
      subject_id: question.subject_id,
      question_text: question.question_text,
      options: question.options,
      correct_option_index: question.correct_option_index,
      explanation: question.explanation,
    });
  }

  const { error: insertError } = await supabase
    .from("exam_question_snapshots")
    .insert(snapshots);
  if (insertError) throw insertError; // includes a unique-collision race: never silent
  return null;
}

/**
 * The exam's assignment audience as the publish flow confirms it: active
 * class assignments (with live roster counts) and active direct student
 * assignments. Tenant-scoped on every leg — a foreign class or student id
 * resolves to nothing rather than another institution's roster. `overlap`
 * is the deduplication fact: directly assigned students who ALSO sit on
 * one of the assigned class rosters, so the confirmation total and the
 * server's `published_to` stamp can never double-count a student.
 */
export type ExamAudience = {
  classes: { id: string; name: string; studentCount: number }[];
  students: { id: string; fullName: string; className: string | null }[];
  effectiveStudentCount: number;
};

/** Active audience ids — the shape `setExamAudience` compares against. */
async function audienceIds(
  institutionId: string,
  examId: string,
): Promise<{ classIds: string[]; studentIds: string[] }> {
  const supabase = createAdminClient();
  const [classesRes, studentsRes] = await Promise.all([
    supabase
      .from("exam_class_assignments")
      .select("class_id")
      .eq("exam_id", examId)
      .eq("institution_id", institutionId),
    supabase
      .from("exam_student_assignments")
      .select("student_id")
      .eq("exam_id", examId)
      .eq("institution_id", institutionId)
      .eq("status", "active"),
  ]);
  if (classesRes.error) throw classesRes.error;
  if (studentsRes.error) throw studentsRes.error;
  return {
    classIds: (classesRes.data ?? []).map((row) => row.class_id as string),
    studentIds: (studentsRes.data ?? []).map((row) => row.student_id as string),
  };
}

/**
 * The deduplicated active student ids across a set of classes, plus the
 * per-class counts. Rosters read through `students` with the tenant filter,
 * live rows only (`deleted_at IS NULL`) and `active` status — an inactive
 * scholar is not counted into an audience that cannot take the exam.
 */
async function rosterCountsForClasses(
  institutionId: string,
  classIds: string[],
): Promise<{ perClass: Map<string, number>; distinctStudentIds: Set<string> }> {
  const perClass = new Map<string, number>();
  const distinctStudentIds = new Set<string>();
  if (classIds.length === 0) return { perClass, distinctStudentIds };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("students")
    .select("id, class_id")
    .eq("institution_id", institutionId)
    .in("class_id", classIds)
    .eq("status", "active")
    .is("deleted_at", null);
  if (error) throw error;

  for (const row of data ?? []) {
    const classId = row.class_id as string;
    perClass.set(classId, (perClass.get(classId) ?? 0) + 1);
    distinctStudentIds.add(row.id as string);
  }
  return { perClass, distinctStudentIds };
}

/** Read one exam's audience (classes, direct students, deduplicated total). */
export async function getExamAudience(
  institutionId: string,
  examId: string,
): Promise<ExamAudience | null> {
  const supabase = createAdminClient();

  const { classIds, studentIds } = await audienceIds(institutionId, examId);

  const [classRowsRes, studentRowsRes] = await Promise.all([
    classIds.length > 0
      ? supabase
          .from("classes")
          .select("id, name")
          .eq("institution_id", institutionId)
          .in("id", classIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
    studentIds.length > 0
      ? supabase
          .from("students")
          .select("id, full_name, class_id")
          .eq("institution_id", institutionId)
          .in("id", studentIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string; class_id: string | null }[], error: null }),
  ]);
  if (classRowsRes.error) throw classRowsRes.error;
  if (studentRowsRes.error) throw studentRowsRes.error;

  const { perClass, distinctStudentIds } = await rosterCountsForClasses(
    institutionId,
    classIds,
  );

  // Class names for the direct-student rows need the classes table again;
  // reuse the roster leg by reading each student's own class name.
  const studentClassIds = [
    ...new Set(
      (studentRowsRes.data ?? [])
        .map((row) => row.class_id)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  let studentClassNameById = new Map<string, string>();
  if (studentClassIds.length > 0) {
    const namesRes = await supabase
      .from("classes")
      .select("id, name")
      .eq("institution_id", institutionId)
      .in("id", studentClassIds);
    if (namesRes.error) throw namesRes.error;
    studentClassNameById = new Map<string, string>(
      (namesRes.data ?? []).map((row) => [row.id as string, row.name as string]),
    );
  }

  const directIds = new Set(studentIds);
  let overlap = 0;
  for (const studentId of directIds) {
    if (distinctStudentIds.has(studentId)) overlap += 1;
  }

  return {
    classes: (classRowsRes.data ?? [])
      .map((row) => ({
        id: row.id as string,
        name: row.name as string,
        studentCount: perClass.get(row.id as string) ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    students: (studentRowsRes.data ?? [])
      .map((row) => ({
        id: row.id as string,
        fullName: row.full_name as string,
        className: row.class_id
          ? studentClassNameById.get(row.class_id) ?? null
          : null,
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    effectiveStudentCount: examEffectiveStudentCount({
      classStudentCount: distinctStudentIds.size,
      directStudentCount: directIds.size,
      overlapCount: overlap,
    }),
  };
}

/**
 * Active students for the assignment picker, optionally narrowed to one
 * class and/or a name/code search. Tenant-scoped, live rows only, bounded
 * — the picker never receives an unbounded roster.
 */
export async function listAssignableStudents(
  institutionId: string,
  options: { classId?: string; q?: string; limit?: number } = {},
): Promise<{ id: string; fullName: string; studentCode: string; classId: string | null }[]> {
  const supabase = createAdminClient();

  let builder = supabase
    .from("students")
    .select("id, full_name, student_code, class_id")
    .eq("institution_id", institutionId)
    .eq("status", "active")
    .is("deleted_at", null);

  if (options.classId) builder = builder.eq("class_id", options.classId);
  if (options.q) {
    const pattern = toOrgContainsPattern(options.q);
    if (pattern) {
      builder = builder.or(`full_name.ilike.${pattern},student_code.ilike.${pattern}`);
    }
  }

  const { data, error } = await builder
    .order("full_name", { ascending: true })
    .limit(Math.min(options.limit ?? 100, 200));
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id as string,
    fullName: row.full_name as string,
    studentCode: row.student_code as string,
    classId: row.class_id as string | null,
  }));
}

/**
 * Classes with their live rosters for the "Assign by Class" picker, plus
 * how many exams each class already has — the design's table columns. The
 * exam-count read is bounded to this tenant's published/scheduled exams.
 */
export async function listAssignableClasses(
  institutionId: string,
): Promise<{
  id: string;
  name: string;
  academicSessionName: string | null;
  studentCount: number;
  assignedExamCount: number;
}[]> {
  const supabase = createAdminClient();

  const { data: classes, error: classesError } = await supabase
    .from("classes")
    .select("id, name, academic_sessions(name)")
    .eq("institution_id", institutionId)
    .eq("status", "active")
    .order("name", { ascending: true });
  if (classesError) throw classesError;

  const rows = classes ?? [];
  if (rows.length === 0) return [];

  const classIds = rows.map((row) => row.id as string);
  const [{ perClass }, assignmentRows] = await Promise.all([
    rosterCountsForClasses(institutionId, classIds),
    supabase
      .from("exam_class_assignments")
      .select("class_id")
      .eq("institution_id", institutionId)
      .in("class_id", classIds),
  ]);
  if (assignmentRows.error) throw assignmentRows.error;

  const examsByClass = new Map<string, number>();
  for (const row of assignmentRows.data ?? []) {
    const classId = row.class_id as string;
    examsByClass.set(classId, (examsByClass.get(classId) ?? 0) + 1);
  }

  return rows.map((raw) => {
    const row = raw as unknown as {
      id: string;
      name: string;
      academic_sessions: { name: string } | null;
    };
    const session = row.academic_sessions;
    return {
      id: row.id as string,
      name: row.name as string,
      academicSessionName: session?.name ?? null,
      studentCount: perClass.get(row.id as string) ?? 0,
      assignedExamCount: examsByClass.get(row.id as string) ?? 0,
    };
  });
}

export type ExamAudienceResult =
  | { ok: true; effectiveStudentCount: number }
  | { ok: false; message: string };

/**
 * Replace an exam's audience (classes + direct students) in one confirmed
 * save. The gate is the prompt 18 edit rule — the audience is part of what
 * publishing freezes, so it changes only while the exam is draft/scheduled.
 * Every id is verified against the caller's trusted tenant BEFORE any
 * write: classes must be active and attachable, students active and live
 * (the FKs prove existence, not tenancy — AGENTS.md §5). Duplicates in the
 * payload collapse to one assignment (the primary keys make a double-write
 * impossible), removals REVOKE student rows instead of deleting them so the
 * record of who was assigned survives (AGENTS.md §6), and the audit trail
 * records the change with counts only — never student identities.
 */
export async function setExamAudience(
  institutionId: string,
  userId: string,
  actorRole: UserRole | null,
  examId: string,
  classIds: string[],
  studentIds: string[],
): Promise<ExamAudienceResult> {
  const exam = await getExam(institutionId, examId);
  if (!exam) {
    return { ok: false, message: "This exam could not be found in your institution." };
  }
  if (!examBuilderEditable(exam.status)) {
    return {
      ok: false,
      message:
        "This exam has been published — its audience is frozen. Close-side audience changes are not part of this workflow.",
    };
  }

  const wantedClassIds = [...new Set(classIds.map((id) => id.trim()).filter(Boolean))];
  const wantedStudentIds = [...new Set(studentIds.map((id) => id.trim()).filter(Boolean))];

  const supabase = createAdminClient();

  // Classes: every selected id must be this tenant's AND still active, so
  // an archived class can never gain a live assignment.
  if (wantedClassIds.length > 0) {
    const { data: validClasses, error: classesError } = await supabase
      .from("classes")
      .select("id")
      .eq("institution_id", institutionId)
      .eq("status", "active")
      .in("id", wantedClassIds);
    if (classesError) throw classesError;
    if ((validClasses ?? []).length !== wantedClassIds.length) {
      return { ok: false, message: "Some selected classes are no longer available — refresh the list and choose again." };
    }
  }

  // Students: same rule through the roster — active status, live row, own
  // institution. A planted foreign id simply fails the tenant filter.
  if (wantedStudentIds.length > 0) {
    const { data: validStudents, error: studentsError } = await supabase
      .from("students")
      .select("id")
      .eq("institution_id", institutionId)
      .eq("status", "active")
      .is("deleted_at", null)
      .in("id", wantedStudentIds);
    if (studentsError) throw studentsError;
    if ((validStudents ?? []).length !== wantedStudentIds.length) {
      return { ok: false, message: "Some selected students are no longer active — refresh the list and choose again." };
    }
  }

  const current = await audienceIds(institutionId, examId);
  const currentClassSet = new Set(current.classIds);
  const currentStudentSet = new Set(current.studentIds);
  const wantedClassSet = new Set(wantedClassIds);
  const wantedStudentSet = new Set(wantedStudentIds);

  const sameSet = (a: Set<string>, b: Set<string>): boolean =>
    a.size === b.size && [...a].every((id) => b.has(id));
  const audienceUnchanged =
    sameSet(currentClassSet, wantedClassSet) && sameSet(currentStudentSet, wantedStudentSet);

  // --- class rows: add what is new, drop what is gone. Nothing has been
  // delivered pre-publish, so a de-selected class row is a plain removal
  // (the 0010 table has no revoke state), never a history loss.
  const classesToRemove = current.classIds.filter((id) => !wantedClassSet.has(id));
  if (classesToRemove.length > 0) {
    const { error } = await supabase
      .from("exam_class_assignments")
      .delete()
      .eq("exam_id", examId)
      .eq("institution_id", institutionId)
      .in("class_id", classesToRemove);
    if (error) throw error;
  }
  const classesToAdd = wantedClassIds.filter((id) => !currentClassSet.has(id));
  if (classesToAdd.length > 0) {
    const { error } = await supabase.from("exam_class_assignments").insert(
      classesToAdd.map((classId) => ({
        exam_id: examId,
        class_id: classId,
        institution_id: institutionId,
        assigned_by: userId,
      })),
    );
    // A concurrent save racing the same (exam, class) pair collides on the
    // primary key — that is a duplicate PREVENTION working; report honestly.
    if (error) {
      if (error.code === "23505") {
        return { ok: false, message: "That class was assigned by a concurrent save — reload the page to see the current audience." };
      }
      throw error;
    }
  }

  // --- student rows: revoke what is gone, insert-or-reactivate what is
  // new. Re-assignment flips a revoked row back to active so the (exam,
  // student) trail is never broken by a UNIQUE collision.
  const studentsToRevoke = current.studentIds.filter((id) => !wantedStudentSet.has(id));
  if (studentsToRevoke.length > 0) {
    const { error } = await supabase
      .from("exam_student_assignments")
      .update({ status: "revoked" })
      .eq("exam_id", examId)
      .eq("institution_id", institutionId)
      .in("student_id", studentsToRevoke);
    if (error) throw error;
  }
  const studentsToAdd = wantedStudentIds.filter((id) => !currentStudentSet.has(id));
  if (studentsToAdd.length > 0) {
    // Revoke-then-reassign rows already exist (unique exam+student); upsert
    // reactivates them and inserts the genuinely new ones.
    const { error } = await supabase.from("exam_student_assignments").upsert(
      studentsToAdd.map((studentId) => ({
        exam_id: examId,
        student_id: studentId,
        institution_id: institutionId,
        assigned_by: userId,
        status: "active" as const,
      })),
      { onConflict: "exam_id,student_id" },
    );
    if (error) {
      if (error.code === "23505") {
        return { ok: false, message: "That student was assigned by a concurrent save — reload the page to see the current audience." };
      }
      throw error;
    }
  }

  const audience = await getExamAudience(institutionId, examId);
  const effectiveStudentCount = audience?.effectiveStudentCount ?? 0;

  if (!audienceUnchanged) {
    // Counts-only audit of the assignment change (prompt 19: record the
    // action). Identities stay out of the log (AGENTS.md §7).
    await recordPlatformAudit({
      actorId: userId,
      actorRole,
      action: "exam.assignment_changed",
      targetType: "exam",
      targetId: examId,
      outcome: "success",
      detail: `Audience updated: ${audience?.classes.length ?? 0} class(es), ${effectiveStudentCount} student(s) effective`,
    });
  }

  return { ok: true, effectiveStudentCount };
}

/**
 * The authoritative student-access check (prompt 19 implementation note:
 * guessing an exam id is never access). Resolves the exam under the
 * STUDENT'S trusted institution membership first — an exam of another
 * tenant returns null, so existence is never leaked — then accepts EITHER
 * an active direct assignment or membership of an assigned class, and
 * applies the pure availability rule (published + window open). Delivery
 * (prompts 22–23) must route every exam access through this shape.
 */
export async function studentCanAccessExam(
  institutionId: string,
  studentId: string,
  examId: string,
): Promise<{ allowed: true; exam: ExamRecord } | { allowed: false } | null> {
  const supabase = createAdminClient();

  // The student must be a live, active member of THIS institution.
  const { data: student, error: studentError } = await supabase
    .from("students")
    .select("id, class_id")
    .eq("id", studentId)
    .eq("institution_id", institutionId)
    .eq("status", "active")
    .is("deleted_at", null)
    .maybeSingle();
  if (studentError) throw studentError;
  if (!student) return { allowed: false };

  // null exam = absent OR another institution's — the caller renders "not
  // found" either way (AGENTS.md §5).
  const exam = await getExam(institutionId, examId);
  if (!exam) return null;

  const { data: direct, error: directError } = await supabase
    .from("exam_student_assignments")
    .select("exam_id")
    .eq("exam_id", examId)
    .eq("institution_id", institutionId)
    .eq("student_id", studentId)
    .eq("status", "active")
    .maybeSingle();
  if (directError) throw directError;

  let assignmentActive = Boolean(direct);
  if (!assignmentActive && student.class_id) {
    const { data: byClass, error: classError } = await supabase
      .from("exam_class_assignments")
      .select("exam_id")
      .eq("exam_id", examId)
      .eq("institution_id", institutionId)
      .eq("class_id", student.class_id as string)
      .maybeSingle();
    if (classError) throw classError;
    assignmentActive = Boolean(byClass);
  }

  if (!examIsAvailableToStudent({
    status: exam.status,
    assignmentActive,
    startsAt: exam.startsAt,
    endsAt: exam.endsAt,
  })) {
    return { allowed: false };
  }
  return { allowed: true, exam };
}

/**
 * Everything assigned to one student (prompt 20 dashboard read) — the list
 * half of the same audience rules `studentCanAccessExam` enforces per exam:
 * active direct assignments plus the class roster assignment, all under the
 * student's trusted tenant. Only exams a student may ever see are returned:
 * `published` (delivered) and `closed` (history) — drafts and scheduled-but
 * unpublished exams are not yet released to anyone, and archived exams are
 * retired from listings (0010 lifecycle). Display facts (subject name,
 * question count, marks) are filled the same way the staff list fills them.
 *
 * Ordering is dashboard-shaped: open exams first (soonest deadline first),
 * then scheduled ones (earliest start first), then recently ended ones
 * (newest first). Buckets come from the pure rule in lib/exams.ts, so the
 * dashboard and the delivery gate can never disagree about what is open.
 */
export async function listExamsForStudent(
  institutionId: string,
  studentId: string,
  classId: string | null,
): Promise<ExamRecord[]> {
  const supabase = createAdminClient();

  const [directRes, classRes] = await Promise.all([
    supabase
      .from("exam_student_assignments")
      .select("exam_id")
      .eq("institution_id", institutionId)
      .eq("student_id", studentId)
      .eq("status", "active"),
    classId
      ? supabase
          .from("exam_class_assignments")
          .select("exam_id")
          .eq("institution_id", institutionId)
          .eq("class_id", classId)
      : Promise.resolve({ data: null, error: null }),
  ] as const);
  if (directRes.error) throw directRes.error;
  if (classRes.error) throw classRes.error;

  // One row per exam even when both audience paths cover the student.
  const examIds = new Set<string>();
  for (const row of directRes.data ?? []) examIds.add(row.exam_id as string);
  for (const row of classRes.data ?? []) examIds.add(row.exam_id as string);
  if (examIds.size === 0) return [];

  const { data, error } = await supabase
    .from("exams")
    .select(EXAM_SELECT)
    .eq("institution_id", institutionId)
    .in("id", [...examIds])
    .in("status", ["published", "closed"]);
  if (error) throw error;

  const records = (data ?? []).map((row) => toExam(row as unknown as ExamRow));
  await fillDisplayFacts(institutionId, records);

  const now = new Date();
  const bucketRank: Record<StudentExamBucket, number> = {
    available: 0,
    upcoming: 1,
    completed: 2,
  };
  const timeValue = (iso: string | null, fallback: number): number => {
    if (!iso) return fallback;
    const ms = new Date(iso).getTime();
    return Number.isNaN(ms) ? fallback : ms;
  };
  return records.sort((a, b) => {
    const bucketA = studentExamBucket({
      status: a.status,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      now,
    });
    const bucketB = studentExamBucket({
      status: b.status,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      now,
    });
    // The status filter guarantees a bucket; the nullish ranks sort last.
    const rankA = bucketA === null ? 3 : bucketRank[bucketA];
    const rankB = bucketB === null ? 3 : bucketRank[bucketB];
    if (rankA !== rankB) return rankA - rankB;
    if (bucketA === "completed") {
      // Newest-ended first; closed exams with no window fall back to publish.
      const endA = timeValue(a.endsAt ?? a.publishedAt, 0);
      const endB = timeValue(b.endsAt ?? b.publishedAt, 0);
      return endB - endA;
    }
    // available: deadline first (unset deadline last); upcoming: start first.
    if (bucketA === "upcoming") {
      return (
        timeValue(a.startsAt, Number.MAX_SAFE_INTEGER) -
        timeValue(b.startsAt, Number.MAX_SAFE_INTEGER)
      );
    }
    return (
      timeValue(a.endsAt, Number.MAX_SAFE_INTEGER) -
      timeValue(b.endsAt, Number.MAX_SAFE_INTEGER)
    );
  });
}

/**
 * One assigned exam as the prompt 21 screens (list row + pre-exam
 * instructions) see it: the exam's display facts plus the eligibility
 * verdict computed SERVER-SIDE from trusted facts — the student's own
 * roster row, the tenant-scoped audience, the frozen window, and the
 * attempt budget. The instructions screen renders from this and the
 * start action re-runs the same read; the UI is never the boundary
 * (AGENTS.md §5, prompt 21).
 */
export type StudentExamView = {
  exam: ExamRecord;
  eligibility: StudentExamEligibility;
  /** Attempts this student has used. 0 until the attempt store ships
   *  (prompt 23) — the delivery layer replaces this with the real count. */
  attemptsUsed: number;
};

/**
 * Resolve one exam for the viewing student, or `null` when it is not part of
 * their visible set. Built on `listExamsForStudent`, so the audience rules
 * (active direct assignment or class roster), the tenant filter, and the
 * published/closed status filter are the SAME single read the dashboard
 * uses — an exam that was never assigned, was revoked, lives in another
 * institution, or was never released resolves to null exactly alike, and
 * existence is never leaked (AGENTS.md §5). Eligibility then splits the
 * remaining honest states (scheduled / open / expired / attempts exhausted)
 * via the pure rule, so the screen and the start gate agree by
 * construction.
 */
export async function getStudentExamView(
  institutionId: string,
  studentId: string,
  classId: string | null,
  examId: string,
): Promise<StudentExamView | null> {
  const exams = await listExamsForStudent(institutionId, studentId, classId);
  const exam = exams.find((record) => record.id === examId);
  if (!exam) return null;

  // The list only ever returns published/closed exams, both of which the
  // student reached through an active audience path — assignment is proven
  // by the row's presence.
  const eligibility = studentExamEligibility({
    status: exam.status,
    assignmentActive: true,
    startsAt: exam.startsAt,
    endsAt: exam.endsAt,
    attemptsUsed: 0, // no attempt store yet (prompt 23)
    maxAttempts: exam.maxAttempts,
  });
  return { exam, eligibility, attemptsUsed: 0 };
}

/**
 * Perform a lifecycle transition. The pure rules in lib/exams.ts decide
 * everything: the transition must be allowed from the CURRENT status, and
 * publishing additionally requires at least one attached, still-active
 * question (an empty exam is never delivered), a non-empty audience, and a
 * window that has not already closed (prompt 19 — the server validates
 * schedule and target membership before anything is released). Publishing
 * freezes the selection into immutable snapshots BEFORE the status flips,
 * stamps `published_to` with the deduplicated audience size, and records
 * the publish in the audit trail with counts only (AGENTS.md §6, §7).
 * `published_at` is stamped server-side exactly once, when the exam first
 * publishes.
 */
export async function setExamStatus(
  institutionId: string,
  id: string,
  nextStatus: ExamStatus,
  actor: { userId: string; role: UserRole | null } = { userId: "system", role: null },
): Promise<{ ok: true } | { ok: false; reason: "notFound" | "transition"; message?: string }> {
  const current = await getExam(institutionId, id);
  if (!current) return { ok: false, reason: "notFound" };

  if (!canTransitionExam(current.status, nextStatus)) {
    return {
      ok: false,
      reason: "transition",
      message: "That lifecycle change is not allowed from the exam's current status.",
    };
  }

  let audience: ExamAudience | null = null;
  if (nextStatus === "published") {
    audience = await getExamAudience(institutionId, id);
    const blocker = examPublishBlocker(
      current.status,
      current.questionCount,
      audience?.effectiveStudentCount ?? 0,
      current.endsAt,
    );
    if (blocker) return { ok: false, reason: "transition", message: blocker };

    // Authoritative re-check against the live rows + the snapshot write.
    const publishIssue = await snapshotPublishedQuestions(institutionId, id);
    if (publishIssue) return { ok: false, reason: "transition", message: publishIssue };
  }

  const patch: Record<string, unknown> = { status: nextStatus };
  if (nextStatus === "published") {
    if (!current.publishedAt) {
      patch.published_at = new Date().toISOString();
    }
    // Freeze the audience size with the release — what was delivered stays
    // reconstructable even if assignment rows are revised afterwards.
    patch.published_to = audience?.effectiveStudentCount ?? 0;
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("exams")
    .update(patch)
    .eq("id", id)
    .eq("institution_id", institutionId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, reason: "notFound" };

  if (nextStatus === "published") {
    // Record the publishing action (prompt 19). Counts-only detail; the
    // write is best-effort and never blocks the completed transition.
    await recordPlatformAudit({
      actorId: actor.userId,
      actorRole: actor.role,
      action: "exam.published",
      targetType: "exam",
      targetId: id,
      outcome: "success",
      detail: `Published to ${audience?.classes.length ?? 0} class(es) / ${audience?.effectiveStudentCount ?? 0} student(s) effective`,
    });

    // Product analytics (prompt 36): fires only on a completed transition —
    // the CAS-guarded update above — so a refused or replayed publish cannot
    // duplicate it. Category name and audience count only (no question set).
    await trackProductAnalytics(
      "exam_published",
      {
        examId: id,
        examCategory: current.categoryName ?? null,
        audienceSize: audience?.effectiveStudentCount ?? 0,
        role: actor.role,
      },
      { institutionId },
    );
  }
  return { ok: true };
}

// --- Builder: question selection (prompt 18) --------------------------------------

/**
 * One selected question as the builder renders it. The content fields are
 * read by SERVER components only (the build page and its teacher preview),
 * behind the exam.manage role guard — answer keys never reach a client
 * bundle or a student-facing surface (AGENTS.md §6).
 */
export type ExamBuildQuestion = {
  questionId: string;
  position: number;
  marks: number;
  questionText: string;
  difficulty: string;
  options: string[];
  correctOptionIndex: number;
  explanation: string;
  /** Live bank status; only set for draft/scheduled selections. An
   *  archived question blocks publishing with an honest message. */
  bankStatus: "active" | "archived" | null;
};

/** Defensive parse mirroring lib/data/questions.ts. */
function toOptions(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The LIVE selection of a draft/scheduled exam: `exam_questions` joined to
 * the current bank content, ordered by position. Edits here are what the
 * builder mutates; once published the builder reads snapshots instead, so
 * what is displayed is always what students would actually get.
 */
export async function listExamBuildQuestions(
  institutionId: string,
  examId: string,
): Promise<ExamBuildQuestion[]> {
  const supabase = createAdminClient();

  const { data: links, error: linksError } = await supabase
    .from("exam_questions")
    .select("question_id, position, marks")
    .eq("exam_id", examId)
    .eq("institution_id", institutionId)
    .order("position", { ascending: true });
  if (linksError) throw linksError;

  const rows = links ?? [];
  if (rows.length === 0) return [];

  const questionIds = rows.map((row) => row.question_id as string);
  const { data: questionRows, error: questionsError } = await supabase
    .from("questions")
    .select(
      "id, question_text, difficulty, options, correct_option_index, explanation, status",
    )
    .eq("institution_id", institutionId)
    .in("id", questionIds);
  if (questionsError) throw questionsError;

  const byId = new Map<string, Record<string, unknown>>(
    (questionRows ?? []).map((row) => [row.id as string, row as Record<string, unknown>]),
  );

  return rows.flatMap((link) => {
    const questionId = link.question_id as string;
    const question = byId.get(questionId);
    // A link whose question row vanished (foreign or wiped) is skipped
    // rather than leaked — publish re-checks the same set and refuses.
    if (!question) return [];
    return [
      {
        questionId,
        position: link.position as number,
        marks: link.marks as number,
        questionText: question.question_text as string,
        difficulty: question.difficulty as string,
        options: toOptions(question.options),
        correctOptionIndex: question.correct_option_index as number,
        explanation: (question.explanation as string | null) ?? "",
        bankStatus:
          question.status === "archived" ? ("archived" as const) : ("active" as const),
      },
    ];
  });
}

/**
 * The FROZEN content of a published/closed/archived exam, read from the
 * append-only snapshots written at publish. Never the live bank rows —
 * what a delivered exam contained is history (AGENTS.md §6).
 */
export async function listExamSnapshotQuestions(
  institutionId: string,
  examId: string,
): Promise<ExamBuildQuestion[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("exam_question_snapshots")
    .select(
      "question_id, position, marks, question_text, difficulty, options, correct_option_index, explanation",
    )
    .eq("exam_id", examId)
    .eq("institution_id", institutionId)
    .order("position", { ascending: true });
  if (error) throw error;

  return (data ?? []).map((row) => ({
    questionId: row.question_id as string,
    position: row.position as number,
    marks: row.marks as number,
    questionText: row.question_text as string,
    difficulty: row.difficulty as string,
    options: toOptions(row.options),
    correctOptionIndex: row.correct_option_index as number,
    explanation: (row.explanation as string | null) ?? "",
    bankStatus: null,
  }));
}

export type ExamBuilderResult =
  | { ok: true }
  | { ok: false; reason: "notFound" | "locked" | "invalid"; message: string };

/**
 * Shared gate for every builder mutation: the exam must resolve under the
 * caller's trusted tenant, and its status must still allow editing the
 * question set. Presentation may hide these buttons; this is the half that
 * actually refuses a crafted request (AGENTS.md §5, §6).
 */
async function editableExamForBuild(
  institutionId: string,
  examId: string,
): Promise<ExamRecord | ExamBuilderResult> {
  const exam = await getExam(institutionId, examId);
  if (!exam) {
    return { ok: false, reason: "notFound", message: "This exam could not be found in your institution." };
  }
  if (!examBuilderEditable(exam.status)) {
    return {
      ok: false,
      reason: "locked",
      message: "This exam has been published — its question set is frozen so delivered and historical attempts stay intact.",
    };
  }
  return exam;
}

function builderFailure(result: ExamBuilderResult): ExamBuilderResult {
  return result;
}

/**
 * Add a bank question to the exam at the end of the order, copying the
 * bank's default marks (0010: the builder owns per-exam marks from here on).
 * The question must be ACTIVE and belong to the caller's institution —
 * `questionIsSelectable` is the picker guard promised in 0006.
 */
export async function addExamQuestion(
  institutionId: string,
  examId: string,
  questionId: string,
): Promise<ExamBuilderResult> {
  const gate = await editableExamForBuild(institutionId, examId);
  if (!("subjectName" in gate)) return builderFailure(gate);

  if (!(await questionIsSelectable(institutionId, questionId))) {
    return {
      ok: false,
      reason: "invalid",
      message: "Only active questions from your own institution's bank can be added.",
    };
  }

  const supabase = createAdminClient();

  const { data: existing, error: existingError } = await supabase
    .from("exam_questions")
    .select("question_id")
    .eq("exam_id", examId)
    .eq("institution_id", institutionId)
    .eq("question_id", questionId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    return { ok: false, reason: "invalid", message: "That question is already in this exam." };
  }

  // Bank default marks — read under the tenant filter, never trusted from
  // the request (a crafted marks value must never reach a row).
  const { data: question, error: questionError } = await supabase
    .from("questions")
    .select("marks")
    .eq("id", questionId)
    .eq("institution_id", institutionId)
    .maybeSingle();
  if (questionError) throw questionError;
  if (!question) {
    return { ok: false, reason: "invalid", message: "That question no longer exists in your bank." };
  }

  const { data: last, error: lastError } = await supabase
    .from("exam_questions")
    .select("position")
    .eq("exam_id", examId)
    .eq("institution_id", institutionId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) throw lastError;

  const nextPosition = typeof last?.position === "number" ? last.position + 1 : 1;

  const { error: insertError } = await supabase.from("exam_questions").insert({
    exam_id: examId,
    question_id: questionId,
    institution_id: institutionId,
    position: nextPosition,
    marks: question.marks,
  });
  if (insertError) throw insertError;
  return { ok: true };
}

/** Re-mark one selected question. Bounds mirror the DB CHECK via the pure helper. */
export async function setExamQuestionMarks(
  institutionId: string,
  examId: string,
  questionId: string,
  marks: number,
): Promise<ExamBuilderResult> {
  const gate = await editableExamForBuild(institutionId, examId);
  if (!("subjectName" in gate)) return builderFailure(gate);

  const marksError = examQuestionMarksError(marks);
  if (marksError) return { ok: false, reason: "invalid", message: marksError };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("exam_questions")
    .update({ marks })
    .eq("exam_id", examId)
    .eq("institution_id", institutionId)
    .eq("question_id", questionId)
    .select("question_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return { ok: false, reason: "notFound", message: "That question is not part of this exam." };
  }
  return { ok: true };
}

/**
 * Swap a question with its neighbour. The swap goes through one temporary
 * position above the current maximum because `exam_questions` enforces
 * UNIQUE (exam_id, position) — a direct two-row exchange would collide.
 */
export async function moveExamQuestion(
  institutionId: string,
  examId: string,
  questionId: string,
  direction: "up" | "down",
): Promise<ExamBuilderResult> {
  const gate = await editableExamForBuild(institutionId, examId);
  if (!("subjectName" in gate)) return builderFailure(gate);

  const supabase = createAdminClient();
  const { data: linkRows, error: linkError } = await supabase
    .from("exam_questions")
    .select("question_id, position")
    .eq("exam_id", examId)
    .eq("institution_id", institutionId)
    .order("position", { ascending: true });
  if (linkError) throw linkError;

  const rows = linkRows ?? [];
  const index = rows.findIndex((row) => row.question_id === questionId);
  if (index < 0) {
    return { ok: false, reason: "notFound", message: "That question is not part of this exam." };
  }
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= rows.length) {
    return { ok: false, reason: "invalid", message: "That question is already at the edge of the order." };
  }

  const moved = rows[index];
  const other = rows[swapWith];
  const tempPosition = Math.max(moved.position as number, other.position as number) + 1;

  const write = async (targetQuestionId: string, position: number): Promise<void> => {
    const { error } = await supabase
      .from("exam_questions")
      .update({ position })
      .eq("exam_id", examId)
      .eq("institution_id", institutionId)
      .eq("question_id", targetQuestionId);
    if (error) throw error;
  };

  await write(questionId, tempPosition); // vacate the slot first
  await write(other.question_id as string, moved.position as number);
  await write(questionId, other.position as number);
  return { ok: true };
}

/**
 * Remove one selected question and renumber the tail so positions stay
 * dense 1..n. DELETE here is de-selection, not history loss: the question
 * row itself is untouched, and published exams never reach this path —
 * their content lives on in snapshots either way (AGENTS.md §6).
 */
export async function removeExamQuestion(
  institutionId: string,
  examId: string,
  questionId: string,
): Promise<ExamBuilderResult> {
  const gate = await editableExamForBuild(institutionId, examId);
  if (!("subjectName" in gate)) return builderFailure(gate);

  const supabase = createAdminClient();
  const { data: deleted, error: deleteError } = await supabase
    .from("exam_questions")
    .delete({ count: "all" })
    .eq("exam_id", examId)
    .eq("institution_id", institutionId)
    .eq("question_id", questionId)
    .select("position")
    .maybeSingle();
  if (deleteError) throw deleteError;
  if (!deleted) {
    return { ok: false, reason: "notFound", message: "That question is not part of this exam." };
  }

  // Close the gap: shift every later question down by one, ascending so
  // each target position is vacated before it is claimed.
  const { data: tail, error: tailError } = await supabase
    .from("exam_questions")
    .select("question_id, position")
    .eq("exam_id", examId)
    .eq("institution_id", institutionId)
    .gt("position", deleted.position as number)
    .order("position", { ascending: true });
  if (tailError) throw tailError;

  for (const row of tail ?? []) {
    const { error } = await supabase
      .from("exam_questions")
      .update({ position: (row.position as number) - 1 })
      .eq("exam_id", examId)
      .eq("institution_id", institutionId)
      .eq("question_id", row.question_id as string);
    if (error) throw error;
  }
  return { ok: true };
}
