"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Alert,
  Badge,
  Button,
  Card,
  Input,
  Radio,
  Select,
  Textarea,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  optionLabel,
  QUESTION_DIFFICULTIES,
  QUESTION_DIFFICULTY_LABELS,
  QUESTION_PROVENANCES,
  QUESTION_PROVENANCE_LABELS,
  QUESTION_INPUT_EMPTY,
  QUESTION_TEXT_MAX_LENGTH,
  QUESTION_TYPE_LABELS,
  EXPLANATION_MAX_LENGTH,
  OPTION_MAX_COUNT,
  OPTION_MIN_COUNT,
  OPTION_TEXT_MAX_LENGTH,
  validateQuestion,
  type QuestionErrors,
  type QuestionInput,
} from "@/lib/questions";
import { createQuestionAction, updateQuestionAction } from "./actions";

type SubjectOption = { id: string; name: string };
type TopicOption = { id: string; name: string; subjectId: string; parentId: string | null };
type CategoryOption = { id: string; name: string };

/**
 * Shared create/edit question form (prompt 16), laid out to the
 * Create_Question_screen design: numbered authoring sections on the left and
 * a live exam-style preview on the right. Runs the same pure validator the
 * server uses for instant feedback, then calls the matching server action,
 * which re-validates and re-checks tenancy and the subject/topic/category
 * links authoritatively. `subjects`/`topics`/`categories` are assembled
 * server-side from the caller's visible catalogue; with the data source
 * unreachable the page still renders the form (empty pickers) so the honest
 * state matches the rest of the bank.
 *
 * The correct-answer radio is the answer key — it is only ever sent to the
 * server (never rendered to students), and the server stores it as an index
 * into the option array so the mapping can't drift (AGENTS.md §6). The
 * preview shows the teacher exactly what a student would see (plus the key,
 * which the student-side CBT screen withholds until results are released).
 *
 * Editing a question whose MEANING changes (text, options, key, marks, type)
 * archives the pre-edit content as a version snapshot server-side before the
 * update lands — the note below tells the teacher that honestly.
 */
