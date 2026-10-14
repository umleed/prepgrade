/**
 * Question bank contract and validation — pure, dependency-free, unit-testable.
 *
 * The exact same rules run in the browser (instant feedback) and on the server
 * (authoritative). Client validation is convenience only; the server ALWAYS
 * re-validates and re-checks tenancy (AGENTS.md §5, §7). No new packages.
 *
 * WHAT THIS AREA IS FOR (prompt 15)
 * Questions are the atomic unit of every assessment: teachers author/collect
 * them here, exams (prompts 17–19) select them, and the grading engine
 * (prompt 24) scores against them. The MVP supports ONE type — single-answer
 * multiple choice — and this module refuses anything else, so the product
 * never claims support for types it cannot grade.
 *
 * ANSWER-KEY INTEGRITY (AGENTS.md §6)
 * `correctOptionIndex` is a 0-based index into `options`. Validation here
 * guarantees the index always maps to an existing option; the value itself is
 * privileged and never leaves the server except to `question.manage` roles.
 *
 * ARCHIVE, NEVER DELETE (AGENTS.md §6)
 * Exams and results (prompts 17–25) will reference `questions.id`, so the only
 * removal offered is `archived`: retired questions disappear from pickers and
 * default listings but keep resolving historically. Identifiers are stable.
 *
 * Subject/topic/category EXISTENCE and tenant visibility are NOT validated
 * here — they need the database and the caller's trusted institution, so they
 * live in lib/data/questions.ts.
 */

import {
  ORG_STATUS_HINTS,
  ORG_STATUS_LABELS,
  orgTotalPages,
  toOrgContainsPattern,
  type OrgStatus,
} from "./classes.ts";

// Reuse the shared lifecycle vocabulary (active ⇄ archived) so every
// directory in the product behaves identically.
export const QUESTION_STATUSES = ["active", "archived"] as const;
export type QuestionStatus = OrgStatus;

export const QUESTION_STATUS_LABELS = ORG_STATUS_LABELS;
export const QUESTION_STATUS_HINTS = ORG_STATUS_HINTS;

// --- Question type ------------------------------------------------------------

/** The only type the MVP authors and grades: one correct choice, auto-scorable. */
export const QUESTION_TYPES = ["mcq_single"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  mcq_single: "Multiple choice",
};

/** Runtime guard for type strings arriving from any external source. */
export function isQuestionType(value: unknown): value is QuestionType {
  return typeof value === "string" &&
    (QUESTION_TYPES as readonly string[]).includes(value);
}

// --- Difficulty -----------------------------------------------------------------

export const QUESTION_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type QuestionDifficulty = (typeof QUESTION_DIFFICULTIES)[number];

export const QUESTION_DIFFICULTY_LABELS: Record<QuestionDifficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export function isQuestionDifficulty(value: unknown): value is QuestionDifficulty {
  return typeof value === "string" &&
    (QUESTION_DIFFICULTIES as readonly string[]).includes(value);
}

// --- Provenance / licensing (AGENTS.md §7) ---------------------------------------

export const QUESTION_PROVENANCES = ["teacher_created", "licensed"] as const;
export type QuestionProvenance = (typeof QUESTION_PROVENANCES)[number];

export const QUESTION_PROVENANCE_LABELS: Record<QuestionProvenance, string> = {
  teacher_created: "Created by your institution",
  licensed: "Licensed / permitted source",
};

export function isQuestionProvenance(value: unknown): value is QuestionProvenance {
  return typeof value === "string" &&
    (QUESTION_PROVENANCES as readonly string[]).includes(value);
}

// --- Field limits ------------------------------------------------------------------
// Mirror the database CHECKs in 0006_questions.sql exactly, so a payload that
// passes here can never be rejected by the row constraints.

