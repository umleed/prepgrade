/**
 * Exam contract and lifecycle rules — pure, dependency-free, unit-testable.
 *
 * The exact same rules run in the browser (instant feedback) and on the server
 * (authoritative). Client validation is convenience only; the server ALWAYS
 * re-validates and re-checks tenancy (AGENTS.md §5, §7). No new packages.
 *
 * WHAT THIS AREA IS FOR (prompts 17–19, 21)
 * An exam is a scheduled assessment assembled from the question bank and
 * delivered to an audience of classes and individual students. This module
 * owns the STATUS MODEL (the only one — prompts 17–19 must not define a
 * competing enum), the configuration contract the builder (prompt 18) edits
 * — category, attempt limit, randomisation, result release, per-question
 * marks — the assignment audience contract the publish flow (prompt 19)
 * confirms with, the lifecycle rules the list/detail views and their actions
 * enforce, and the student-side availability/start rules the My Exams and
 * pre-exam instructions screens (prompt 21) render — the delivery layer
 * (prompts 22–23) re-checks the very same pure functions server-side.
 *
 * STATUS vs DISPLAY STATE (AGENTS.md §8)
 * Stored statuses are draft / scheduled / published / closed / archived.
 * The design's "Active" and "Completed" chips are NOT stored: they are
 * derived from a published exam's availability window at render time by
 * `examDisplayState`, so no second status enum can drift into existence.
 *
 * LIFECYCLE INTEGRITY (AGENTS.md §6)
 * A published exam has live or historical attempts. `examFieldLocks`
 * encodes which fields a given status still allows editing: delivery-shaping
 * fields (subject, category, duration, window, attempts, randomisation,
 * result release) freeze at publish so no later edit can silently change an
 * active or past attempt, and everything freezes once the exam is closed or
 * archived. The question set itself freezes the same way
 * (`examBuilderEditable`): publishing snapshots content and marks into
 * `exam_question_snapshots`, so selection edits stop being safe at publish.
 * Archive, never delete: results (prompts 22–25) will hang off `exams.id`,
 * so ids are stable forever.
 *
 * Subject EXISTENCE and tenant visibility are NOT validated here — they need
 * the database and the caller's trusted institution, so they live in
 * lib/data/exams.ts.
 */

import {
  orgTotalPages,
  toOrgContainsPattern,
} from "./classes.ts";

// --- Lifecycle ---------------------------------------------------------------

export const EXAM_STATUSES = [
  "draft",
  "scheduled",
  "published",
  "closed",
  "archived",
] as const;
export type ExamStatus = (typeof EXAM_STATUSES)[number];

export const EXAM_STATUS_LABELS: Record<ExamStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  published: "Published",
  closed: "Closed",
  archived: "Archived",
};

/** One-line explanation of each status, for detail-page copy. */
export const EXAM_STATUS_HINTS: Record<ExamStatus, string> = {
  draft:
    "Draft — still being prepared. Students cannot see it and it is not assigned to any class yet.",
  scheduled:
    "Scheduled — ready to publish, with an availability window set. Students cannot see it until it is published.",
  published:
    "Published — students can take it during its availability window. Delivery-shaping details are locked so attempts stay fair.",
  closed:
    "Closed — no more attempts are accepted. Results stay available for review.",
  archived:
    "Archived — retired from listings. Kept permanently so historical results keep resolving.",
};

export function isExamStatus(value: unknown): value is ExamStatus {
  return typeof value === "string" &&
    (EXAM_STATUSES as readonly string[]).includes(value);
}

// Badge tone per stored status (design tokens via the shared Badge tones).
export const EXAM_STATUS_TONES: Record<ExamStatus, "neutral" | "brand" | "success" | "warning" | "info"> = {
  draft: "neutral",
  scheduled: "brand",
  published: "success",
  closed: "warning",
  archived: "neutral",
};

// --- Display state (derived, never stored) -------------------------------------

/**
 * The chip the list and detail actually render: a published exam whose window
 * has opened reads "Active", one whose window has passed reads "Completed",
 * everything else shows its stored status. Derived from server data + the
 * render-time clock — the DB never stores "active"/"completed", so the
 * lifecycle enum above stays the single source of truth.
 */
