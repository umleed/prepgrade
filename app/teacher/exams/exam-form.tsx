"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  Select,
  Textarea,
} from "@/components/ui";
import {
  EXAM_DESCRIPTION_MAX_LENGTH,
  EXAM_DURATION_MAX,
  EXAM_DURATION_MIN,
  EXAM_INPUT_EMPTY,
  EXAM_MAX_ATTEMPTS_MAX,
  EXAM_MAX_ATTEMPTS_MIN,
  EXAM_RESULTS_RELEASE_LABELS,
  EXAM_RESULTS_RELEASE_HINTS,
  EXAM_RESULTS_RELEASES,
  EXAM_TITLE_MAX_LENGTH,
  validateExam,
  type ExamErrors,
  type ExamInput,
} from "@/lib/exams";
import { createExamAction, updateExamAction } from "./actions";

type PickerOption = { id: string; name: string };

/**
 * Shared create/edit exam form (prompts 17–18) — the assessment-details
 * slice: title, description, subject and category, duration, availability
 * window, and the delivery configuration the builder exposes (attempt limit,
 * randomisation, result release). Question selection lives on the builder
 * page; class assignment with the assignment flow (prompt 19).
 *
 * Runs the same pure validator the server uses for instant feedback, then
 * calls the matching server action, which re-validates, re-checks tenancy,
 * and — on edit — REFUSES any change to a field the exam's lifecycle status
 * has locked. `lockedFields` (computed server-side from the current status)
 * only drives the disabled presentation; the authoritative rule lives on the
 * server, so a crafted payload changes nothing (AGENTS.md §6).
 */
