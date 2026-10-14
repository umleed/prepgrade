"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, ConfirmDialog } from "@/components/ui";
import type { OrgStatus } from "@/lib/classes";
import { setSessionStatusAction } from "../actions";

/**
 * Archive / restore an academic session. Archiving is the safe, reversible
 * removal — it flips status, never deletes, so classes and any future results
 * tied to the year keep resolving (AGENTS.md §6). Archiving is refused while
 * ACTIVE classes are still attached; that guard is enforced by the server
 * action, and the count here only pre-warns in the UI.
 */
export function SessionStatusButton({
  sessionId,
  status,
  activeClasses,
}: {
  sessionId: string;
  status: OrgStatus;
  activeClasses: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const isArchive = status === "active";
  const nextStatus: OrgStatus = isArchive ? "archived" : "active";
  const blocked = isArchive && activeClasses > 0;

  async function confirm() {
    setError(undefined);
    const result = await setSessionStatusAction(sessionId, nextStatus);
    if (!result.ok) {
      setError(result.message ?? "We couldn't update this session. Please try again.");
      throw new Error("session-status-update-failed");
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
        {isArchive ? "Archive session" : "Restore session"}
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone={isArchive ? "danger" : "primary"}
        confirmLabel={isArchive ? "Archive" : "Restore"}
        title={isArchive ? "Archive this session?" : "Restore this session?"}
        description={
          isArchive
            ? blocked
              ? `${activeClasses} active class${
                  activeClasses === 1 ? "" : "es"
                } still belong${activeClasses === 1 ? "s" : ""} to this session. Archive or move them first — the session cannot be retired until no active classes remain.`
              : "New classes can no longer be attached to this session. Its existing classes and records are kept for reporting and this can be undone."
            : "This returns the session to the active list so new classes can be attached to it again."
        }
        onConfirm={confirm}
      />
    </div>
  );
}
