"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Button, Input, Select } from "@/components/ui";
import {
  TOPIC_INPUT_EMPTY,
  validateTopic,
  type TopicErrors,
  type TopicInput,
} from "@/lib/subjects";
import {
  createTopicAction,
  updateTopicAction,
  type TopicActionResult,
} from "./actions";

type ParentOption = { id: string; name: string };

/**
 * Shared add/rename topic form. Runs the same pure validator the server uses
 * for instant feedback, then calls the corresponding server action, which
 * re-validates and re-checks tenancy and the one-level depth rule
 * authoritatively. On rename the subject and parent links are fixed — topics
 * never move between subjects or hierarchies, so historical statistics keep
 * their meaning (AGENTS.md §6).
 */
export function TopicForm({
  mode,
  subjectId,
  topicId,
  parents,
  initial,
}: {
  mode: "create" | "edit";
  subjectId: string;
  topicId?: string;
  parents: ParentOption[];
  initial?: TopicInput;
}) {
  const router = useRouter();
  const [values, setValues] = useState<TopicInput>(initial ?? TOPIC_INPUT_EMPTY);
  const [errors, setErrors] = useState<TopicErrors>({});
  const [message, setMessage] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  function setField<K extends keyof TopicInput>(key: K, value: TopicInput[K]) {
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
    const clientErrors = validateTopic(values);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }

    setErrors({});
    setMessage(undefined);
    setSubmitting(true);
    try {
      const result: TopicActionResult =
        mode === "edit" && topicId
          ? await updateTopicAction(topicId, values)
          : await createTopicAction(values);

      if (result.ok) {
        router.push(`/institution/subjects/${subjectId}`);
        router.refresh();
        return;
      }
      setErrors(result.errors);
      setMessage(result.message);
      setSubmitting(false);
    } catch {
      setMessage("Something went wrong while saving. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      {message ? (
        <Alert variant="danger" title="Couldn't save this topic">
          {message}
        </Alert>
      ) : null}

      <Input
        label="Topic name"
        name="name"
        autoComplete="off"
        description="A lesson or syllabus unit questions and topic analytics group by (e.g. Algebra, Bases and Indices)."
        value={values.name}
        onChange={(e) => setField("name", e.target.value)}
        error={errors.name}
        required
      />

      {mode === "create" ? (
        <Select
          label="Parent topic"
          name="parentId"
          required={false}
          value={values.parentId}
          onChange={(e) => setField("parentId", e.target.value)}
          error={errors.parentId}
          description={
            parents.length === 0
              ? "No active top-level topics exist yet — this will be a top-level topic."
              : "Optional — file this as a subtopic under one active top-level topic."
          }
        >
          <option value="">Top-level topic</option>
          {parents.map((parent) => (
            <option key={parent.id} value={parent.id}>
              {parent.name}
            </option>
          ))}
        </Select>
      ) : null}

      {errors.subjectId ? (
        <Alert variant="danger" title="Invalid subject">
          {errors.subjectId}
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" size="md" disabled={submitting}>
          {submitting
            ? "Saving…"
            : mode === "edit"
              ? "Save changes"
              : "Add topic"}
        </Button>
        <Link href={`/institution/subjects/${subjectId}`}>
          <Button type="button" variant="secondary" size="md">
            Cancel
          </Button>
        </Link>
      </div>
    </form>
  );
}