export function ExamForm({
  mode,
  examId,
  subjects,
  categories,
  initial,
  lockedFields = [],
  afterSaveHref,
  cancelHref,
}: {
  mode: "create" | "edit";
  examId?: string;
  subjects: PickerOption[];
  categories: PickerOption[];
  initial?: ExamInput;
  /** Field names frozen by the exam's current status (edit mode). */
  lockedFields?: string[];
  /**
   * Where to send the user after a successful save. Defaults to the shared
   * exam detail (`/teacher/exams/{id}`). The institution-owned create page
   * passes an `/institution/exams` destination so an admin never leaves the
   * Institution shell to start an assessment. Must be a plain string — server
   * components cannot pass functions to this client form.
   */
  afterSaveHref?: string;
  /** Where Cancel returns to. Defaults to the teaching exam workspace. */
  cancelHref?: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ExamInput>(initial ?? EXAM_INPUT_EMPTY);
  const [errors, setErrors] = useState<ExamErrors>({});
  const [message, setMessage] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  function isLocked(field: keyof ExamInput): boolean {
    return mode === "edit" && lockedFields.includes(field);
  }

  function setField<K extends keyof ExamInput>(key: K, value: ExamInput[K]) {
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
    const clientErrors = validateExam(values);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }

    setErrors({});
    setMessage(undefined);
    setSubmitting(true);
    try {
      const result =
        mode === "edit" && examId
          ? await updateExamAction(examId, values)
          : await createExamAction(values);

      if (result.ok && result.id) {
        router.push(afterSaveHref ?? `/teacher/exams/${result.id}`);
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
        <Alert variant="danger" title="Couldn't save this exam">
          {message}
        </Alert>
      ) : null}

      {lockedFields.length > 0 ? (
        <Alert variant="info" title="Some details are locked">
          This exam&apos;s status locks its delivery-shaping details — subject,
          category, duration, window, attempts, randomisation, and result
          release — so active or completed attempts stay consistent. Fields
          marked below are read-only.
        </Alert>
      ) : null}

      {/* 1. Basic information */}
      <Card>
        <div className="flex flex-col gap-4 p-6">
          <div>
            <h2 className="text-base font-semibold text-ink">
              1. Basic information
            </h2>
            <p className="mt-0.5 text-sm text-ink-muted">
              Name the exam and file it under the subject it assesses.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Input
              label="Exam title"
              name="title"
              value={values.title}
              onChange={(e) => setField("title", e.target.value)}
              error={errors.title}
              placeholder="e.g. Mathematics Mock Test 2"
              maxLength={EXAM_TITLE_MAX_LENGTH}
              disabled={isLocked("title")}
              required
            />
            <p className="text-right text-2xs text-ink-subtle" aria-hidden="true">
              {values.title.length}/{EXAM_TITLE_MAX_LENGTH} characters
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Textarea
              label="Description"
              name="description"
              rows={3}
              description="Optional. What this assessment covers, shown to teachers and admins."
              value={values.description}
              onChange={(e) => setField("description", e.target.value)}
              error={errors.description}
              maxLength={EXAM_DESCRIPTION_MAX_LENGTH}
              disabled={isLocked("description")}
            />
            <p className="text-right text-2xs text-ink-subtle" aria-hidden="true">
              {values.description.length}/{EXAM_DESCRIPTION_MAX_LENGTH} characters
            </p>
          </div>
          <Select
            label="Subject"
            name="subjectId"
            placeholder="Choose a subject"
            value={values.subjectId}
            onChange={(e) => setField("subjectId", e.target.value)}
            error={errors.subjectId}
            disabled={isLocked("subjectId")}
            required
          >
            <option value="">Select…</option>
            {subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </Select>
          <Select
            label="Exam category"
            name="categoryId"
            placeholder="Unclassified"
            description="Optional. The examination this prepares for (JAMB, WAEC, NECO, or a custom school exam)."
            value={values.categoryId}
            onChange={(e) => setField("categoryId", e.target.value)}
            error={errors.categoryId}
            disabled={isLocked("categoryId")}
          >
            <option value="">None</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {/* 2. Timing */}
      <Card>
        <div className="flex flex-col gap-4 p-6">
          <div>
            <h2 className="text-base font-semibold text-ink">
              2. Duration &amp; schedule
            </h2>
            <p className="mt-0.5 text-sm text-ink-muted">
              How long students get, and the window during which the exam is
              available. Leave the window empty to schedule it later.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Input
              label="Duration (minutes)"
              name="durationMinutes"
              type="number"
              min={EXAM_DURATION_MIN}
              max={EXAM_DURATION_MAX}
              value={String(values.durationMinutes)}
              onChange={(e) =>
                setField("durationMinutes", Number.parseInt(e.target.value, 10) || 0)
              }
              error={errors.durationMinutes}
              disabled={isLocked("durationMinutes")}
              required
            />
            <Input
              label="Available from"
              name="startsAt"
              type="datetime-local"
              value={values.startsAt}
              onChange={(e) => setField("startsAt", e.target.value)}
              error={errors.startsAt}
              disabled={isLocked("startsAt")}
            />
            <Input
              label="Available until"
              name="endsAt"
              type="datetime-local"
              value={values.endsAt}
              onChange={(e) => setField("endsAt", e.target.value)}
              error={errors.endsAt}
              disabled={isLocked("endsAt")}
            />
          </div>
        </div>
      </Card>

      {/* 3. Delivery & scoring rules */}
      <Card>
        <div className="flex flex-col gap-4 p-6">
          <div>
            <h2 className="text-base font-semibold text-ink">
              3. Delivery &amp; scoring rules
            </h2>
            <p className="mt-0.5 text-sm text-ink-muted">
              How often students may attempt, how the exam is presented, and
              when results become visible. Marks per question are set in the
              exam builder.
            </p>
          </div>
          <Input
            label="Attempt limit (per student)"
            name="maxAttempts"
            type="number"
            min={EXAM_MAX_ATTEMPTS_MIN}
            max={EXAM_MAX_ATTEMPTS_MAX}
            description={`How many times one student may take this exam, ${EXAM_MAX_ATTEMPTS_MIN}–${EXAM_MAX_ATTEMPTS_MAX}.`}
            value={String(values.maxAttempts)}
            onChange={(e) =>
              setField("maxAttempts", Number.parseInt(e.target.value, 10) || 0)
            }
            error={errors.maxAttempts}
            disabled={isLocked("maxAttempts")}
            required
          />
          <div className="flex flex-col gap-3">
            <Checkbox
              label="Randomise question order"
              description="Each student sees the questions in a different order; marks and content stay the same."
              checked={values.shuffleQuestions}
              onChange={(e) => setField("shuffleQuestions", e.target.checked)}
              disabled={isLocked("shuffleQuestions")}
            />
            <Checkbox
              label="Randomise answer options"
              description="Options are shuffled per student; the correct answer keeps pointing at the right option."
              checked={values.shuffleOptions}
              onChange={(e) => setField("shuffleOptions", e.target.checked)}
              disabled={isLocked("shuffleOptions")}
            />
          </div>
          <Select
            label="Release results"
            name="resultsRelease"
            description={EXAM_RESULTS_RELEASE_HINTS[values.resultsRelease]}
            value={values.resultsRelease}
            onChange={(e) => {
              const next = e.target.value;
              setField(
                "resultsRelease",
                (EXAM_RESULTS_RELEASES as readonly string[]).includes(next)
                  ? (next as ExamInput["resultsRelease"])
                  : values.resultsRelease,
              );
            }}
            error={errors.resultsRelease}
            disabled={isLocked("resultsRelease")}
            required
          >
            {EXAM_RESULTS_RELEASES.map((release) => (
              <option key={release} value={release}>
                {EXAM_RESULTS_RELEASE_LABELS[release]}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" size="md" disabled={submitting}>
          {submitting
            ? "Saving…"
            : mode === "edit"
              ? "Save changes"
              : "Create exam"}
        </Button>
        <Link
          href={
            cancelHref ??
            (mode === "edit" && examId ? `/teacher/exams/${examId}` : "/teacher/exams")
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
