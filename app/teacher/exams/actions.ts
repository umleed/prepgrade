"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";
import {
  isExamStatus,
  validateExam,
  type ExamErrors,
  type ExamInput,
  type ExamStatus,
} from "@/lib/exams";
import {
  addExamQuestion,
  createExam,
  moveExamQuestion,
  removeExamQuestion,
  setExamAudience,
  setExamQuestionMarks,
  setExamStatus,
  updateExam,
  type ExamBuilderResult,
} from "@/lib/data/exams";

/**
 * Result an exam mutation returns to the client form. `errors` are per-field
 * messages; `message` is a form-level note (record vanished, transition
 * refused). Nothing here trusts the browser: every action re-resolves the
 * tenant from the session and re-validates before touching data; the
 * institution id is never read from the payload (AGENTS.md §5).
 */
export type ExamActionResult =
  | { ok: true; id?: string }
  | { ok: false; errors: ExamErrors; message?: string };

/**
 * Both roles that hold `exam.manage`/`exam.publish` (TEACHER,
 * INSTITUTION_ADMIN) may work exams for their OWN institution; the data layer
 * does the tenant scoping. Students never pass this gate — their exam views
 * ship with delivery (prompts 20–21) behind assignment checks.
 */
async function requireExamManager() {
  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher/exams",
  });
  return {
    institutionId: principal.institutionId as string,
    userId: principal.userId,
    role: principal.role,
  };
}

function revalidateExamPaths(id?: string) {
  revalidatePath("/teacher/exams");
  if (id) revalidatePath(`/teacher/exams/${id}`);
}

/** Create an institution-owned exam (always starts as a draft). */
export async function createExamAction(
  input: ExamInput,
): Promise<ExamActionResult> {
  const { institutionId, userId } = await requireExamManager();

  const errors = validateExam(input);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const result = await createExam(institutionId, userId, input);
  if (!result.ok) {
    if (Object.keys(result.errors).length === 0) {
      return {
        ok: false,
        errors: {},
        message: "We couldn't save this exam. Please try again.",
      };
    }
    return { ok: false, errors: result.errors };
  }

  revalidateExamPaths(result.id);
  return { ok: true, id: result.id };
}

/**
 * Update an institution-owned exam's details, scoped to the caller's tenant.
 * The data layer additionally refuses any change the exam's current status
 * has locked — the lifecycle rule of prompt 17 (no silent edits under live
 * or historical attempts) is enforced server-side, not just in the form.
 */
export async function updateExamAction(
  id: string,
  input: ExamInput,
): Promise<ExamActionResult> {
  const { institutionId } = await requireExamManager();

  const errors = validateExam(input);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const result = await updateExam(institutionId, id, input);
  if (!result.ok) {
    // Empty field errors means the id did not resolve under this tenant
    // (absent or another institution's) — report it without confirming which.
    if (Object.keys(result.errors).length === 0) {
      return {
        ok: false,
        errors: {},
        message: "This exam could not be found in your institution.",
      };
    }
    return { ok: false, errors: result.errors };
  }

  revalidateExamPaths(id);
  return { ok: true, id };
}

/**
 * Perform a lifecycle transition (schedule marker, publish, close, archive).
 * The target status arrives from a button, so it is re-checked with the pure
 * guard before anything is written; the data layer then re-reads the CURRENT
 * row and applies the transition rules authoritatively (AGENTS.md §5: the
 * client never decides what a record may become). Publishing additionally
 * freezes the question set into immutable snapshots (prompt 18).
 */
export async function setExamStatusAction(
  id: string,
  nextStatus: ExamStatus,
): Promise<ExamActionResult> {
  const { institutionId, userId, role } = await requireExamManager();

  if (!isExamStatus(nextStatus)) {
    return { ok: false, errors: {}, message: "Unknown exam status." };
  }

  const result = await setExamStatus(institutionId, id, nextStatus, {
    userId,
    role,
  });
  if (!result.ok) {
    return {
      ok: false,
      errors: {},
      message:
        result.reason === "notFound"
          ? "This exam could not be found in your institution."
          : (result.message ??
            "We couldn't change this exam's status. Please try again."),
    };
  }

  revalidateExamPaths(id);
  return { ok: true, id };
}

