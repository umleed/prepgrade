"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Button, Checkbox, Input } from "@/components/ui";
import {
  createSubjectAction,
  updateSubjectAction,
  type SubjectActionResult,
} from "./actions";
import {
  SUBJECT_INPUT_EMPTY,
  validateSubject,
  type SubjectErrors,
  type SubjectInput,
} from "@/lib/subjects";

type CategoryOption = { id: string; name: string };

/**
 * Shared create/edit subject form. Runs the same pure validator the server
 * uses for instant feedback, then calls the corresponding server action, which
 * re-validates against the authoritative category list and re-scopes to the
 * tenant. `categories` is the active platform list the page assembled; with
 * the catalogue unreachable the form still renders without category choices
 * (a subject may exist unfiled), matching the directory's honest states.
 */
export function SubjectForm({
  mode,
  subjectId,
  categories,
  initial,
}: {
  mode: "create" | "edit";
  subjectId?: string;
  categories: CategoryOption[];
  initial?: SubjectInput;
}) {
  const router = useRouter();
  const [values, setValues] = useState<SubjectInput>(initial ?? SUBJECT_INPUT_EMPTY);
  const [errors, setErrors] = useState<SubjectErrors>({});
  const [message, setMessage] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  function setField<K extends keyof SubjectInput>(key: K, value: SubjectInput[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function toggleCategory(id: string, checked: boolean) {
    setValues((prev) => ({
      ...prev,
      categoryIds: checked
        ? [...prev.categoryIds, id]
        : prev.categoryIds.filter((value) => value !== id),
    }));
    setErrors((prev) => {
      if (!prev.categoryIds) return prev;
      const next = { ...prev };
      delete next.categoryIds;
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // Client-side gate for UX; the server action repeats this authoritatively.
    const clientErrors = validateSubject(
      values,
      categories.map((category) => category.id),
    );
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }

    setErrors({});
    setMessage(undefined);
    setSubmitting(true);
    try {
      const result: SubjectActionResult =
        mode === "edit" && subjectId
          ? await updateSubjectAction(subjectId, values)
          : await createSubjectAction(values);

      if (result.ok && result.id) {
        router.push(`/institution/subjects/${result.id}`);
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
        <Alert variant="danger" title="Couldn't save this subject">
          {message}
        </Alert>
      ) : null}

      <Input
        label="Subject name"
        name="name"
        autoComplete="off"
        description="Shown in the question bank, exams, and reports (e.g. Mathematics, Literary Sets)."
        value={values.name}
        onChange={(e) => setField("name", e.target.value)}
        error={errors.name}
        required
      />

      <Input
        label="Short code"
        name="code"
        autoComplete="off"
        description="Optional label for dense tables (e.g. MTH). Letters, numbers, spaces, or -."
        value={values.code}
        onChange={(e) => setField("code", e.target.value)}
        error={errors.code}
        maxLength={12}
      />

      <fieldset>
        <legend className="text-sm font-medium text-ink">Exam categories</legend>
        <p className="mt-0.5 text-xs text-ink-muted">
          Which examinations this subject is prepared for. Leave empty for
          class-only assessments.
        </p>
        {categories.length === 0 ? (
          <p className="mt-2 text-sm text-ink-subtle">
            No exam categories are available right now — this is expected until
            the catalogue migration is applied.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
            {categories.map((category) => (
              <Checkbox
                key={category.id}
                label={category.name}
                checked={values.categoryIds.includes(category.id)}
                onChange={(e) => toggleCategory(category.id, e.target.checked)}
              />
            ))}
          </div>
        )}
        {errors.categoryIds ? (
          <p className="mt-1.5 text-sm text-danger" role="alert">
            {errors.categoryIds}
          </p>
        ) : null}
      </fieldset>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" size="md" disabled={submitting}>
          {submitting
            ? "Saving…"
            : mode === "edit"
              ? "Save changes"
              : "Add subject"}
        </Button>
        <Link
          href={
            mode === "edit" && subjectId
              ? `/institution/subjects/${subjectId}`
              : "/institution/subjects"
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
