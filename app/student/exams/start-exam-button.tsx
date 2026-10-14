"use client";

import { useState } from "react";
import { Alert, Button } from "@/components/ui";
import { startExamAction } from "@/app/student/exams/actions";

/**
 * The explicit start action on the pre-exam instructions screen (prompt 21).
 * Presentation offers the button; the SERVER decides (see actions.ts). Even
 * when the exam is eligible, delivery (prompts 22–23) has not shipped, so
 * the action honestly reports that the interface is not live yet rather
 * than navigating to a nonexistent exam. A crafted call to the same action
 * runs the identical server-side checks — hiding or disabling this button
 * is convenience, not protection (AGENTS.md §5).
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
        return;
      }
      // Delivery will redirect here once prompts 22–23 ship; today the
      // action never returns ok:true, so this stays honest.
      setMessage("Starting your exam…");
    } catch {
      setMessage(
        "We couldn't reach the exam service to verify you right now. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-3">
      {message ? (
        <Alert variant="info" title="Not ready to start yet">
          {message}
        </Alert>
      ) : null}
      <Button
        type="button"
        variant="primary"
        onClick={() => void handleStart()}
        disabled={busy}
      >
        {busy ? "Checking…" : "Start exam"}
      </Button>
    </div>
  );
}
