"use server";

import { requireRole } from "@/lib/auth/guards";
import { getStudentByProfileId } from "@/lib/data/students";
import {
  getAttemptState,
  saveAttemptAnswer,
  startOrResumeAttempt,
  submitAttempt,
} from "@/lib/data/attempts";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import type { AttemptState } from "@/lib/attempts";

/**
 * The explicit start action (prompts 21 → 22). The instructions screen's
 * button calls this BEFORE anything else happens, so eligibility and the
 * attempt budget are judged server-side against trusted data — the rendered
 * screen is convenience, never the security boundary (AGENTS.md §5).
 *
 * What is verified, in order, all from the session:
 *  1. the caller's role is STUDENT with a trusted tenant membership;
 *  2. the session resolves to their OWN live roster row — the exam id in the
 *     payload is never paired with a client-supplied student id;
 *  3. the exam is in that student's visible set (active direct or class-roster
 *     assignment, published, own institution) via the same server read the
 *     list uses — a foreign or unassigned id fails closed without confirming
 *     existence anywhere;
 *  4. `startOrResumeAttempt` re-runs the SAME start gate against the REAL
 *     attempt count, then creates (or resumes) the attempt with a
 *     server-stamped deadline.
 *
 * On success it returns the attempt id so the button can navigate into the CBT
 * interface. It is idempotent: calling it again while an attempt is live
 * resumes that attempt rather than starting a second one.
 */
export type ExamStartActionResult =
  | { ok: true; attemptId: string }
  | { ok: false; message: string };

export async function startExamAction(
  examId: string,
): Promise<ExamStartActionResult> {
  const principal = await requireRole(["STUDENT"], { next: "/student/exams" });
  const institutionId = principal.institutionId as string;

  if (typeof examId !== "string" || examId.trim().length === 0) {
    return { ok: false, message: "No exam was selected to start." };
  }

  try {
    const student = await getStudentByProfileId(institutionId, principal.userId);
    if (!student) {
      return {
        ok: false,
        message:
          "Your account isn't linked to a student record yet, so no exam can be started. Ask your institution admin to connect it.",
      };
    }

    const result = await startOrResumeAttempt(
      institutionId,
      student.id,
      student.classId,
      examId.trim(),
    );
    if (result.ok) return { ok: true, attemptId: result.state.attemptId };
    return { ok: false, message: result.message };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof DataSourceUnavailableError
          ? "The exam service is not configured on this server, so the exam cannot be verified. Please try again shortly."
          : "We couldn't verify this exam right now — nothing was started. Please reload and try again.",
    };
  }
}

/**
 * Autosave one answer (prompt 22). The client sends only a display option
 * index (or null) and the review flag; the mapping to the frozen canonical
 * index, the option-count validation, the ownership check, and the
 * still-open-on-the-server-clock check all happen in the data layer. Returns a
 * short result the interface turns into a saving/saved/locked indicator. A
 * failure is reported honestly so the client can retry or stop trusting its
 * local state — it never silently drops an answer.
 */
export type AttemptSaveResult =
  | { ok: true }
  | { ok: false; locked: boolean; message: string };

export async function saveAttemptAnswerAction(
  attemptId: string,
  snapshotId: string,
  displayIndex: number | null,
  markedForReview: boolean,
): Promise<AttemptSaveResult> {
  const principal = await requireRole(["STUDENT"], { next: "/student/exams" });
  const institutionId = principal.institutionId as string;

  if (
    typeof attemptId !== "string" ||
    typeof snapshotId !== "string" ||
    (displayIndex !== null && !Number.isInteger(displayIndex)) ||
    typeof markedForReview !== "boolean"
  ) {
    return { ok: false, locked: false, message: "Malformed answer request." };
  }

  try {
    const student = await getStudentByProfileId(institutionId, principal.userId);
    if (!student) {
      return { ok: false, locked: true, message: "No student record is linked to your account." };
    }
    const result = await saveAttemptAnswer(
      institutionId,
      student.id,
      attemptId,
      snapshotId,
      displayIndex,
      markedForReview,
    );
    if (result.ok) return { ok: true };
    return {
      ok: false,
      locked: result.reason === "locked" || result.reason === "expired",
      message: result.message,
    };
  } catch (error) {
    return {
      ok: false,
      locked: false,
      message:
        error instanceof DataSourceUnavailableError
          ? "The exam service isn't reachable right now — your answer is held locally and will retry."
          : "We couldn't save that answer just now. It will retry.",
    };
  }
}

