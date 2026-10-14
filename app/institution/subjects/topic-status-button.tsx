"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, ConfirmDialog } from "@/components/ui";
import type { CatalogueStatus } from "@/lib/subjects";
import { setTopicStatusAction } from "./actions";

/**
 * Archive / restore an institution-owned topic from its subject page. Like
 * every catalogue removal this flips status and never deletes, so historical
 * topic-level analytics keep resolving (AGENTS.md §6). Archiving is refused
 * while active subtopics are attached; the server action enforces that, and
 * the count here only pre-warns in the UI.
 */
export function TopicStatusButton({
  subjectId,
  topicId,
  status,
  attachedSubtopics,
}: {
  subjectId: string;
  topicId: string;
  status: CatalogueStatus;
  attachedSubtopics: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const isArchive = status === "active";
  const nextStatus: CatalogueStatus = isArchive ? "archived" : "active";
  const blocked = isArchive && attachedSubtopics > 0;

  async function confirm() {
    setError(undefined);
    const result = await setTopicStatusAction(subjectId, topicId, nextStatus);
    if (!result.ok) {
      // Keep the dialog open so the reason is visible and the user can retry.
      setError(result.message ?? "We couldn't update this topic. Please try again.");
      throw new Error("topic-status-update-failed");
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
        {isArchive ? "Archive" : "Restore"}
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone={isArchive ? "danger" : "primary"}
        confirmLabel={isArchive ? "Archive" : "Restore"}
        title={isArchive ? "Archive this topic?" : "Restore this topic?"}
        description={
          isArchive
            ? blocked
              ? `${attachedSubtopics} active subtopic${
                  attachedSubtopics === 1 ? "" : "s"
                } still sit under this topic. Archive them first — the topic cannot be archived until the branch is clear.`
              : "The topic stops appearing in pickers but stays readable for past results and analytics. This can be undone."
            : "This returns the topic to the active catalogue so questions and exams can select it again."
        }
        onConfirm={confirm}
      />
    </div>
  );
}
