"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, ConfirmDialog } from "@/components/ui";
import type { StudentStatus } from "@/lib/students";
import { setStudentStatusAction } from "./actions";

/**
 * Deactivate / reactivate a student from their profile. Deactivation is the safe,
 * reversible "remove access" action — it flips status, never deletes history
 * (AGENTS.md §6). The destructive-style action is confirmed before it runs, and
 * the underlying server action re-checks the tenant regardless of this UI.
 */
export function StudentStatusButton({
  studentId,
  status,
}: {
  studentId: string;
  status: StudentStatus;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const isDeactivate = status === "active";
  const nextStatus: StudentStatus = isDeactivate ? "inactive" : "active";

  async function confirm() {
    setError(undefined);
    const result = await setStudentStatusAction(studentId, nextStatus);
    if (!result.ok) {
      // Keep the dialog open so the reason is visible and the user can retry.
      setError(result.message ?? "We couldn't update this student. Please try again.");
      throw new Error("status-update-failed");
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
        variant={isDeactivate ? "danger" : "secondary"}
        size="sm"
        onClick={() => setOpen(true)}
      >
        {isDeactivate ? "Deactivate access" : "Reactivate access"}
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone={isDeactivate ? "danger" : "primary"}
        confirmLabel={isDeactivate ? "Deactivate" : "Reactivate"}
        title={
          isDeactivate ? "Deactivate this student's access?" : "Reactivate this student?"
        }
        description={
          isDeactivate
            ? "The student will stop appearing as an active roster member and cannot be assigned new assessments. Their existing records are kept and this can be undone."
            : "This returns the student to the active roster so they can be assigned assessments again."
        }
        onConfirm={confirm}
      />
    </div>
  );
}
