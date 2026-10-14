"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, ConfirmDialog } from "@/components/ui";
import type { QuestionStatus } from "@/lib/questions";
import { setQuestionStatusAction } from "./actions";

/**
 * Archive / restore a question from its profile. Archiving is the safe,
 * reversible "remove" action — it flips status, never deletes, so future exam
 * snapshots and results keep resolving (AGENTS.md §6). An archived question
 * leaves the default listing and future pickers but stays readable for
 * history. The tenant/role check is enforced by the server action; this button
 * only drives the confirm dialog and refresh.
 */
export function QuestionStatusButton({
  questionId,
  status,
}: {
  questionId: string;
  status: QuestionStatus;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const isArchive = status === "active";
  const nextStatus: QuestionStatus = isArchive ? "archived" : "active";

  async function confirm() {
    setError(undefined);
    const result = await setQuestionStatusAction(questionId, nextStatus);
    if (!result.ok) {
      // Keep the dialog open so the reason is visible and the user can retry.
      setError(result.message ?? "We couldn't update this question. Please try again.");
      throw new Error("question-status-update-failed");
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {error ? (
        <Alert variant="danger" title="Update failed">
          {error}
        </Alert>
      ) : null}
      <Button
        type="button"
        variant={isArchive ? "danger" : "secondary"}
        size="sm"
        onClick={() => setOpen(true)}
      >
        {isArchive ? "Archive question" : "Restore question"}
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone={isArchive ? "danger" : "primary"}
        confirmLabel={isArchive ? "Archive" : "Restore"}
        title={isArchive ? "Archive this question?" : "Restore this question?"}
        description={
          isArchive
            ? "The question stops appearing in the bank and cannot be newly selected for exams. Any exam that already snapshotted it is unaffected, and this can be undone."
            : "This returns the question to the active bank so exams can select it again."
        }
        onConfirm={confirm}
      />
    </div>
  );
}