export type ExamDisplayState = {
  label: string;
  tone: "neutral" | "brand" | "success" | "warning" | "info";
};

export function examDisplayState(
  status: ExamStatus,
  startsAt: string | null,
  endsAt: string | null,
  now: Date = new Date(),
): ExamDisplayState {
  if (status === "published") {
    const end = endsAt ? new Date(endsAt).getTime() : null;
    const start = startsAt ? new Date(startsAt).getTime() : null;
    if (end !== null && !Number.isNaN(end) && now.getTime() > end) {
      return { label: "Completed", tone: "info" };
    }
    if (start === null || Number.isNaN(start) || now.getTime() >= start) {
      return { label: "Active", tone: "success" };
    }
    // Published but its window has not opened yet — still reads as scheduled.
    return { label: "Scheduled", tone: "brand" };
  }
  return { label: EXAM_STATUS_LABELS[status], tone: EXAM_STATUS_TONES[status] };
}

// --- Transitions ---------------------------------------------------------------

/**
 * The allowed lifecycle moves. Forward-only by design: a published exam is
 * retired by CLOSING it (attempts and results stay intact), never by pushing
 * it back to draft, and `archived` is the terminal retire state. Scheduled →
 * draft is the one backward move and only ever before anything is published.
 */
const EXAM_TRANSITIONS: Record<ExamStatus, readonly ExamStatus[]> = {
  draft: ["scheduled", "published", "archived"],
  scheduled: ["draft", "published", "closed", "archived"],
  published: ["closed"],
  closed: ["archived"],
  archived: [],
};

export function canTransitionExam(from: ExamStatus, to: ExamStatus): boolean {
  return EXAM_TRANSITIONS[from].includes(to);
}

/** The transitions a given status offers, in lifecycle order (for UIs). */
export function examTransitionOptions(status: ExamStatus): ExamStatus[] {
  return [...EXAM_TRANSITIONS[status]];
}

/**
 * Why an exam cannot be published yet, or `null` when it may be. Publishing
 * an exam with no questions would deliver an empty assessment, and the
 * builder (prompt 18) is what populates `exam_questions` — so the count gate
 * is stated here once and enforced server-side. The audience gate (prompt
 * 19) is the same posture: publishing to nobody would freeze a snapshot no
 * student can ever reach, so at least one class or direct student
 * assignment is required, and an availability window that has already
 * closed cannot be "published" at all. `audienceCount` and the window are
 * facts the caller reads from the database — this function only judges.
 */
export function examPublishBlocker(
  status: ExamStatus,
  questionCount: number,
  audienceCount: number,
  endsAt: string | null = null,
  now: Date = new Date(),
): string | null {
  if (!canTransitionExam(status, "published")) {
    return "Only a draft or scheduled exam can be published.";
  }
  if (questionCount < 1) {
    return "Add at least one question in the exam builder before publishing.";
  }
  if (audienceCount < 1) {
    return "Assign the exam to at least one class or student before publishing.";
  }
  if (endsAt) {
    const end = new Date(endsAt).getTime();
    if (!Number.isNaN(end) && now.getTime() > end) {
      return "This exam's availability window has already ended — set a future window in the exam details before publishing.";
    }
  }
  return null;
}

// --- Edit safety (prompt 17 lifecycle rule) -------------------------------------

/**
 * Fields that shape DELIVERY — what a student experiences while attempting.
 * Once an exam is published they freeze: changing duration or the window of a
 * live exam would silently alter active or historical attempts (AGENTS.md §6).
 * Title/description stay editable on a published exam because they change no
 * scoring or timing; a closed/archived exam freezes everything as history.
 */
const DELIVERY_FIELDS = [
  "subjectId",
  "categoryId",
  "durationMinutes",
  "startsAt",
  "endsAt",
  "maxAttempts",
  "shuffleQuestions",
  "shuffleOptions",
  "resultsRelease",
] as const;

export type ExamDeliveryField = (typeof DELIVERY_FIELDS)[number];

/**
 * Whether a field may still be edited at a given status. Unknown fields fail
 * closed (only explicitly-safe metadata is editable after publish).
 */
// Title/description are the explicit wording metadata a published exam may
// still change; anything not named here fails closed.
const METADATA_FIELDS = ["title", "description"] as const;

