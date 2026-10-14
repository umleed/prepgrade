"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, ConfirmDialog } from "@/components/ui";
import type { CatalogueStatus } from "@/lib/subjects";
import { setSubjectStatusAction } from "./actions";

/**
 * Archive / restore an institution-owned subject from its profile. Archiving
 * is the safe, reversible "remove" action — it flips status, never deletes, so
 * future questions, exams, and results keep resolving (AGENTS.md §6).
 * Archiving is refused while active topics are attached; that guard is
 * enforced by the server action, and the count here only pre-warns in the UI.
 */
export function SubjectStatusButton({
  subjectId,
  status,
  attachedTopics,
}: {
  subjectId: string;
  status: CatalogueStatus;
  attachedTopics: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const isArchive = status === "active";
  const nextStatus: CatalogueStatus = isArchive ? "archived" : "active";
  const blocked = isArchive && attachedTopics > 0;

  async function confirm() {
    setError(undefined);
    const result = await setSubjectStatusAction(subjectId, nextStatus);
    if (!result.ok) {
      // Keep the dialog open so the reason is visible and the user can retry.
      setError(result.message ?? "We couldn't update this subject. Please try again.");
      throw new Error("subject-status-update-failed");
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
        {isArchive ? "Archive subject" : "Restore subject"}
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone={isArchive ? "danger" : "primary"}
        confirmLabel={isArchive ? "Archive" : "Restore"}
        title={isArchive ? "Archive this subject?" : "Restore this subject?"}
        description={
          isArchive
            ? blocked
              ? `${attachedTopics} active topic${
                  attachedTopics === 1 ? "" : "s"
                } still sit under this subject. Archive them first — past results keep working either way, and the subject cannot be archived until the branch is clear.`
              : "The subject stops appearing in pickers and cannot be newly selected for questions or exams. Its topics and any past records are kept for reporting, and this can be undone."
            : "This returns the subject to the active catalogue so questions and exams can select it again."
        }
        onConfirm={confirm}
      />
    </div>
  );
}
