"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";
import { validateQuestion, type QuestionErrors, type QuestionInput } from "@/lib/questions";
import {
  createQuestion,
  setQuestionStatus,
  updateQuestion,
} from "@/lib/data/questions";
import type { QuestionStatus } from "@/lib/questions";

/**
 * Result a question mutation returns to the client form. `errors` are
 * per-field messages; `message` is a form-level note (record vanished).
 * Nothing here trusts the browser: every action re-resolves the tenant AND
 * the authoring user from the session and re-validates before touching data;
 * neither id is ever read from the payload (AGENTS.md §5, prompt 16 notes).
 */
export type QuestionActionResult =
  | { ok: true; id?: string }
  | { ok: false; errors: QuestionErrors; message?: string };

/**
 * Both roles that hold `question.manage` (TEACHER, INSTITUTION_ADMIN) may
 * author and archive questions for their OWN institution; the data layer does
 * the tenant scoping. Students never pass this gate, so the answer key
 * rendered by these screens can never reach them.
 */
async function requireQuestionManager() {
  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher/questions",
  });
  return {
    institutionId: principal.institutionId as string,
    userId: principal.userId,
  };
}

function revalidateQuestionPaths(id?: string) {
  revalidatePath("/teacher/questions");
  if (id) revalidatePath(`/teacher/questions/${id}`);
}

/** Create an institution-owned question for the signed-in manager's tenant. */
export async function createQuestionAction(
  input: QuestionInput,
): Promise<QuestionActionResult> {
  const { institutionId, userId } = await requireQuestionManager();

  const errors = validateQuestion(input);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const result = await createQuestion(institutionId, userId, input);
  if (!result.ok) {
    if (Object.keys(result.errors).length === 0) {
      return {
        ok: false,
        errors: {},
        message: "We couldn't save this question. Please try again.",
      };
    }
    return { ok: false, errors: result.errors };
  }

  revalidateQuestionPaths(result.id);
  return { ok: true, id: result.id };
}

/** Update an institution-owned question, scoped to the caller's tenant. */
export async function updateQuestionAction(
  id: string,
  input: QuestionInput,
): Promise<QuestionActionResult> {
  const { institutionId, userId } = await requireQuestionManager();

  const errors = validateQuestion(input);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // `userId` is session-derived and records WHO made each archived version
  // snapshot — a client-supplied editor id is never read (prompt 16 notes).
  const result = await updateQuestion(institutionId, id, input, userId);
  if (!result.ok) {
    // Empty field errors means the id did not resolve under this tenant
    // (absent or another institution's) — report it without confirming which.
    if (Object.keys(result.errors).length === 0) {
      return {
        ok: false,
        errors: {},
        message: "This question could not be found in your institution's bank.",
      };
    }
    return { ok: false, errors: result.errors };
  }

  revalidateQuestionPaths(id);
  return { ok: true, id };
}

/**
 * Archive or restore an institution-owned question — the non-destructive
 * removal (AGENTS.md §6). Archived questions leave the default listing and
 * future pickers but keep resolving historically once exams reference them.
 */
export async function setQuestionStatusAction(
  id: string,
  status: QuestionStatus,
): Promise<QuestionActionResult> {
  const { institutionId } = await requireQuestionManager();

  const result = await setQuestionStatus(institutionId, id, status);
  if (!result.ok) {
    return {
      ok: false,
      errors: {},
      message: "This question could not be found in your institution's bank.",
    };
  }

  revalidateQuestionPaths(id);
  return { ok: true, id };
}