export function examFieldEditable(status: ExamStatus, field: string): boolean {
  if (status === "draft" || status === "scheduled") return true;
  if (status === "published") {
    return (
      (METADATA_FIELDS as readonly string[]).includes(field) &&
      !DELIVERY_FIELDS.includes(field as ExamDeliveryField)
    );
  }
  return false; // closed / archived — the record is history.
}

/** The delivery fields a status has frozen, for honest UI messaging. */
export function examLockedFields(status: ExamStatus): string[] {
  if (status === "published") return [...DELIVERY_FIELDS];
  if (status === "closed" || status === "archived") {
    return [...DELIVERY_FIELDS, "title", "description"];
  }
  return [];
}

// --- Assignment audience (prompt 19) -------------------------------------------

/**
 * The deduplicated student audience: everyone on an assigned class roster
 * plus every directly assigned student who is NOT already covered by one of
 * those classes (the design's "combination" of classes and individuals).
 * The caller supplies the counts read from the database; this function only
 * does the arithmetic, so the confirmation step and the server's
 * `published_to` stamp can never disagree about who receives the exam.
 */
export function examEffectiveStudentCount(input: {
  /** Active students across all selected classes (deduplicated by the caller's read). */
  classStudentCount: number;
  /** Directly assigned students (active assignments only). */
  directStudentCount: number;
  /** Direct assignments whose student also sits on a selected class roster. */
  overlapCount: number;
}): number {
  const covered =
    Math.max(0, Math.floor(input.directStudentCount)) -
    Math.max(0, Math.floor(input.overlapCount));
  return Math.max(0, Math.floor(input.classStudentCount)) + Math.max(0, covered);
}

/**
 * Whether a student may open an exam (implementation note: guessing an exam
 * id is never access). The facts must come from tenant-scoped server reads;
 * this function states the rule so the data layer and its tests share one
 * source: only a PUBLISHED exam, only an ACTIVE assignment, only inside the
 * availability window. Scheduled drafts and closed exams stay unreachable,
 * and a window that has not opened (or has passed) is refused even if the
 * assignment row exists.
 */
export function examIsAvailableToStudent(input: {
  status: ExamStatus;
  assignmentActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  now?: Date;
}): boolean {
  if (!input.assignmentActive) return false;
  if (input.status !== "published") return false;
  return examWindowPhase(input.startsAt, input.endsAt, input.now ?? new Date()) === "open";
}

/**
 * Where "now" sits relative to an exam's availability window. One clock
 * rule shared by the delivery gate, the student buckets, and the prompt 21
 * eligibility state, so no two student-facing surfaces can disagree about
 * whether an exam is open. Unparseable bounds are skipped (mirrors
 * `examIsAvailableToStudent`'s NaN handling) — an unset or garbage bound
 * never blocks on its own.
 */
function examWindowPhase(
  startsAt: string | null,
  endsAt: string | null,
  now: Date,
): "upcoming" | "open" | "expired" {
  const time = now.getTime();
  if (startsAt) {
    const start = new Date(startsAt).getTime();
    if (!Number.isNaN(start) && time < start) return "upcoming";
  }
  if (endsAt) {
    const end = new Date(endsAt).getTime();
    if (!Number.isNaN(end) && time > end) return "expired";
  }
  return "open";
}

// --- Student dashboard buckets (prompt 20) ------------------------------------

/**
 * Where an assigned exam sits for the student dashboard. This is NOT a second
 * status enum — it is a render-time grouping of the ONE stored lifecycle
 * (draft/scheduled/published/closed/archived) plus the availability window,
 * derived by the same clock rules `examIsAvailableToStudent` uses, so the
 * dashboard can never disagree with the delivery gate about what is open.
 *
 * Only exams a student may see are bucketed: `published` (upcoming / available
 * / ended) and `closed` (history). Drafts, scheduled-but-unpublished exams,
 * and archived exams return `null` — they do not exist for a student, and the
 * data layer filters them out before this is ever consulted.
 */
export const STUDENT_EXAM_BUCKETS = ["upcoming", "available", "completed"] as const;
export type StudentExamBucket = (typeof STUDENT_EXAM_BUCKETS)[number];