export const QUESTION_TEXT_MAX_LENGTH = 5000;
export const OPTION_MIN_COUNT = 2;
export const OPTION_MAX_COUNT = 8;
export const OPTION_TEXT_MAX_LENGTH = 500;
export const EXPLANATION_MAX_LENGTH = 5000;
export const MARKS_MIN = 1;
export const MARKS_MAX = 50;
export const LEARNING_OBJECTIVE_MAX_LENGTH = 300;
export const SOURCE_LABEL_MAX_LENGTH = 120;
export const SOURCE_YEAR_MIN = 1900;
export const SOURCE_YEAR_MAX = 2100;
export const LICENSE_NOTES_MAX_LENGTH = 500;

/** Letter labels for options (A, B, C…) shown in forms and previews. */
export function optionLabel(index: number): string {
  return String.fromCharCode(65 + index); // 0 → "A"
}

// --- Question input --------------------------------------------------------------

export type QuestionInput = {
  questionText: string;
  subjectId: string;
  /** Topic OR subtopic id, or "" for "subject only". */
  topicId: string;
  /** Platform exam category id, or "" for "inherit from subject". */
  categoryId: string;
  questionType: QuestionType;
  difficulty: QuestionDifficulty;
  /** Option texts, in order; the answer key is an index into this array. */
  options: string[];
  correctOptionIndex: number;
  explanation: string;
  marks: number;
  learningObjective: string;
  provenance: QuestionProvenance;
  sourceLabel: string;
  /** Free-text year input; "" means unset. Parsed by normalize. */
  sourceYear: string;
  licenseNotes: string;
};

export type QuestionField = keyof QuestionInput;

export type QuestionErrors = Partial<Record<QuestionField, string>>;

export const QUESTION_INPUT_EMPTY: QuestionInput = {
  questionText: "",
  subjectId: "",
  topicId: "",
  categoryId: "",
  questionType: "mcq_single",
  difficulty: "medium",
  options: ["", "", "", ""],
  correctOptionIndex: 0,
  explanation: "",
  marks: 1,
  learningObjective: "",
  provenance: "teacher_created",
  sourceLabel: "",
  sourceYear: "",
  licenseNotes: "",
};

/**
 * Validate a question payload → field → message map. Structural rules only:
 * subject/topic/category visibility and tenancy are re-checked against the
 * database in lib/data/questions.ts — this function has no data access.
 */
