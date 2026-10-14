"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setInstitutionStatusAction } from "@/app/platform/institutions/actions";
import {
  INSTITUTION_STATUS_LABELS,
  availableStatusTransitions,
  type InstitutionStatus,
} from "@/lib/institutions";
import { Alert, Button, ConfirmDialog } from "@/components/ui";

/**
 * Approved operational-status control for one institution (prompt 32).
 *
 * The buttons offered are exactly the transitions the pure policy in
 * lib/institutions.ts allows from the current status, so the UI never presents
 * a move the server would refuse. Every action is wrapped in a confirmation
 * dialog (the change is sensitive), and the authoritative re-check + audit
 * happen in the server action — this component is convenience, not protection
 * (AGENTS.md §5). On success the route is refreshed so the server re-reads the
 * new status; the component never optimistically rewrites it locally.
 */
export function InstitutionStatusControl({
  institutionId,
  currentStatus,
}: {
  institutionId: string;
  currentStatus: InstitutionStatus;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [target, setTarget] = useState<InstitutionStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const transitions = availableStatusTransitions(currentStatus);

  async function confirmChange() {
    if (!target || pending) return;
    setPending(true);
    setMessage(null);
    setNotice(null);
    const result = await setInstitutionStatusAction(institutionId, target);
    setPending(false);
    if (result.ok) {
      setTarget(null);
      // A change can apply even when its audit record fails to write
      // (best-effort audit). Surface that so it is never silently accepted.
      if (result.warning) setNotice(result.warning);
      // Re-read server state so the badge and available actions reflect the
      // new status; the refresh is the source of truth.
      router.refresh();
    } else {
      setMessage(result.message);
    }
  }

  if (transitions.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No status changes are available from{" "}
        {INSTITUTION_STATUS_LABELS[currentStatus]}.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {notice ? (
        <Alert variant="warning" title="Change applied, audit incomplete">
          {notice}
        </Alert>
      ) : null}
      {message ? (
        <Alert variant="danger" title="Status not changed">
          {message}
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {transitions.map((option) => {
          const isDanger = option.to === "suspended" || option.to === "archived";
          return (
            <Button
              key={option.to}
              type="button"
              size="sm"
              variant={isDanger ? "danger" : "secondary"}
              disabled={pending}
              onClick={() => {
                setMessage(null);
                setTarget(option.to);
              }}
            >
              {option.to === "active"
                ? "Reactivate"
                : option.to === "suspended"
                  ? "Suspend"
                  : "Archive"}
            </Button>
          );
        })}
      </div>

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setTarget(null);
        }}
        title={`Change status to ${target ? INSTITUTION_STATUS_LABELS[target] : ""}?`}
        description={
          target === "archived"
            ? "This records the institution as retired. Its data is kept for reporting and can be restored later — nothing is deleted. Note: blocking sign-in and exam access for retired institutions is a separate capability that is not yet enforced."
            : target === "suspended"
              ? "This records the institution as suspended for support follow-up. Tenant data is preserved and it can be reactivated. Note: blocking sign-in and exam access for suspended institutions is a separate capability that is not yet enforced."
              : "This restores the institution to normal active operation."
        }
        confirmLabel={pending ? "Working…" : "Confirm change"}
        tone={target === "active" ? "primary" : "danger"}
        onConfirm={confirmChange}
      />
    </div>
  );
}