export const STUDENT_EXAM_BUCKET_LABELS: Record<StudentExamBucket, string> = {
  upcoming: "Scheduled",
  available: "Open now",
  completed: "Availability ended",
};

export function studentExamBucket(
  input: {
    status: ExamStatus;
    startsAt: string | null;
    endsAt: string | null;
    now?: Date;
  },
): StudentExamBucket | null {
  if (input.status === "closed") return "completed";
  if (input.status !== "published") return null;
  const phase = examWindowPhase(input.startsAt, input.endsAt, input.now ?? new Date());
  return phase === "open" ? "available" : phase === "upcoming" ? "upcoming" : "completed";
}

// --- Student eligibility & the start gate (prompt 21) ---------------------------

/**
 * The one availability state a student-facing screen renders. Like the
 * display states above it is NOT a second status enum — it is the stored
 * lifecycle plus the window plus the attempt budget, judged by pure rules
 * the list, the instructions screen, and (from prompt 23) the attempt-start
 * endpoint all share, so listing, copy, and enforcement can never drift.
 */
export const STUDENT_EXAM_AVAILABILITY_STATES = [
  "unavailable",
  "scheduled",
  "open",
  "expired",
  "attempts_exhausted",
] as const;
export type StudentExamAvailabilityState =
  (typeof STUDENT_EXAM_AVAILABILITY_STATES)[number];

/** Facts the data layer supplies — all server-read, none client-trusted. */
export type StudentExamEligibilityInput = {
  status: ExamStatus;
  /** Active direct or class-roster assignment (prompt 19's audience). */
  assignmentActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  /** The student's attempts so far. 0 until the attempt store ships
     (prompt 23) — the delivery layer supplies the real count from then on. */
  attemptsUsed: number;
  /** The exam's frozen per-student attempt limit. */
  maxAttempts: number;
  now?: Date;
};

export type StudentExamEligibility = {
  state: StudentExamAvailabilityState;
  /** Only meaningful in the `open` state; never negative. */
  attemptsRemaining: number;
};

export function studentExamEligibility(
  input: StudentExamEligibilityInput,
): StudentExamEligibility {
  const used = Number.isFinite(input.attemptsUsed)
    ? Math.max(0, Math.floor(input.attemptsUsed))
    : 0;
  const exhausted = {
    state: "attempts_exhausted" as const,
    attemptsRemaining: 0,
  };

  // A revoked or missing assignment, or an exam not yet released, keeps the
  // student out regardless of the clock — the list only ever shows
  // published/closed exams, and anything else fails closed here too.
  if (!input.assignmentActive || (input.status !== "published" && input.status !== "closed")) {
    return { state: "unavailable", attemptsRemaining: 0 };
  }

  // A closed exam accepts no further attempts (AGENTS.md §6) — it stays in
  // the student's history but is never startable, whatever its window says.
  if (input.status === "closed") {
    return { state: "expired", attemptsRemaining: 0 };
  }

  const phase = examWindowPhase(input.startsAt, input.endsAt, input.now ?? new Date());
  if (phase === "upcoming") return { state: "scheduled", attemptsRemaining: 0 };
  if (phase === "expired") return { state: "expired", attemptsRemaining: 0 };

  // Open window: the budget decides. maxAttempts is DB-bounded 1–10, but
  // clamp defensively so a bogus value can never open a start.
  const limit = Number.isFinite(input.maxAttempts)
    ? Math.max(0, Math.floor(input.maxAttempts))
    : 0;
  if (used >= limit) return exhausted;
  return { state: "open", attemptsRemaining: limit - used };
}

/**
 * The server-side start check (prompt 21: "check eligibility and attempt
 * limits on the server when starting; the screen is not the security
 * boundary"). Returns `{ allowed: true }` when the start may proceed, or
 * `{ allowed: false, message }` with the honest refusal to render. The
 * instructions page's button and — from prompt 23 — the attempt-creation
 * endpoint both call this, so what a student is shown and what the server
 * would actually allow are one rule.
 */