export function validateQuestion(input: QuestionInput): QuestionErrors {
  const errors: QuestionErrors = {};

  const text = typeof input.questionText === "string" ? input.questionText.trim() : "";
  if (!text) {
    errors.questionText = "Enter the question text.";
  } else if (text.length > QUESTION_TEXT_MAX_LENGTH) {
    errors.questionText = `Keep the question under ${QUESTION_TEXT_MAX_LENGTH} characters.`;
  }

  if (typeof input.subjectId !== "string" || !input.subjectId.trim()) {
    errors.subjectId = "Choose a subject.";
  }
  if (typeof input.topicId !== "string") {
    errors.topicId = "Choose a topic, or none.";
  }
  if (typeof input.categoryId !== "string") {
    errors.categoryId = "Choose an exam category, or none.";
  }

  if (!isQuestionType(input.questionType)) {
    errors.questionType = "Only single-answer multiple choice is supported right now.";
  }
  if (!isQuestionDifficulty(input.difficulty)) {
    errors.difficulty = "Choose Easy, Medium, or Hard.";
  }

  if (!Array.isArray(input.options)) {
    errors.options = `Provide ${OPTION_MIN_COUNT}–${OPTION_MAX_COUNT} answer options.`;
  } else {
    if (input.options.length < OPTION_MIN_COUNT) {
      errors.options = `Add at least ${OPTION_MIN_COUNT} options.`;
    } else if (input.options.length > OPTION_MAX_COUNT) {
      errors.options = `Keep the options to ${OPTION_MAX_COUNT} at most.`;
    } else if (input.options.some((option) => typeof option !== "string" || !option.trim())) {
      errors.options = "Every option needs text — remove blanks or fill them in.";
    } else if (input.options.some((option) => option.trim().length > OPTION_TEXT_MAX_LENGTH)) {
      errors.options = `Keep each option under ${OPTION_TEXT_MAX_LENGTH} characters.`;
    } else {
      const seen = new Set(input.options.map((option) => option.trim().toLowerCase()));
      if (seen.size !== input.options.length) {
        errors.options = "Options must be different from each other.";
      }
    }
  }

  // The answer key must map to an existing option — checked even when the
  // options themselves are invalid, so both problems surface together.
  if (
    !Number.isInteger(input.correctOptionIndex) ||
    input.correctOptionIndex < 0 ||
    (Array.isArray(input.options) && input.correctOptionIndex >= input.options.length)
  ) {
    errors.correctOptionIndex = "Mark which option is the correct answer.";
  }

  if (typeof input.explanation !== "string") {
    errors.explanation = "Explanation must be plain text.";
  } else if (input.explanation.trim().length > EXPLANATION_MAX_LENGTH) {
    errors.explanation = `Keep the explanation under ${EXPLANATION_MAX_LENGTH} characters.`;
  }

  if (
    !Number.isInteger(input.marks) ||
    input.marks < MARKS_MIN ||
    input.marks > MARKS_MAX
  ) {
    errors.marks = `Marks must be a whole number from ${MARKS_MIN} to ${MARKS_MAX}.`;
  }

  if (typeof input.learningObjective !== "string") {
    errors.learningObjective = "Learning objective must be plain text.";
  } else if (input.learningObjective.trim().length > LEARNING_OBJECTIVE_MAX_LENGTH) {
    errors.learningObjective =
      `Keep the learning objective under ${LEARNING_OBJECTIVE_MAX_LENGTH} characters.`;
  }

  if (!isQuestionProvenance(input.provenance)) {
    errors.provenance = "Choose where this question came from.";
  }

  if (typeof input.sourceLabel !== "string") {
    errors.sourceLabel = "Source must be plain text.";
  } else if (input.sourceLabel.trim().length > SOURCE_LABEL_MAX_LENGTH) {
    errors.sourceLabel = `Keep the source under ${SOURCE_LABEL_MAX_LENGTH} characters.`;
  }

  if (typeof input.sourceYear !== "string") {
    errors.sourceYear = "Year must be a number like 2019.";
  } else if (input.sourceYear.trim()) {
    const year = Number.parseInt(input.sourceYear.trim(), 10);
    if (
      !Number.isFinite(year) ||
      String(year) !== input.sourceYear.trim() ||
      year < SOURCE_YEAR_MIN ||
      year > SOURCE_YEAR_MAX
    ) {
      errors.sourceYear = `Year must be between ${SOURCE_YEAR_MIN} and ${SOURCE_YEAR_MAX}.`;
    }
  }

  if (typeof input.licenseNotes !== "string") {
    errors.licenseNotes = "License notes must be plain text.";
  } else if (input.licenseNotes.trim().length > LICENSE_NOTES_MAX_LENGTH) {
    errors.licenseNotes = `Keep the license notes under ${LICENSE_NOTES_MAX_LENGTH} characters.`;
  }

  return errors;
}

/** Trimmed, normalised form used before persisting. */
export function normalizeQuestionInput(input: QuestionInput): QuestionInput {
  const year = input.sourceYear.trim();
  return {
    ...input,
    questionText: input.questionText.trim(),
    subjectId: input.subjectId.trim(),
    topicId: input.topicId.trim(),
    categoryId: input.categoryId.trim(),
    options: input.options.map((option) => option.trim()),
    explanation: input.explanation.trim(),
    learningObjective: input.learningObjective.trim(),
    sourceLabel: input.sourceLabel.trim(),
    sourceYear: year,
    licenseNotes: input.licenseNotes.trim(),
  };
}

