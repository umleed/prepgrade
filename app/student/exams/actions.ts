"use server";

import { requireRole } from "@/lib/auth/guards";
import { getStudentByProfileId } from "@/lib/data/students";
import { getStudentExamView } from "@/lib/data/exams";
import {
  EXAM_START_INTERFACE_UNAVAILABLE_MESSAGE,
  studentExamStartGate,
} from "@/lib/exams";
import { DataSourceUnavailableError } from "@/lib/supabase/server";

/**
 * The explicit start action (prompt 21). The instructions screen's button
 * calls this BEFORE anything else happens, so the eligibility and
 * attempt-limit checks run server-side against trusted data — the rendered
 * screen is convenience, never the security boundary (AGENTS.md §5).
 *
 * What is verified, in order, all from the session:
 *  1. the caller's role is STUDENT with a trusted tenant membership;
 *  2. the session resolves to their OWN live roster row — the exam id in the
 *     payload is never paired with a client-supplied student id;
 *  3. the exam is in that student's visible set (active direct or
 *     class-roster assignment, published, own institution) via the same
 *     server read the list uses — a foreign or unassigned id fails closed
 *     without confirming existence anywhere;
 *  4. the pure start gate (`studentExamStartGate`) judges window and
 *     attempt budget — from prompt 23 the real attempt count replaces the
 *     stored zero, and this same call becomes the delivery layer's gate.
 *
 * When every check passes, the honest answer today is that the CBT
 * interface itself (prompts 22–23) has not shipped, so no attempt is
 * created and no redirect to a nonexistent exam happens. Nothing here
 * fabricates delivery.
 */
export type ExamStartActionResult =
  | { ok: true }
  | { ok: false; message: string };

export async function startExamAction(
  examId: string,
): Promise<ExamStartActionResult> {
  const principal = await requireRole(["STUDENT"], { next: "/student/exams" });
  const institutionId = principal.institutionId as string;

  if (typeof examId !== "string" || examId.trim().length === 0) {
    return { ok: false, message: "No exam was selected to start." };
  }

  let view: Awaited<ReturnType<typeof getStudentExamView>> = null;
  try {
    // Identity first: session → own roster row, then the exam under THAT
    // student. A data-source failure is reported, never guessed past.
    const student = await getStudentByProfileId(institutionId, principal.userId);
    if (!student) {
      return {
        ok: false,
        message:
          "Your account isn't linked to a student record yet, so no exam can be started. Ask your institution admin to connect it.",
      };
    }
    view = await getStudentExamView(
      institutionId,
      student.id,
      student.classId,
      examId.trim(),
    );
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof DataSourceUnavailableError
          ? "The exam service is not configured on this server, so the exam cannot be verified. Please try again shortly."
          : "We couldn't verify this exam right now — nothing was started. Please reload and try again.",
    };
  }

  if (!view) {
    return {
      ok: false,
      message:
        "This exam is not assigned to you, so it cannot be started. We never confirm whether an exam exists in another institution.",
    };
  }

  const gate = studentExamStartGate({
    status: view.exam.status,
    assignmentActive: true, // presence in the student's visible set proves it
    startsAt: view.exam.startsAt,
    endsAt: view.exam.endsAt,
    attemptsUsed: view.attemptsUsed,
    maxAttempts: view.exam.maxAttempts,
  });
  if (!gate.allowed) {
    return { ok: false, message: gate.message };
  }

  // Eligible to start — but delivery (the CBT interface and the attempt
  // state machine) ships in prompts 22–23. Refuse honestly rather than
  // pretend an attempt began.
  return { ok: false, message: EXAM_START_INTERFACE_UNAVAILABLE_MESSAGE };
}