export function studentExamStartGate(
  input: StudentExamEligibilityInput,
): { allowed: true } | { allowed: false; message: string } {
  if (!input.assignmentActive) {
    return {
      allowed: false,
      message: "This exam is not assigned to you, so it cannot be started.",
    };
  }
  const eligibility = studentExamEligibility(input);
  switch (eligibility.state) {
    case "open":
      return { allowed: true };
    case "scheduled":
      return {
        allowed: false,
        message: "This exam has not opened yet — it becomes available at its start time.",
      };
    case "expired":
      return {
        allowed: false,
        message: "This exam's availability window has ended, so it can no longer be started.",
      };
    case "attempts_exhausted":
      return {
        allowed: false,
        message:
          "You have used all the attempts allowed for this exam. Your submitted work and results stay available for review.",
      };
    case "unavailable":
      return {
        allowed: false,
        message: "This exam is not currently available to you.",
      };
  }
}

/**
 * What the explicit start action says while exam delivery (prompts 22–23)
 * is still being prepared. Kept in the pure layer so the instructions
 * screen, the server action, and their tests quote one source.
 */
export const EXAM_START_INTERFACE_UNAVAILABLE_MESSAGE =
  "You meet every requirement to start, but the examination interface is still being prepared — it will appear here once exam delivery is live.";

// --- Builder edit safety (prompt 18) ---------------------------------------------

/**
 * Whether the exam's QUESTION SET may still change. Selecting, reordering or
 * re-marking questions only edits the live `exam_questions` rows; once the
 * exam publishes those rows are copied into immutable snapshots, and any
 * later edit would desync the exam from what students actually sat. The
 * data layer refuses builder writes outside these statuses.
 */
export function examBuilderEditable(status: ExamStatus): boolean {
  return status === "draft" || status === "scheduled";
}

// --- Field limits ----------------------------------------------------------------
// Mirror the database CHECKs in 0010_exams.sql and 0011_exam_builder.sql
// exactly, so a payload that passes here can never be rejected by the row
// constraints.

export const EXAM_TITLE_MAX_LENGTH = 160;
export const EXAM_DESCRIPTION_MAX_LENGTH = 2000;
export const EXAM_DURATION_MIN = 1;
export const EXAM_DURATION_MAX = 480;
export const EXAM_MAX_ATTEMPTS_MIN = 1;
export const EXAM_MAX_ATTEMPTS_MAX = 10;
// exam_questions.marks / exam_question_snapshots.marks CHECK (0010/0011).
export const EXAM_QUESTION_MARKS_MIN = 1;
export const EXAM_QUESTION_MARKS_MAX = 50;

// --- Result release (0011) --------------------------------------------------------
// When students may see their result. `immediate` releases right after
// submission; `after_window` waits for the availability window to end (the
// default — answer keys must not leak while the window is still open);
// `manual` waits for an explicit teacher/admin release (prompt 19+ surface).

export const EXAM_RESULTS_RELEASES = [
  "immediate",
  "after_window",
  "manual",
] as const;
export type ExamResultsRelease = (typeof EXAM_RESULTS_RELEASES)[number];

export const EXAM_RESULTS_RELEASE_LABELS: Record<ExamResultsRelease, string> = {
  immediate: "Immediately after submission",
  after_window: "After the availability window ends",
  manual: "Manually, when I release results",
};

export const EXAM_RESULTS_RELEASE_HINTS: Record<ExamResultsRelease, string> = {
  immediate:
    "Students see their result as soon as they submit. Only appropriate once the window is effectively over for everyone.",
  after_window:
    "Results become visible after the availability window ends, so students still mid-window cannot compare answers. Recommended default.",
  manual:
    "Results stay hidden until an institution manager releases them explicitly.",
};

export function isExamResultsRelease(value: unknown): value is ExamResultsRelease {
  return typeof value === "string" &&
    (EXAM_RESULTS_RELEASES as readonly string[]).includes(value);
}

// --- Exam input --------------------------------------------------------------------

export type ExamInput = {
  title: string;
  description: string;
  subjectId: string;
  /** Platform exam category id; "" means unclassified. */
  categoryId: string;
  /** Whole minutes a student gets, 1–480. */
  durationMinutes: number;
  /** ISO datetime-local strings; "" means unset. */
  startsAt: string;
  endsAt: string;
  /** How many attempts a student may make, 1–10. */
  maxAttempts: number;
  /** Delivery-time randomisation flags (prompts 22–23 honour these). */
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  resultsRelease: ExamResultsRelease;
};

