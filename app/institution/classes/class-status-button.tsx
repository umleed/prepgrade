"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, ConfirmDialog } from "@/components/ui";
import type { OrgStatus } from "@/lib/classes";
import { setClassStatusAction } from "./actions";

/**
 * Archive / restore a class from its profile. Archiving is the safe, reversible
 * "remove" action — it flips status, never deletes, so future exams, attempts,
 * and results keep resolving (AGENTS.md §6). Archiving is refused while students
 * are still attached; that guard is enforced by the server action, and the
 * count here only pre-warns in the UI so the reason is visible up front.
 */
export function ClassStatusButton({
  classId,
  status,
  attachedStudents,
}: {
  classId: string;
  status: OrgStatus;
  attachedStudents: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const isArchive = status === "active";
  const nextStatus: OrgStatus = isArchive ? "archived" : "active";
  const blocked = isArchive && attachedStudents > 0;

  async function confirm() {
    setError(undefined);
    const result = await setClassStatusAction(classId, nextStatus);
    if (!result.ok) {
      // Keep the dialog open so the reason is visible and the user can retry.
      setError(result.message ?? "We couldn't update this class. Please try again.");
      throw new Error("class-status-update-failed");
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
        {isArchive ? "Archive class" : "Restore class"}
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone={isArchive ? "danger" : "primary"}
        confirmLabel={isArchive ? "Archive" : "Restore"}
        title={isArchive ? "Archive this class?" : "Restore this class?"}
        description={
          isArchive
            ? blocked
              ? `${attachedStudents} student${
                  attachedStudents === 1 ? " is" : "s are"
                } still assigned to this class. Move them to another class first — their history here is kept, and the class cannot be archived until the roster is clear.`
              : "The class stops appearing in pickers and cannot be assigned to new students or assessments. Its records are kept for reporting and this can be undone."
            : "This returns the class to the active list so it can be assigned to students and assessments again."
        }
        onConfirm={confirm}
      />
    </div>
  );
}
