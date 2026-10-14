"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, ConfirmDialog } from "@/components/ui";
import type { TeacherStatus } from "@/lib/teachers";
import { activateTeacherAction, deactivateTeacherAction } from "./actions";

/**
 * Grant / revoke a teacher's access from their profile.
 *
 * - `invited`  → "Activate access": links the account (server-side email
 *   lookup) and writes the trusted TEACHER role. Confirmed because it grants
 *   workspace access.
 * - `active`   → "Deactivate access": the safe, reversible removal — status
 *   flips, the membership is marked inactive, and the sign-in role is revoked
 *   server-side. Nothing is deleted (AGENTS.md §6).
 * - `inactive` → "Reactivate access": the same trusted grant path as activate.
 *
 * The underlying server actions re-check authorization and tenancy regardless
 * of this UI; denial errors surface inline and keep the dialog state honest.
 */
export function TeacherAccessButton({
  teacherId,
  status,
}: {
  teacherId: string;
  status: TeacherStatus;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const isDeactivate = status === "active";

  async function confirm() {
    setError(undefined);
    setBusy(true);
    try {
      const result = isDeactivate
        ? await deactivateTeacherAction(teacherId)
        : await activateTeacherAction(teacherId);

      if (!result.ok) {
        // Keep the dialog open so the reason is visible and the user can retry.
        setError(result.message ?? "We couldn't update this teacher. Please try again.");
        throw new Error("teacher-access-update-failed");
      }
      setNotice(result.notice);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {error ? (
        <Alert variant="danger" title="Update failed">
          {error}
        </Alert>
      ) : null}
      {notice && !error ? (
        <Alert variant="success" title="Updated">
          {notice}
        </Alert>
      ) : null}
      <Button
        type="button"
        variant={isDeactivate ? "danger" : "secondary"}
        size="sm"
        disabled={busy}
        onClick={() => {
          setNotice(undefined);
          setOpen(true);
        }}
      >
        {isDeactivate
          ? "Deactivate access"
          : status === "invited"
            ? "Activate access"
            : "Reactivate access"}
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone={isDeactivate ? "danger" : "primary"}
        confirmLabel={
          isDeactivate ? "Deactivate" : status === "invited" ? "Activate" : "Reactivate"
        }
        title={
          isDeactivate
            ? "Deactivate this teacher's access?"
            : status === "invited"
              ? "Grant this teacher access?"
              : "Reactivate this teacher's access?"
        }
        description={
          isDeactivate
            ? "The teacher will lose sign-in access to your institution's workspace immediately. Their records and class history are kept, and access can be granted again later."
            : "PrepGrade will look up the account for this teacher's email and grant it teacher access for your institution's assigned classes only. This action is recorded against your institution."
        }
        onConfirm={confirm}
      />
    </div>
  );
}
