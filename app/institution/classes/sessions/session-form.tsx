"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Button, Input } from "@/components/ui";
import {
  SESSION_INPUT_EMPTY,
  looksLikeSessionSpan,
  validateSession,
  type SessionErrors,
  type SessionInput,
} from "@/lib/classes";
import {
  createSessionAction,
  updateSessionAction,
  type SessionActionResult,
} from "../actions";

/**
 * Shared create/edit academic-session form. Runs the same pure validator the
 * server uses for instant feedback, then calls the corresponding server action,
 * which re-validates and re-scopes to the tenant authoritatively. A soft hint
 * nudges the conventional "2025/2026" span without rejecting other names
 * (tutorial centres run non-year sessions like "Batch A").
 */
export function SessionForm({
  mode,
  sessionId,
  initial,
}: {
  mode: "create" | "edit";
  sessionId?: string;
  initial?: SessionInput;
}) {
  const router = useRouter();
  const [values, setValues] = useState<SessionInput>(initial ?? SESSION_INPUT_EMPTY);
  const [errors, setErrors] = useState<SessionErrors>({});
  const [message, setMessage] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  function setValue(value: string) {
    setValues((prev) => ({ ...prev, name: value }));
    setErrors((prev) => {
      if (!prev.name) return prev;
      const next = { ...prev };
      delete next.name;
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // Client-side gate for UX; the server action repeats this authoritatively.
    const clientErrors = validateSession(values);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }

    setErrors({});
    setMessage(undefined);
    setSubmitting(true);
    try {
      const result: SessionActionResult =
        mode === "edit" && sessionId
          ? await updateSessionAction(sessionId, values)
          : await createSessionAction(values);

      if (result.ok && result.id) {
        router.push(`/institution/classes/sessions/${result.id}`);
        router.refresh();
        return;
      }
      if (!result.ok) {
        setErrors(result.errors);
        setMessage(result.message);
        setSubmitting(false);
      }
    } catch {
      setMessage("Something went wrong while saving. Please try again.");
      setSubmitting(false);
    }
  }

  const trimmed = values.name.trim();
  const showSpanHint = trimmed.length > 0 && !looksLikeSessionSpan(trimmed);

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      {message ? (
        <Alert variant="danger" title="Couldn't save this session">
          {message}
        </Alert>
      ) : null}

      <Input
        label="Session name"
        name="name"
        autoComplete="off"
        description="Usually an academic year span, e.g. 2025/2026."
        value={values.name}
        onChange={(e) => setValue(e.target.value)}
        error={errors.name}
        required
      />

      {showSpanHint ? (
        <p className="-mt-3 text-xs text-ink-subtle">
          That doesn&apos;t look like a year span — that&apos;s fine for batches
          or terms, just double-check it&apos;s what you meant.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" size="md" disabled={submitting}>
          {submitting
            ? "Saving…"
            : mode === "edit"
              ? "Save changes"
              : "Create session"}
        </Button>
        <Link
          href={
            mode === "edit" && sessionId
              ? `/institution/classes/sessions/${sessionId}`
              : "/institution/classes/sessions"
          }
        >
          <Button type="button" variant="secondary" size="md">
            Cancel
          </Button>
        </Link>
      </div>
    </form>
  );
}