// --- Exam builder actions (prompt 18) --------------------------------------------

/**
 * Question-set mutations for the builder. Ids for the EXAM and the QUESTION
 * both arrive from rendered server data (bound by the page), but every
 * mutation still re-resolves the tenant from the session and re-checks the
 * exam's status in the data layer — a crafted payload can neither touch
 * another institution's exam nor edit a published question set (AGENTS.md §5,
 * §6). Marks are validated against the DB bounds server-side, never trusted.
 */
export type ExamBuilderActionResult = { ok: true } | { ok: false; message: string };

function builderMessage(result: ExamBuilderResult): ExamBuilderActionResult {
  return result.ok ? { ok: true } : { ok: false, message: result.message };
}

/** Add a bank question to a draft/scheduled exam (bank default marks). */
export async function addExamQuestionAction(
  examId: string,
  questionId: string,
): Promise<ExamBuilderActionResult> {
  const { institutionId } = await requireExamManager();

  const result = await addExamQuestion(institutionId, examId, questionId);
  if (result.ok) revalidateExamPaths(examId);
  return builderMessage(result);
}

/** Set one selected question's per-exam marks (1–50, DB-checked). */
export async function setExamQuestionMarksAction(
  examId: string,
  questionId: string,
  marks: number,
): Promise<ExamBuilderActionResult> {
  const { institutionId } = await requireExamManager();

  const result = await setExamQuestionMarks(institutionId, examId, questionId, marks);
  if (result.ok) revalidateExamPaths(examId);
  return builderMessage(result);
}

/** Reorder one selected question next to its neighbour. */
export async function moveExamQuestionAction(
  examId: string,
  questionId: string,
  direction: "up" | "down",
): Promise<ExamBuilderActionResult> {
  const { institutionId } = await requireExamManager();

  if (direction !== "up" && direction !== "down") {
    return { ok: false, message: "Unknown move direction." };
  }
  const result = await moveExamQuestion(institutionId, examId, questionId, direction);
  if (result.ok) revalidateExamPaths(examId);
  return builderMessage(result);
}

/** De-select a question; remaining questions are renumbered server-side. */
export async function removeExamQuestionAction(
  examId: string,
  questionId: string,
): Promise<ExamBuilderActionResult> {
  const { institutionId } = await requireExamManager();

  const result = await removeExamQuestion(institutionId, examId, questionId);
  if (result.ok) revalidateExamPaths(examId);
  return builderMessage(result);
}

// --- Assignment audience (prompt 19) ------------------------------------------

export type ExamAudienceActionResult =
  | { ok: true; effectiveStudentCount: number }
  | { ok: false; message: string };

/**
 * Save an exam's assignment audience (classes + individual students) in
 * one confirmed write. Both id lists arrive from the picker, so they are
 * treated as fully untrusted: the data layer re-resolves the tenant from
 * the session, verifies every class/student is the caller's own and still
 * active, refuses writes once the exam is published, deduplicates, and
 * records the change in the audit trail with counts only. Publishing has
 * its own gate server-side (`setExamStatus` re-checks the audience) — a
 * crafted publish call without a saved audience still fails.
 */
export async function setExamAudienceAction(
  examId: string,
  classIds: string[],
  studentIds: string[],
): Promise<ExamAudienceActionResult> {
  const { institutionId, userId, role } = await requireExamManager();

  // Bound the payload before it reaches any query; the data layer still
  // validates every surviving id.
  const sanitize = (ids: unknown): string[] =>
    Array.isArray(ids)
      ? ids
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 500)
      : [];

  const result = await setExamAudience(
    institutionId,
    userId,
    role,
    examId,
    sanitize(classIds),
    sanitize(studentIds),
  );
  if (result.ok) revalidateExamPaths(examId);
  return result;
}
