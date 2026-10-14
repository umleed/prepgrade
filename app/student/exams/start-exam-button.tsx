"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button } from "@/components/ui";
import { startExamAction } from "@/app/student/exams/actions";

/**
 * The explicit start action on the pre-exam instructions screen (prompts 21–22).
 * Presentation offers the button; the SERVER decides (see actions.ts). On a
 * green light the action has already created (or resumed) the attempt with a
 * server-stamped deadline, so we navigate into the CBT interface — which
 * re-runs the same idempotent start to recover the live attempt on refresh. A
 * crafted call to the same action runs the identical server-side checks;
 * hiding or disabling this button is convenience, not protection (AGENTS.md §5).
 */
export function StartExamButton({
  examId,
  disabled,
  disabledReason,
}: {
  examId: string;
  /** Server-computed: the exam is not currently startable (scheduled,
   *  expired, attempts exhausted). The reason is shown instead of a button. */
  disabled: boolean;
  disabledReason: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (disabled) {
    return (
      <p className="text-sm text-ink-muted" role="note">
        {disabledReason ?? "This exam cannot be started right now."}
      </p>
    );
  }

  async function handleStart() {
    setMessage(null);
    setBusy(true);
    try {
      const result = await startExamAction(examId);
      if (!result.ok) {
        setMessage(result.message);
        setBusy(false);
        return;
      }
      // The attempt exists server-side; the interface resumes it idempotently,
      // so navigating (rather than a client redirect with a token) is safe on
      // refresh and across tabs.
      setMessage("Starting your exam…");
      router.push(`/exam/${examId}`);
    } catch {
      setMessage(
        "We couldn't reach the exam service to verify you right now. Check your connection and try again.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-3">
      {message ? (
        <Alert variant="info" title="Preparing your exam">
          {message}
        </Alert>
      ) : null}
      <Button
        type="button"
        variant="primary"
        onClick={() => void handleStart()}
        disabled={busy}
      >
        {busy ? "Starting…" : "Start exam"}
      </Button>
    </div>
  );
}
