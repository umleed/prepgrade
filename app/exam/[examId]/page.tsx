import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getStudentByProfileId } from "@/lib/data/students";
import { startOrResumeAttempt } from "@/lib/data/attempts";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import type { AttemptState } from "@/lib/attempts";
import { Alert, Button } from "@/components/ui";
import { CbtExamInterface } from "@/components/student/cbt-exam-interface";

export const metadata: Metadata = {
  title: "Examination",
};

// Reads the live session and starts/resumes a server-authoritative attempt —
// never prerendered, never cached (AGENTS.md §5, §6). `instant = false` keeps
// it off the static shell; `await connection()` makes it resolve per request
// (the `dynamic` segment config is incompatible with Cache Components).
export const instant = false;

/**
 * The CBT delivery surface (prompt 22), mounted OUTSIDE the student sidebar so
 * the exam is a focused, full-screen experience.
 *
 * Opening this route calls `startOrResumeAttempt`, which is IDEMPOTENT: a
 * first visit creates the attempt with a server-stamped deadline; a refresh,
 * a reconnect, or a second tab resumes the SAME live attempt (the stored
 * `expiresAt` is never recomputed, so the timer cannot be reset). Access is
 * enforced here on the server before anything renders — the student's role,
 * their own roster row, and the exam being in their visible set are all
 * re-checked (the interface itself is never the boundary). An exam that isn't
 * the student's resolves to a plain not-found; a locked/unavailable one to an
 * honest message. No answer key or grading ever reaches this component.
 */
export default async function CbtExamPage({
  params,
}: {
  params: Promise<{ examId: string }>;
}) {
  await connection();

  const principal = await requireRole(["STUDENT"], { next: "/student/exams" });
  const institutionId = principal.institutionId as string;
  const { examId } = await params;

  // Resolve everything to a plain, JSX-free outcome first: React Compiler
  // forbids constructing elements inside try/catch, and it keeps the render
  // decision in one honest place at the bottom.
  type Outcome =
    | { kind: "ready"; state: AttemptState }
    | { kind: "gate"; title: string; body: string };

  let outcome: Outcome;

  try {
    const student = await getStudentByProfileId(institutionId, principal.userId);
    if (!student) {
      outcome = {
        kind: "gate",
        title: "Your account isn't linked to a student record yet",
        body: "Your institution must connect your account to its student roster before an exam can be opened.",
      };
    } else {
      const result = await startOrResumeAttempt(
        institutionId,
        student.id,
        student.classId,
        examId,
      );
      if (result.ok) {
        outcome = { kind: "ready", state: result.state };
      } else if (result.reason === "notFound") {
        notFound();
      } else {
        outcome = {
          kind: "gate",
          title: "This exam can't be opened right now",
          body: result.message,
        };
      }
    }
  } catch (error) {
    outcome = {
      kind: "gate",
      title: "The exam couldn't be loaded",
      body:
        error instanceof DataSourceUnavailableError
          ? "The exam service isn't configured on this server, so your attempt can't be verified. Please try again shortly."
          : "We couldn't reach the exam service to open your attempt. Check your connection and reload — if it persists, tell your institution admin.",
    };
  }

  return outcome.kind === "ready" ? (
    <CbtExamInterface initialState={outcome.state} />
  ) : (
    <GateMessage title={outcome.title} body={outcome.body} />
  );
}

/** A full-screen, honest refusal/error state for the delivery route — never a
 *  blank page and never a partially-trusted exam. Offers a way back to My Exams. */
function GateMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-5 py-10">
      <div className="w-full max-w-md">
        <Alert variant="warning" title={title}>
          {body}
        </Alert>
        <div className="mt-4 flex justify-center">
          <Link href="/student/exams">
            <Button type="button" variant="secondary" size="sm">
              Back to My Exams
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