export type ExamField = keyof ExamInput;

export type ExamErrors = Partial<Record<ExamField, string>>;

export const EXAM_INPUT_EMPTY: ExamInput = {
  title: "",
  description: "",
  subjectId: "",
  categoryId: "",
  durationMinutes: 60,
  startsAt: "",
  endsAt: "",
  maxAttempts: 1,
  shuffleQuestions: false,
  shuffleOptions: false,
  resultsRelease: "after_window",
};

/**
 * Parse a datetime form value to epoch ms. `null` means "unset" (empty
 * input); `NaN` means "present but not a real date" — callers report that as
 * a field error rather than silently dropping it.
 */
export function parseExamDate(value: string): number | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  return new Date(trimmed).getTime();
}

/**
 * Validate an exam payload → field → message map. Structural rules only:
 * subject visibility and tenancy are re-checked against the database in
 * lib/data/exams.ts — this function has no data access.
 */
export function validateExam(input: ExamInput): ExamErrors {
  const errors: ExamErrors = {};

  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) {
    errors.title = "Enter an exam title.";
  } else if (title.length > EXAM_TITLE_MAX_LENGTH) {
    errors.title = `Keep the title under ${EXAM_TITLE_MAX_LENGTH} characters.`;
  }

  if (typeof input.description !== "string") {
    errors.description = "Description must be plain text.";
  } else if (input.description.trim().length > EXAM_DESCRIPTION_MAX_LENGTH) {
    errors.description = `Keep the description under ${EXAM_DESCRIPTION_MAX_LENGTH} characters.`;
  }

  if (typeof input.subjectId !== "string" || !input.subjectId.trim()) {
    errors.subjectId = "Choose a subject.";
  }

  if (
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes < EXAM_DURATION_MIN ||
    input.durationMinutes > EXAM_DURATION_MAX
  ) {
    errors.durationMinutes =
      `Duration must be a whole number of minutes from ${EXAM_DURATION_MIN} to ${EXAM_DURATION_MAX}.`;
  }

  if (typeof input.categoryId !== "string") {
    errors.categoryId = "Category must be a single choice.";
  }

  if (
    !Number.isInteger(input.maxAttempts) ||
    input.maxAttempts < EXAM_MAX_ATTEMPTS_MIN ||
    input.maxAttempts > EXAM_MAX_ATTEMPTS_MAX
  ) {
    errors.maxAttempts =
      `Attempt limit must be a whole number from ${EXAM_MAX_ATTEMPTS_MIN} to ${EXAM_MAX_ATTEMPTS_MAX}.`;
  }

  if (!isExamResultsRelease(input.resultsRelease)) {
    errors.resultsRelease = "Choose a supported result-release option.";
  }

  if (
    typeof input.shuffleQuestions !== "boolean" ||
    typeof input.shuffleOptions !== "boolean"
  ) {
    errors.shuffleQuestions = "Randomisation settings must be on or off.";
  }

  const startsRaw = typeof input.startsAt === "string" ? input.startsAt.trim() : "";
  const endsRaw = typeof input.endsAt === "string" ? input.endsAt.trim() : "";

  const starts = parseExamDate(startsRaw);
  const ends = parseExamDate(endsRaw);

  if (startsRaw && starts !== null && Number.isNaN(starts)) {
    errors.startsAt = "Start date and time must be a real date.";
  }
  if (endsRaw && ends !== null && Number.isNaN(ends)) {
    errors.endsAt = "End date and time must be a real date.";
  }
  if (
    !errors.startsAt &&
    !errors.endsAt &&
    starts !== null &&
    ends !== null &&
    ends <= starts
  ) {
    errors.endsAt = "The end of the window must be after it starts.";
  }
  if (
    (startsRaw && !endsRaw && ends === null) ||
    (endsRaw && !startsRaw && starts === null)
  ) {
    const missing = startsRaw ? "endsAt" : "startsAt";
    errors[missing] = "Set both a start and an end, or leave the exam unscheduled.";
  }

  return errors;
}

