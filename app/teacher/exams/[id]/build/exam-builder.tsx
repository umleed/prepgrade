"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Button,
  ConfirmDialog,
  Input,
} from "@/components/ui";
import {
  EXAM_QUESTION_MARKS_MAX,
  EXAM_QUESTION_MARKS_MIN,
  examQuestionMarksError,
} from "@/lib/exams";
import {
  addExamQuestionAction,
  moveExamQuestionAction,
  removeExamQuestionAction,
  setExamQuestionMarksAction,
} from "../../actions";

/**
 * Interactive halves of the exam builder (prompt 18): the selected-question
 * list (re-mark, reorder, remove) and the bank picker's Add button. All
 * mutations call the tenant-scoped server actions, which re-check the
 * exam's status authoritatively — hiding these controls on a published exam
 * is presentation, the refusal lives on the server (AGENTS.md §5, §6).
 * Rows carry truncated excerpts only: full question content, options, and
 * answer keys stay in server-rendered HTML (the preview), never in props a
 * client component could receive.
 */

export type SelectedQuestionRow = {
  questionId: string;
  position: number;
  marks: number;
  excerpt: string;
  difficulty: string;
  /** Live bank status; archived rows are flagged and block publishing. */
  bankStatus: "active" | "archived" | null;
};

export type BankQuestionRow = {
  questionId: string;
  excerpt: string;
  subjectName: string;
  difficulty: string;
  marks: number;
  /** Already part of this exam — the Add button reads as a fact, not a no-op. */
  inExam: boolean;
};

const DIFFICULTY_LABELS: Record<string, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export function SelectedQuestionList({
  examId,
  rows,
  editable,
}: {
  examId: string;
  rows: SelectedQuestionRow[];
  editable: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [markDrafts, setMarkDrafts] = useState<Record<string, string>>({});
  const [pendingRemove, setPendingRemove] = useState<SelectedQuestionRow | null>(
    null,
  );

  async function run(questionId: string, action: () => Promise<{ ok: boolean; message?: string }>) {
    setError(undefined);
    setBusyId(questionId);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.message ?? "We couldn't update this exam. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("We couldn't update this exam. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function saveMarks(row: SelectedQuestionRow) {
    const raw = markDrafts[row.questionId] ?? String(row.marks);
    const marks = Number.parseInt(raw, 10);
    const invalid = examQuestionMarksError(
      Number.isFinite(marks) ? marks : Number.NaN,
    );
    if (invalid) {
      setError(invalid);
      return;
    }
    setMarkDrafts((prev) => {
      const next = { ...prev };
      delete next[row.questionId];
      return next;
    });
    await run(row.questionId, () =>
      setExamQuestionMarksAction(examId, row.questionId, marks),
    );
  }

  async function confirmRemove() {
    if (!pendingRemove) return;
    const id = pendingRemove.questionId;
    setPendingRemove(null);
    await run(id, () => removeExamQuestionAction(examId, id));
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No questions selected yet. Add them from the question bank below —
        an exam needs at least one question before it can be published.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Alert variant="danger" title="Update failed">
          {error}
        </Alert>
      ) : null}
      <ol className="flex flex-col gap-2">
        {rows.map((row, index) => {
          const busy = busyId === row.questionId;
          const draft = markDrafts[row.questionId];
          return (
            <li
              key={row.questionId}
              className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-canvas px-3 py-2.5"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface text-xs font-semibold tabular-nums text-ink-muted">
                {row.position}
              </span>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm text-ink">{row.excerpt}</p>
                <p className="mt-0.5 text-2xs uppercase tracking-wide text-ink-subtle">
                  {DIFFICULTY_LABELS[row.difficulty] ?? row.difficulty}
                  {row.bankStatus === "archived" ? (
                    <span className="ml-2 normal-case text-warning-strong">
                      Archived in the bank — remove it or restore it before publishing.
                    </span>
                  ) : null}
                </p>
              </div>
              {editable ? (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="w-24">
                    <Input
                      aria-label={`Marks for question ${row.position}`}
                      type="number"
                      min={EXAM_QUESTION_MARKS_MIN}
                      max={EXAM_QUESTION_MARKS_MAX}
                      value={draft ?? String(row.marks)}
                      onChange={(e) =>
                        setMarkDrafts((prev) => ({
                          ...prev,
                          [row.questionId]: e.target.value,
                        }))
                      }
                      disabled={busy}
                    />
                  </div>
                  {draft !== undefined ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void saveMarks(row)}
                    >
                      Save
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy || index === 0}
                    onClick={() =>
                      void run(row.questionId, () =>
                        moveExamQuestionAction(examId, row.questionId, "up"),
                      )
                    }
                  >
                    ↑ Up
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy || index === rows.length - 1}
                    onClick={() =>
                      void run(row.questionId, () =>
                        moveExamQuestionAction(examId, row.questionId, "down"),
                      )
                    }
                  >
                    ↓ Down
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={busy}
                    onClick={() => setPendingRemove(row)}
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <span className="text-sm tabular-nums text-ink-muted">
                  {row.marks} mark{row.marks === 1 ? "" : "s"}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {pendingRemove ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingRemove(null);
          }}
          tone="danger"
          confirmLabel="Remove"
          title="Remove this question from the exam?"
          description={`“${pendingRemove.excerpt}” leaves this exam's selection (its later order closes up). The question itself stays in your bank untouched.`}
          onConfirm={() => void confirmRemove()}
        />
      ) : null}
    </div>
  );
}

export function BankQuestionRows({
  examId,
  rows,
  editable,
}: {
  examId: string;
  rows: BankQuestionRow[];
  editable: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function add(questionId: string) {
    setError(undefined);
    setBusyId(questionId);
    try {
      const result = await addExamQuestionAction(examId, questionId);
      if (!result.ok) {
        setError(result.message ?? "We couldn't add that question. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("We couldn't add that question. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Alert variant="danger" title="Couldn't add question">
          {error}
        </Alert>
      ) : null}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.questionId}
            className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-canvas px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-sm text-ink">{row.excerpt}</p>
              <p className="mt-0.5 text-2xs uppercase tracking-wide text-ink-subtle">
                {row.subjectName} · {DIFFICULTY_LABELS[row.difficulty] ?? row.difficulty} · {row.marks} mark{row.marks === 1 ? "" : "s"}
              </p>
            </div>
            {!editable ? (
              <span className="text-xs text-ink-subtle">
                Question set is frozen — this exam is no longer editable.
              </span>
            ) : row.inExam ? (
              <span className="text-xs font-medium text-success-strong">
                Already in this exam
              </span>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busyId === row.questionId}
                onClick={() => void add(row.questionId)}
              >
                {busyId === row.questionId ? "Adding…" : "Add to exam"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
