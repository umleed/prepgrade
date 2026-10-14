"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, ConfirmDialog } from "@/components/ui";
import {
  EXAM_STATUS_LABELS,
  examTransitionOptions,
  type ExamStatus,
} from "@/lib/exams";
import { setExamStatusAction } from "./actions";

/**
 * Lifecycle actions for one exam (prompt 17). Which transitions appear is
 * derived from the CURRENT status via the pure transition map — the same one
 * the server enforces — so the buttons can only ever offer moves the backend
 * accepts, and offering them is presentation, not protection (AGENTS.md §5).
 *
 * Publishing is deliberately NOT one of these buttons. Prompt 19 makes
 * publish a confirmation flow of its own (choose the class/student audience,
 * review exactly who receives it and when, then release), so it lives behind
 * the Assign & publish screen rather than a one-click transition here. The
 * remaining moves — schedule marker, close, archive, back-to-draft — carry no
 * audience and stay safe as direct actions.
 */

type TransitionCopy = {
  label: string;
  variant: "primary" | "secondary" | "danger" | "ghost";
  confirmTitle: string;
  confirmDescription: string;
  needsConfirm: boolean;
};

const TRANSITION_COPY: Partial<Record<ExamStatus, TransitionCopy>> = {
  published: {
    label: "Publish exam",
    variant: "primary",
    confirmTitle: "Publish this exam?",
    confirmDescription:
      "Once published, students in the assigned classes can take it during its availability window, and its subject, duration, and window lock so live attempts stay fair.",
    needsConfirm: true,
  },
  closed: {
    label: "Close exam",
    variant: "secondary",
    confirmTitle: "Close this exam?",
    confirmDescription:
      "No further attempts will be accepted. Submitted work and results stay available for review. This cannot be undone.",
    needsConfirm: true,
  },
  archived: {
    label: "Archive exam",
    variant: "danger",
    confirmTitle: "Archive this exam?",
    confirmDescription:
      "The exam leaves the default listing but is kept permanently so historical results keep resolving. This cannot be undone.",
    needsConfirm: true,
  },
  draft: {
    label: "Move back to draft",
    variant: "ghost",
    confirmTitle: "",
    confirmDescription: "",
    needsConfirm: false,
  },
};

export function ExamLifecycleButtons({
  examId,
  status,
}: {
  examId: string;
  status: ExamStatus;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<ExamStatus | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Publishing routes through the Assign & publish flow (prompt 19), never a
  // one-click transition here — so drop it from the offered moves.
  const options = examTransitionOptions(status).filter(
    (next) => next !== "published",
  );
  if (options.length === 0) return null;

  async function run(next: ExamStatus) {
    setError(undefined);
    setBusy(true);
    try {
      const result = await setExamStatusAction(examId, next);
      if (!result.ok) {
        setError(result.message ?? "We couldn't update this exam. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("We couldn't update this exam. Please try again.");
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {error ? (
        <Alert variant="danger" title="Update failed">
          {error}
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {options.map((next) => {
          const copy = TRANSITION_COPY[next];
          if (!copy) return null;

          const button = (
            <Button
              type="button"
              variant={copy.variant}
              size="sm"
              disabled={busy}
              onClick={() => {
                if (copy.needsConfirm) setPending(next);
                else void run(next);
              }}
            >
              {copy.label}
            </Button>
          );

          return (
            <span key={next} className="flex flex-col items-start gap-1">
              {button}
            </span>
          );
        })}
      </div>

      {pending && TRANSITION_COPY[pending] ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          tone={pending === "archived" ? "danger" : "primary"}
          confirmLabel={EXAM_STATUS_LABELS[pending]}
          title={TRANSITION_COPY[pending].confirmTitle}
          description={TRANSITION_COPY[pending].confirmDescription}
          onConfirm={() => run(pending)}
        />
      ) : null}
    </div>
  );
}
