"use client";

import { useState, type ReactNode } from "react";
import { Button } from "./button";
import { Dialog } from "./dialog";

/*
 * Confirmation dialog for irreversible or sensitive actions (publish exam,
 * delete question, remove member). While the async `onConfirm` is running the
 * dialog is non-dismissable and both actions are disabled, so a slow request
 * cannot be double-submitted or escaped out of mid-flight.
 */

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` styles the confirm action in red for destructive operations. */
  tone?: "primary" | "danger";
  onConfirm: () => void | Promise<void>;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "primary",
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);

  const handleConfirm = async () => {
    if (pending) return;
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      // Clear the flag even if the action threw; the dialog stays open so the
      // caller can surface the error and retry.
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      dismissable={!pending}
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            size="sm"
            disabled={pending}
            onClick={handleConfirm}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </>
      }
    >
      {pending ? (
        <p role="status" className="sr-only">
          Confirmation in progress
        </p>
      ) : null}
    </Dialog>
  );
}
