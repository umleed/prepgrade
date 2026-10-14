"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Button, Input, Select } from "@/components/ui";
import {
  CLASS_INPUT_EMPTY,
  validateClass,
  type ClassErrors,
  type ClassInput,
} from "@/lib/classes";
import {
  createClassAction,
  updateClassAction,
  type ClassActionResult,
} from "./actions";

type SessionOption = { id: string; name: string };

/**
 * Shared create/edit class form. Runs the same pure validator the server uses
 * for instant feedback, then calls the corresponding server action, which
 * re-validates and re-scopes to the tenant authoritatively. `sessions` is the
 * selectable list the page assembled (active sessions, plus the class's own
 * current session on edit so an archived link still displays correctly).
 */
export function ClassForm({
  mode,
  classId,
  sessions,
  initial,
}: {
  mode: "create" | "edit";
  classId?: string;
  sessions: SessionOption[];
  initial?: ClassInput;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ClassInput>(initial ?? CLASS_INPUT_EMPTY);
  const [errors, setErrors] = useState<ClassErrors>({});
  const [message, setMessage] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  function setField<K extends keyof ClassInput>(key: K, value: ClassInput[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // Client-side gate for UX; the server action repeats this authoritatively.
    const clientErrors = validateClass(values);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }

    setErrors({});
    setMessage(undefined);
    setSubmitting(true);
    try {
      const result: ClassActionResult =
        mode === "edit" && classId
          ? await updateClassAction(classId, values)
          : await createClassAction(values);

      if (result.ok && result.id) {
        router.push(`/institution/classes/${result.id}`);
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

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      {message ? (
        <Alert variant="danger" title="Couldn't save this class">
          {message}
        </Alert>
      ) : null}

      <Input
        label="Class name"
        name="name"
        autoComplete="off"
        description="Shown in assessments and result reports (e.g. SS 101, JAMB 2026)."
        value={values.name}
        onChange={(e) => setField("name", e.target.value)}
        error={errors.name}
        required
      />

      <Select
        label="Academic session (optional)"
        name="academicSessionId"
        required={false}
        value={values.academicSessionId}
        onChange={(e) => setField("academicSessionId", e.target.value)}
        error={errors.academicSessionId}
        description={
          sessions.length === 0
            ? "No active sessions exist yet. You can leave this unassigned and link a session later by editing the class."
            : "Optional — the academic year this class belongs to. Leave it Unassigned for now; you can set or change it later by editing the class."
        }
      >
        <option value="">Unassigned</option>
        {sessions.map((session) => (
          <option key={session.id} value={session.id}>
            {session.name}
          </option>
        ))}
      </Select>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" size="md" disabled={submitting}>
          {submitting
            ? "Saving…"
            : mode === "edit"
              ? "Save changes"
              : "Create class"}
        </Button>
        <Link
          href={
            mode === "edit" && classId
              ? `/institution/classes/${classId}`
              : "/institution/classes"
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