// --- Edit safety (prompt 16) ------------------------------------------------

/**
 * The fields that decide what a student sees during an exam and how the
 * answer is scored. Editing anything else (explanation, provenance, source,
 * learning objective, organisation links) never changes the meaning of an
 * existing question, so it does not need a historical snapshot.
 */
export type QuestionMeaningFields = {
  questionText: string;
  questionType: string;
  options: string[];
  correctOptionIndex: number;
  marks: number;
};

/**
 * Whether an edit would change the MEANING of a question — the prompt, the
 * options, which option is correct, how many marks it carries, or the type
 * that gets graded. The data layer archives the pre-edit content as a
 * version snapshot only when this returns true, so routine metadata fixes
 * don't clutter the history while any edit that could shift results is
 * always recoverable (AGENTS.md §6 — later edits never rewrite history).
 * Comparison is on trimmed values, matching what gets stored.
 */
export function questionMeaningChanged(
  current: QuestionMeaningFields,
  next: QuestionInput,
): boolean {
  if (current.questionText.trim() !== next.questionText.trim()) return true;
  if (current.questionType !== next.questionType) return true;
  if (current.correctOptionIndex !== next.correctOptionIndex) return true;
  if (current.marks !== next.marks) return true;

  const nextOptions = next.options.map((option) => option.trim());
  if (nextOptions.length !== current.options.length) return true;
  return nextOptions.some(
    (option, index) => option !== current.options[index].trim(),
  );
}

// --- List query resolution (search / filter / pagination) --------------------------

export const QUESTION_PAGE_SIZE = 10;

/**
 * Filters + pagination for the question bank. `difficulty`/`status` `null`
 * mean "all". Values arrive from searchParams, which is untrusted input, so
 * everything is clamped here — same contract as resolveSubjectListQuery.
 */
export type QuestionListQuery = {
  q: string;
  subjectId: string;
  topicId: string;
  difficulty: QuestionDifficulty | null;
  status: QuestionStatus | null;
  /** "My questions" facet — resolved against the caller's own user id. */
  mine: boolean;
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

function safeDifficulty(raw: string | string[] | undefined): QuestionDifficulty | null {
  const value = firstValue(raw);
  return isQuestionDifficulty(value) ? value : null;
}

function safeStatus(raw: string | string[] | undefined): QuestionStatus | null {
  const value = firstValue(raw);
  return (QUESTION_STATUSES as readonly string[]).includes(value)
    ? (value as QuestionStatus)
    : null;
}

/** Turn raw searchParams into a safe, bounded bank query. */
export function resolveQuestionListQuery(searchParams: {
  q?: string | string[];
  subject?: string | string[];
  topic?: string | string[];
  difficulty?: string | string[];
  status?: string | string[];
  mine?: string | string[];
  page?: string | string[];
}): QuestionListQuery {
  return {
    q: firstValue(searchParams.q).trim().slice(0, 120),
    subjectId: firstValue(searchParams.subject).trim().slice(0, 64),
    topicId: firstValue(searchParams.topic).trim().slice(0, 64),
    difficulty: safeDifficulty(searchParams.difficulty),
    status: safeStatus(searchParams.status),
    mine: ["1", "on", "true"].includes(firstValue(searchParams.mine).toLowerCase()),
    page: safePage(searchParams.page),
    pageSize: QUESTION_PAGE_SIZE,
  };
}

/** Build a bank URL for a page, preserving current filters. */
export function questionPageHref(
  base: string,
  query: QuestionListQuery,
  page: number,
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.subjectId) params.set("subject", query.subjectId);
  if (query.topicId) params.set("topic", query.topicId);
  if (query.difficulty) params.set("difficulty", query.difficulty);
  if (query.status) params.set("status", query.status);
  if (query.mine) params.set("mine", "1");
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export { orgTotalPages, toOrgContainsPattern };