/**
 * Retrieve the CURRENT authoritative state of one attempt (prompt 23) — the
 * read the CBT interface calls when the tab regains focus or the connection
 * returns, so a student who submitted in another tab (or whose time ran out
 * server-side while the device slept) learns the truth immediately instead of
 * working in a stale UI until the next save happens to be refused.
 *
 * Same trust model as every other attempt action: role and tenant come from
 * the SESSION, the student id is resolved from it (never supplied), and the
 * data layer filters by both so a foreign attempt id resolves to `notFound`
 * without confirming it exists anywhere. A timed-out in-progress row is
 * settled to `expired` by the read itself — the stored deadline stays
 * authoritative even if the student never clicks submit (AGENTS.md §6).
 */
export type AttemptSyncActionResult =
  | { ok: true; state: AttemptState }
  | { ok: false; locked: boolean; message: string };

export async function syncAttemptStateAction(
  attemptId: string,
): Promise<AttemptSyncActionResult> {
  const principal = await requireRole(["STUDENT"], { next: "/student/exams" });
  const institutionId = principal.institutionId as string;

  if (typeof attemptId !== "string" || attemptId.trim().length === 0) {
    return { ok: false, locked: false, message: "No attempt was selected to sync." };
  }

  try {
    const student = await getStudentByProfileId(institutionId, principal.userId);
    if (!student) {
      return { ok: false, locked: true, message: "No student record is linked to your account." };
    }
    const state = await getAttemptState(institutionId, student.id, attemptId);
    if (!state) {
      return {
        ok: false,
        locked: true,
        message: "This attempt could not be found for your account.",
      };
    }
    return { ok: true, state };
  } catch (error) {
    return {
      ok: false,
      locked: false,
      message:
        error instanceof DataSourceUnavailableError
          ? "The exam service isn't reachable right now — nothing was changed."
          : "We couldn't reach the exam service to sync. Your answers are safe and held locally.",
    };
  }
}

/**
 * Submit an attempt (prompt 22). Idempotent server-side, so the review/
 * confirm step, a double-click, and the automatic submit-on-expiry can all
 * call this safely. On success the interface shows the submitted confirmation;
 * grading and result release are the server's concern (prompt 24), so nothing
 * here reveals a score.
 */
export type AttemptSubmitActionResult =
  | { ok: true; status: "submitted" | "expired" | "already" }
  | { ok: false; message: string };

export async function submitAttemptAction(
  attemptId: string,
): Promise<AttemptSubmitActionResult> {
  const principal = await requireRole(["STUDENT"], { next: "/student/exams" });
  const institutionId = principal.institutionId as string;

  if (typeof attemptId !== "string" || attemptId.trim().length === 0) {
    return { ok: false, message: "No attempt was selected to submit." };
  }

  try {
    const student = await getStudentByProfileId(institutionId, principal.userId);
    if (!student) {
      return { ok: false, message: "No student record is linked to your account." };
    }
    const result = await submitAttempt(institutionId, student.id, attemptId);
    if (result.ok) {
      const status = result.state?.status ?? "submitted";
      return {
        ok: true,
        status: status === "expired" ? "expired" : status === "submitted" ? "submitted" : "already",
      };
    }
    return { ok: false, message: result.message };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof DataSourceUnavailableError
          ? "The exam service isn't reachable right now — nothing was submitted. Check your connection and try again."
          : "We couldn't submit your exam just now. Please try again.",
    };
  }
}