export function QuestionForm({
  mode,
  questionId,
  subjects,
  topics,
  categories,
  initial,
  afterSaveHref,
  cancelHref,
}: {
  mode: "create" | "edit";
  questionId?: string;
  subjects: SubjectOption[];
  topics: TopicOption[];
  categories: CategoryOption[];
  initial?: QuestionInput;
  /**
   * Where to send the user after a successful save. Defaults to the shared
   * question detail (`/teacher/questions/{id}`). The institution-owned create
   * page passes an `/institution/question-bank` destination so an admin never
   * leaves the Institution shell to add a question. Must be a plain string —
   * server components cannot pass functions to this client form.
   */
  afterSaveHref?: string;
  /** Where Cancel returns to. Defaults to the teaching question bank. */
  cancelHref?: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<QuestionInput>(initial ?? QUESTION_INPUT_EMPTY);
  const [errors, setErrors] = useState<QuestionErrors>({});
  const [message, setMessage] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const subjectTopics = topics.filter((topic) => topic.id && topic.subjectId === values.subjectId);

  function setField<K extends keyof QuestionInput>(key: K, value: QuestionInput[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function changeSubject(subjectId: string) {
    // Drop a topic that no longer belongs to the newly chosen subject so the
    // payload never carries a stale, mismatched link.
    setValues((prev) => ({
      ...prev,
      subjectId,
      topicId: topics.some((t) => t.id === prev.topicId && t.subjectId === subjectId)
        ? prev.topicId
        : "",
    }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next.subjectId;
      delete next.topicId;
      return next;
    });
  }

  function setOption(index: number, text: string) {
    setValues((prev) => {
      const options = [...prev.options];
      options[index] = text;
      return { ...prev, options };
    });
    setErrors((prev) => {
      if (!prev.options) return prev;
      const next = { ...prev };
      delete next.options;
      return next;
    });
  }

  function addOption() {
    setValues((prev) =>
      prev.options.length >= OPTION_MAX_COUNT
        ? prev
        : { ...prev, options: [...prev.options, ""] },
    );
  }

  function removeOption(index: number) {
    setValues((prev) => {
      if (prev.options.length <= OPTION_MIN_COUNT) return prev;
      const options = prev.options.filter((_, i) => i !== index);
      // Keep the answer key pointing at a real option after the shift.
      let correctOptionIndex = prev.correctOptionIndex;
      if (index === prev.correctOptionIndex) correctOptionIndex = 0;
      else if (index < prev.correctOptionIndex) correctOptionIndex -= 1;
      return { ...prev, options, correctOptionIndex };
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // Client-side gate for UX; the server action repeats this authoritatively.
    const clientErrors = validateQuestion(values);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }

    setErrors({});
    setMessage(undefined);
    setSubmitting(true);
    try {
      const result =
        mode === "edit" && questionId
          ? await updateQuestionAction(questionId, values)
          : await createQuestionAction(values);

      if (result.ok && result.id) {
        router.push(afterSaveHref ?? `/teacher/questions/${result.id}`);
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
    <form
      onSubmit={handleSubmit}
      noValidate
      className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]"
    >
      {/* --- Authoring sections --- */}
      <div className="flex min-w-0 flex-col gap-6">
        {message ? (
          <Alert variant="danger" title="Couldn't save this question">
            {message}
          </Alert>
        ) : null}

        {mode === "edit" ? (
          <Alert variant="info" title="Editing keeps history">
            If this change alters the question&apos;s meaning — its wording,
            options, correct answer, or marks — the current content is saved
            to the question&apos;s version history before the change is
            applied.
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
                Select the subject, topic and set the main details for this
                question.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Select
                label="Subject"
                name="subjectId"
                placeholder="Choose a subject"
                value={values.subjectId}
                onChange={(e) => changeSubject(e.target.value)}
                error={errors.subjectId}
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
                label="Topic"
                name="topicId"
                value={values.topicId}
                onChange={(e) => setField("topicId", e.target.value)}
                error={errors.topicId}
                description={
                  values.subjectId
                    ? "Optional. Includes subtopics under this subject."
                    : "Choose a subject to see its topics."
                }
              >
                <option value="">No topic</option>
                {subjectTopics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.parentId ? `— ${topic.name}` : topic.name}
                  </option>
                ))}
              </Select>

              <Select
                label="Difficulty"
                name="difficulty"
                value={values.difficulty}
                onChange={(e) => setField("difficulty", e.target.value as QuestionInput["difficulty"])}
                error={errors.difficulty}
              >
                {QUESTION_DIFFICULTIES.map((value) => (
                  <option key={value} value={value}>
                    {QUESTION_DIFFICULTY_LABELS[value]}
                  </option>
                ))}
              </Select>

              <Select
                label="Question type"
                name="questionType"
                // The MVP grades one type only; the picker exists so the
                // author sees the constraint instead of wondering. The value
                // never changes, and the server refuses anything else.
                value={values.questionType}
                onChange={() => undefined}
                error={errors.questionType}
                description="Only multiple choice is supported right now."
              >
                <option value="mcq_single">{QUESTION_TYPE_LABELS.mcq_single}</option>
              </Select>

              <Select
                label="Exam category"
                name="categoryId"
                value={values.categoryId}
                onChange={(e) => setField("categoryId", e.target.value)}
                error={errors.categoryId}
                description="Optional. Which examination this is prepared for."
              >
                <option value="">Inherit from subject</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>

              <Input
                label="Marks"
                name="marks"
                type="number"
                min={1}
                max={50}
                value={String(values.marks)}
                onChange={(e) => setField("marks", Number.parseInt(e.target.value, 10) || 0)}
                error={errors.marks}
              />
            </div>
          </div>
        </Card>

        {/* 2. Question content */}
        <Card>
          <div className="flex flex-col gap-4 p-6">
            <div>
              <h2 className="text-base font-semibold text-ink">
                2. Question content
              </h2>
              <p className="mt-0.5 text-sm text-ink-muted">
                Write the question clearly and accurately.
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Textarea
                label="Question text"
                name="questionText"
                rows={4}
                description="The prompt students see during the exam."
                value={values.questionText}
                onChange={(e) => setField("questionText", e.target.value)}
                error={errors.questionText}
                maxLength={QUESTION_TEXT_MAX_LENGTH}
                required
              />
              <p className="text-right text-2xs text-ink-subtle" aria-hidden="true">
                {values.questionText.length}/{QUESTION_TEXT_MAX_LENGTH} characters
              </p>
            </div>
          </div>
        </Card>

        {/* 3. Answer options */}
        <Card>
          <div className="flex flex-col gap-4 p-6">
            <div>
              <h2 className="text-base font-semibold text-ink">
                3. Answer options
              </h2>
              <p className="mt-0.5 text-sm text-ink-muted">
                Add the answer options and mark the single correct answer.
                Provide {OPTION_MIN_COUNT}–{OPTION_MAX_COUNT} options.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              {values.options.map((option, index) => (
                <div key={index} className="flex items-center gap-3">
                  <Radio
                    name="correctOptionIndex"
                    label={optionLabel(index)}
                    checked={values.correctOptionIndex === index}
                    onChange={() => setField("correctOptionIndex", index)}
                    description="Mark correct"
                  />
                  <Input
                    aria-label={`Option ${optionLabel(index)}`}
                    className="flex-1"
                    value={option}
                    onChange={(e) => setOption(index, e.target.value)}
                    maxLength={OPTION_TEXT_MAX_LENGTH}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeOption(index)}
                    disabled={values.options.length <= OPTION_MIN_COUNT}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>

            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={addOption}
                disabled={values.options.length >= OPTION_MAX_COUNT}
              >
                + Add option
              </Button>
            </div>

            {errors.options || errors.correctOptionIndex ? (
              <p className="text-sm text-danger-strong" role="alert">
                {errors.options ?? errors.correctOptionIndex}
              </p>
            ) : null}
          </div>
        </Card>

        {/* 4. Explanation */}
        <Card>
          <div className="flex flex-col gap-4 p-6">
            <div>
              <h2 className="text-base font-semibold text-ink">
                4. Explanation <span className="font-normal text-ink-subtle">(optional)</span>
              </h2>
              <p className="mt-0.5 text-sm text-ink-muted">
                Provide a clear explanation for the correct answer. This will
                help students learn from their mistakes.
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Textarea
                label="Explanation"
                name="explanation"
                rows={3}
                description="Shown with the answer after results are released."
                value={values.explanation}
                onChange={(e) => setField("explanation", e.target.value)}
                error={errors.explanation}
                maxLength={EXPLANATION_MAX_LENGTH}
              />
              <p className="text-right text-2xs text-ink-subtle" aria-hidden="true">
                {values.explanation.length}/{EXPLANATION_MAX_LENGTH} characters
              </p>
            </div>
            <Input
              label="Learning objective"
              name="learningObjective"
              value={values.learningObjective}
              onChange={(e) => setField("learningObjective", e.target.value)}
              error={errors.learningObjective}
              maxLength={300}
            />
          </div>
        </Card>

        {/* 5. Source & licensing (metadata) */}
        <Card>
          <div className="flex flex-col gap-4 p-6">
            <div>
              <h2 className="text-base font-semibold text-ink">
                5. Source &amp; licensing <span className="font-normal text-ink-subtle">(optional)</span>
              </h2>
              <p className="mt-0.5 text-sm text-ink-muted">
                Record where permitted content came from (AGENTS.md §7). Leave
                as &quot;Created by your institution&quot; for original
                questions.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Select
                label="Provenance"
                name="provenance"
                value={values.provenance}
                onChange={(e) => setField("provenance", e.target.value as QuestionInput["provenance"])}
                error={errors.provenance}
              >
                {QUESTION_PROVENANCES.map((value) => (
                  <option key={value} value={value}>
                    {QUESTION_PROVENANCE_LABELS[value]}
                  </option>
                ))}
              </Select>
              <Input
                label="Source label"
                name="sourceLabel"
                value={values.sourceLabel}
                onChange={(e) => setField("sourceLabel", e.target.value)}
                error={errors.sourceLabel}
                placeholder="e.g. WAEC 2019"
                maxLength={120}
              />
              <Input
                label="Source year"
                name="sourceYear"
                inputMode="numeric"
                value={values.sourceYear}
                onChange={(e) => setField("sourceYear", e.target.value)}
                error={errors.sourceYear}
                placeholder="e.g. 2019"
              />
              <Input
                label="License notes"
                name="licenseNotes"
                value={values.licenseNotes}
                onChange={(e) => setField("licenseNotes", e.target.value)}
                error={errors.licenseNotes}
                maxLength={500}
              />
            </div>
          </div>
        </Card>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" variant="primary" size="md" disabled={submitting}>
            {submitting
              ? "Saving…"
              : mode === "edit"
                ? "Save changes"
                : "Add question"}
          </Button>
          <Link
            href={
              cancelHref ??
              (mode === "edit" && questionId
                ? `/teacher/questions/${questionId}`
                : "/teacher/questions")
            }
          >
            <Button type="button" variant="secondary" size="md">
              Cancel
            </Button>
          </Link>
        </div>
      </div>

      {/* --- Live exam-style preview --- */}
      <div className="lg:sticky lg:top-0">
        <QuestionPreview values={values} />
      </div>
    </form>
  );
}

/**
 * What the author is building, rendered the way the CBT interface will show
 * it (prompt 22): badges for type and difficulty, the prompt, lettered
 * options with the marked answer highlighted, and the explanation. The
 * correct-answer callout is a teacher-side aid — students never see the key
 * during an exam (AGENTS.md §6). Empty inputs render as honest placeholders
 * rather than being hidden, so the preview always reflects the real shape of
 * the question.
 */
function QuestionPreview({ values }: { values: QuestionInput }) {
  const text = values.questionText.trim();
  const correctOption = values.options[values.correctOptionIndex]?.trim();
  const explanation = values.explanation.trim();

  return (
    <Card>
      <div
        role="region"
        aria-label="Question preview"
        className="flex flex-col gap-4 p-5"
      >
        <h2 className="text-base font-semibold text-ink">Question Preview</h2>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">{QUESTION_TYPE_LABELS.mcq_single}</Badge>
          <Badge tone="warning">
            {QUESTION_DIFFICULTY_LABELS[values.difficulty] ?? values.difficulty}
          </Badge>
          <Badge tone="neutral">
            {values.marks} {values.marks === 1 ? "mark" : "marks"}
          </Badge>
        </div>

        {text ? (
          <p className="whitespace-pre-wrap text-sm font-medium leading-6 text-ink">
            {text}
          </p>
        ) : (
          <p className="text-sm italic text-ink-subtle">
            The question text appears here as students will see it.
          </p>
        )}

        <ol className="flex flex-col gap-2">
          {values.options.map((option, index) => {
            const trimmed = option.trim();
            const isCorrect = index === values.correctOptionIndex;
            return (
              <li
                key={index}
                className={cn(
                  "flex items-start gap-2.5 rounded-field border px-3 py-2 text-sm",
                  isCorrect
                    ? "border-brand-300 bg-brand-50"
                    : "border-border bg-surface",
                )}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold",
                    isCorrect ? "bg-brand text-white" : "bg-surface-muted text-ink-muted",
                  )}
                  aria-hidden="true"
                >
                  {optionLabel(index)}
                </span>
                <span className={cn("min-w-0 flex-1", trimmed ? "text-ink" : "italic text-ink-subtle")}>
                  {trimmed || "Empty option"}
                </span>
                {isCorrect ? (
                  <span className="shrink-0 text-2xs font-semibold text-brand-700">
                    Correct
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>

        {correctOption ? (
          <p className="rounded-field border border-success-border bg-success-soft px-3 py-2 text-sm text-success-strong">
            <span className="font-semibold">Correct answer:</span>{" "}
            {optionLabel(values.correctOptionIndex)}. {correctOption}
          </p>
        ) : (
          <p className="text-2xs text-ink-subtle">
            Mark which option is the correct answer.
          </p>
        )}

        {explanation ? (
          <div className="rounded-card border border-border bg-surface-muted p-3">
            <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">
              Explanation
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink">
              {explanation}
            </p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