/** Trimmed, normalised form used before persisting. */
export function normalizeExamInput(input: ExamInput): ExamInput {
  return {
    title: input.title.trim(),
    description: input.description.trim(),
    subjectId: input.subjectId.trim(),
    categoryId: input.categoryId.trim(),
    durationMinutes: input.durationMinutes,
    startsAt: input.startsAt.trim(),
    endsAt: input.endsAt.trim(),
    maxAttempts: input.maxAttempts,
    shuffleQuestions: input.shuffleQuestions,
    shuffleOptions: input.shuffleOptions,
    resultsRelease: input.resultsRelease,
  };
}

// --- Builder arithmetic (prompt 18) ---------------------------------------------

/** Sum of per-question marks; ignores anything not a finite number so a
 *  half-loaded row set can never render a bogus total. */
export function examTotalMarks(marks: readonly number[]): number {
  return marks
    .filter((mark) => Number.isFinite(mark))
    .reduce((sum, mark) => sum + mark, 0);
}

/** Marks bounds for one selected question, mirroring the DB CHECK. */
export function examQuestionMarksError(marks: unknown): string | null {
  if (!Number.isInteger(marks)) {
    return "Marks must be a whole number.";
  }
  if ((marks as number) < EXAM_QUESTION_MARKS_MIN || (marks as number) > EXAM_QUESTION_MARKS_MAX) {
    return `Marks must be from ${EXAM_QUESTION_MARKS_MIN} to ${EXAM_QUESTION_MARKS_MAX}.`;
  }
  return null;
}

/**
 * Pre-publish warnings for the builder summary (prompt 18: "show question
 * count, marks total, duration, and validation warnings before
 * publishing"). Advisories, not authorization — the server-side publish
 * gate (`examPublishBlocker` + the data layer) stays authoritative.
 */
export function examBuilderWarnings(input: {
  questionCount: number;
  totalMarks: number;
  scheduled: boolean;
}): string[] {
  const warnings: string[] = [];
  if (input.questionCount < 1) {
    warnings.push("No questions selected yet — add at least one from the question bank before publishing.");
  }
  if (input.questionCount > 0 && input.totalMarks < 1) {
    warnings.push("The selected questions add up to 0 marks — check the per-question marks.");
  }
  if (!input.scheduled) {
    warnings.push("No availability window is set — students have no defined time to take this exam.");
  }
  return warnings;
}

// --- List query resolution (search / filter / pagination) ---------------------------

export const EXAM_PAGE_SIZE = 10;

/**
 * Filters + pagination for the exam list. `status` `null` means "all".
 * Values arrive from searchParams, which is untrusted input, so everything
 * is clamped here — same contract as resolveQuestionListQuery.
 */
export type ExamListQuery = {
  q: string;
  subjectId: string;
  status: ExamStatus | null;
  page: number;
  pageSize: number;
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function safePage(raw: string | string[] | undefined): number {
  const parsed = Number.parseInt(firstValue(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function safeStatus(raw: string | string[] | undefined): ExamStatus | null {
  const value = firstValue(raw);
  return isExamStatus(value) ? value : null;
}

/** Turn raw searchParams into a safe, bounded exam-list query. */
export function resolveExamListQuery(searchParams: {
  q?: string | string[];
  subject?: string | string[];
  status?: string | string[];
  page?: string | string[];
}): ExamListQuery {
  return {
    q: firstValue(searchParams.q).trim().slice(0, 120),
    subjectId: firstValue(searchParams.subject).trim().slice(0, 64),
    status: safeStatus(searchParams.status),
    page: safePage(searchParams.page),
    pageSize: EXAM_PAGE_SIZE,
  };
}

/** Build an exam-list URL for a page, preserving current filters. */
export function examPageHref(
  base: string,
  query: ExamListQuery,
  page: number,
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.subjectId) params.set("subject", query.subjectId);
  if (query.status) params.set("status", query.status);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Format a duration in minutes for display ("1 h 30 min", "45 min"). */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return "—";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} hr`;
  return `${hours} hr ${rest} min`;
}

/**
 * ISO timestamp → the `datetime-local` input value in the server's local
 * zone ("YYYY-MM-DDTHH:mm"). "" for unset/invalid, so an empty field always
 * means "no window part set" rather than a silently wrong date.
 */
export function toDatetimeLocalValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export { orgTotalPages, toOrgContainsPattern };
