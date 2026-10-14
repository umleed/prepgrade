"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, ConfirmDialog } from "@/components/ui";
import {
  saveAttemptAnswerAction,
  submitAttemptAction,
  syncAttemptStateAction,
} from "@/app/student/exams/actions";
import { attemptTimeRemainingMs, formatCountdown } from "@/lib/attempts";
import type { AttemptState } from "@/lib/attempts";

/**
 * The CBT exam interface (prompt 22). Reliability and answer integrity lead;
 * decoration follows. This is a CLIENT view over a SERVER-authoritative
 * attempt: the questions arrive already shuffled and stripped of any answer
 * key or explanation (lib/data/attempts.ts), the countdown is derived from the
 * stored `expiresAt` anchored to the server clock, and every answer is a
 * display index the server maps back to the canonical option itself. Nothing
 * here can grade, extend the timer, or reveal a correct answer — hiding the
 * key is the server's job, and this component never receives it (AGENTS.md §6).
 *
 * It owns exactly three hard behaviours the prompt calls out:
 *   • progressive autosave with honest saving/saved/offline/reconnecting
 *     status, retried until it lands (a dirty answer is never dropped);
 *   • recovery — the page re-runs an idempotent start on refresh, so the
 *     restored `answers` and the unchanged `expiresAt` resume the same attempt;
 *   • submit — an explicit review/confirm step plus automatic submission when
 *     the server-verified deadline passes, both routed through the idempotent
 *     server action so a double-fire cannot duplicate.
 */

type SaveStatus = "saved" | "saving" | "offline" | "reconnecting";

type AnswerState = { displayIndex: number; markedForReview: boolean };

const SAVE_PRESENTATION: Record<
  SaveStatus,
  { label: string; tone: "success" | "brand" | "warning" | "info" }
> = {
  saved: { label: "Auto-saved", tone: "success" },
  saving: { label: "Saving…", tone: "brand" },
  offline: { label: "Offline — retrying", tone: "warning" },
  reconnecting: { label: "Reconnecting…", tone: "info" },
};

export function CbtExamInterface({
  initialState,
}: {
  initialState: AttemptState;
}) {
  const router = useRouter();
  const { attemptId, questions } = initialState;

  const [answers, setAnswers] = useState<Record<string, AnswerState>>(() => {
    const map: Record<string, AnswerState> = {};
    for (const question of initialState.questions) {
      map[question.snapshotId] = { displayIndex: -1, markedForReview: false };
    }
    for (const answer of initialState.answers) {
      map[answer.snapshotId] = {
        displayIndex: answer.displayIndex,
        markedForReview: answer.markedForReview,
      };
    }
    return map;
  });
  const [index, setIndex] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [online, setOnline] = useState(
    () => typeof navigator !== "undefined" && navigator.onLine,
  );
  const [remainingMs, setRemainingMs] = useState(() =>
    attemptTimeRemainingMs(
      new Date(initialState.expiresAt).getTime(),
      new Date(initialState.serverNow).getTime(),
    ),
  );
  const [phase, setPhase] = useState<"in_exam" | "submitting" | "done">(
    initialState.status === "in_progress" ? "in_exam" : "done",
  );
  const [doneStatus, setDoneStatus] = useState<"submitted" | "expired">(
    initialState.status === "expired" ? "expired" : "submitted",
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Refs the async save/submit loops read without stale closures. They are
  // synced inside effects (never written during render — React Compiler).
  const answersRef = useRef(answers);
  const dirtyRef = useRef<Set<string>>(new Set());
  const flushingRef = useRef(false);
  const onlineRef = useRef(online);
  const submittingRef = useRef(false);
  const syncingRef = useRef(false);
  // Anchor the countdown to the SERVER clock: offset = serverNow − localNow,
  // computed lazily on the first tick (never during render) so a wrong device
  // clock or a backgrounded tab still expires on the authoritative deadline.
  const clockOffsetRef = useRef<number | null>(null);
  const expiresAtMsRef = useRef(new Date(initialState.expiresAt).getTime());

  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  useEffect(() => {
    onlineRef.current = online;
  }, [online]);

  const answeredCount = useMemo(
    () =>
      Object.values(answers).filter((answer) => answer.displayIndex >= 0).length,
    [answers],
  );
  const flaggedCount = useMemo(
    () => Object.values(answers).filter((answer) => answer.markedForReview).length,
    [answers],
  );

  const current = questions[index];

  // --- Recovery resync (prompt 23: retrieve-current-attempt) ----------------
  // When the tab regains focus or the connection returns, pull the SERVER's
  // authoritative state: the stored deadline (a backgrounded/suspended device
  // can lag its own clock), and any terminal transition made elsewhere (a
  // submit from another tab, an auto-expiry the local timer never saw).
  // Questions still dirty in the local queue are deliberately NOT overwritten
  // — they are the client's newest unsaved intent and the autosave loop will
  // land them (or be refused, which locks the UI honestly).
  async function resyncFromServer() {
    if (syncingRef.current) return;
    if (submittingRef.current || phase !== "in_exam") return;
    syncingRef.current = true;
    try {
      const result = await syncAttemptStateAction(attemptId);
      if (!result.ok) {
        // Locked or gone — stop retrying local saves; the server has said
        // this attempt is not accepting writes.
        if (result.locked) dirtyRef.current.clear();
        return;
      }
      const state = result.state;
      expiresAtMsRef.current = new Date(state.expiresAt).getTime();
      clockOffsetRef.current = new Date(state.serverNow).getTime() - Date.now();
      if (state.status !== "in_progress") {
        // A save refused mid-lock is normal; stand down the queue and show
        // the terminal screen the server actually recorded.
        dirtyRef.current.clear();
        setDoneStatus(state.status === "expired" ? "expired" : "submitted");
        setPhase("done");
        return;
      }
      const serverAnswers = new Map(
        state.answers.map((answer) => [answer.snapshotId, answer]),
      );
      setAnswers((prev) => {
        const next = { ...prev };
        for (const question of state.questions) {
          // Keep the local (possibly newer, possibly unsaved) selection when:
          // the question is dirty, or the server row carries no meaningful
          // state (unanswered and unflagged — its initial client shape already
          // agrees, and echoing it would wipe a pending local pick).
          if (dirtyRef.current.has(question.snapshotId)) continue;
          const server = serverAnswers.get(question.snapshotId);
          if (!server || (server.displayIndex < 0 && !server.markedForReview)) continue;
          const local = next[question.snapshotId];
          if (
            !local ||
            local.displayIndex !== server.displayIndex ||
            local.markedForReview !== server.markedForReview
          ) {
            next[question.snapshotId] = {
              displayIndex: server.displayIndex,
              markedForReview: server.markedForReview,
            };
          }
        }
        return next;
      });
    } finally {
      syncingRef.current = false;
    }
  }

  // --- Connection state -----------------------------------------------------
  // `online` is seeded from navigator.onLine at init; only the async browser
  // events update it here (a synchronous setOnline in the effect body is what
  // the compiler forbids, since it can cascade into extra renders). Regaining
  // connectivity or focus also triggers a server resync — the reconnect path
  // the prompt's network-retry requirement is about.
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      void resyncFromServer();
    };
    const goOffline = () => setOnline(false);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void resyncFromServer();
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId]);

  // --- Submit (explicit or auto-on-expiry), idempotent ----------------------
  // A plain function (React Compiler memoises it), declared before the
  // countdown effect so the expiry tick can call it without a forward ref.
  async function submitAttempt(auto: boolean) {
    if (submittingRef.current || phase === "done") return;
    submittingRef.current = true;
    if (!auto) setPhase("submitting");

    // Drain any pending saves first so nothing the student chose is lost.
    let guard = 0;
    while (dirtyRef.current.size > 0 && guard < 60) {
      guard += 1;
      if (!onlineRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        continue;
      }
      const snapshotId = dirtyRef.current.values().next().value as string;
      const answer = answersRef.current[snapshotId];
      try {
        const result = await saveAttemptAnswerAction(
          attemptId,
          snapshotId,
          answer.displayIndex < 0 ? null : answer.displayIndex,
          answer.markedForReview,
        );
        if (result.ok || result.locked) dirtyRef.current.delete(snapshotId);
        else await new Promise((resolve) => window.setTimeout(resolve, 400));
      } catch {
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
    }

    const result = await submitAttemptAction(attemptId);
    submittingRef.current = false;
    if (result.ok) {
      setDoneStatus(result.status === "expired" ? "expired" : "submitted");
      setPhase("done");
      setReviewOpen(false);
    } else {
      setSubmitError(result.message);
      setPhase("in_exam");
    }
  }

  // --- Countdown + server-verified auto-submit ------------------------------
  useEffect(() => {
    if (phase !== "in_exam") return;
    const tick = () => {
      if (clockOffsetRef.current === null) {
        clockOffsetRef.current =
          new Date(initialState.serverNow).getTime() - Date.now();
      }
      const serverNow = Date.now() + clockOffsetRef.current;
      const remaining = attemptTimeRemainingMs(expiresAtMsRef.current, serverNow);
      setRemainingMs(remaining);
      if (remaining <= 0) void submitAttempt(true);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // --- Progressive autosave -------------------------------------------------
  // One dirty question is flushed per tick, in order; a transient failure or
  // going offline leaves it dirty so it is retried — an answer is never lost,
  // and the "saving/saved/offline" chip reflects the real queue.
  const flushOne = useCallback(async () => {
    if (flushingRef.current || phase !== "in_exam") return;
    if (dirtyRef.current.size === 0) {
      setSaveStatus(onlineRef.current ? "saved" : "offline");
      return;
    }
    if (!onlineRef.current) {
      setSaveStatus("offline");
      return;
    }
    const snapshotId = dirtyRef.current.values().next().value as string;
    flushingRef.current = true;
    setSaveStatus("saving");
    const answer = answersRef.current[snapshotId];
    try {
      const result = await saveAttemptAnswerAction(
        attemptId,
        snapshotId,
        answer.displayIndex < 0 ? null : answer.displayIndex,
        answer.markedForReview,
      );
      if (result.ok) {
        dirtyRef.current.delete(snapshotId);
        setSaveStatus(dirtyRef.current.size > 0 ? "saving" : "saved");
      } else if (result.locked) {
        // The server says the attempt is no longer open — stop and reflect it.
        dirtyRef.current.clear();
        setDoneStatus("expired");
        setPhase("done");
      } else {
        setSaveStatus("reconnecting");
      }
    } catch {
      setSaveStatus("reconnecting");
    } finally {
      flushingRef.current = false;
    }
  }, [attemptId, phase]);

  useEffect(() => {
    if (phase !== "in_exam") return;
    const id = window.setInterval(() => void flushOne(), 1200);
    return () => window.clearInterval(id);
  }, [flushOne, phase]);

  // --- Answer + review mutations -------------------------------------------
  const selectOption = useCallback(
    (displayIndex: number) => {
      if (phase !== "in_exam" || !current) return;
      setAnswers((prev) => {
        const existing = prev[current.snapshotId];
        const next = {
          ...existing,
          displayIndex: existing.displayIndex === displayIndex ? -1 : displayIndex,
        };
        dirtyRef.current.add(current.snapshotId);
        setSaveStatus("saving");
        return { ...prev, [current.snapshotId]: next };
      });
    },
    [current, phase],
  );

  const toggleReview = useCallback(() => {
    if (phase !== "in_exam" || !current) return;
    setAnswers((prev) => {
      const existing = prev[current.snapshotId];
      const next = { ...existing, markedForReview: !existing.markedForReview };
      dirtyRef.current.add(current.snapshotId);
      setSaveStatus("saving");
      return { ...prev, [current.snapshotId]: next };
    });
  }, [current, phase]);

  // --- Keyboard navigation (prompt 22: keyboard + touch usable) -------------
  useEffect(() => {
    if (phase !== "in_exam") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "ArrowRight") setIndex((i) => Math.min(questions.length - 1, i + 1));
      else if (event.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, questions.length]);

  const save = SAVE_PRESENTATION[saveStatus];

  // --- Submitted / expired confirmation -------------------------------------
  if (phase === "done") {
    return (
      <SubmittedScreen
        examTitle={initialState.examTitle}
        status={doneStatus}
        answeredCount={answeredCount}
        totalQuestions={initialState.totalQuestions}
        onExit={() => router.push("/student/exams")}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas">
      <ExamHeader
        examTitle={initialState.examTitle}
        saveLabel={save.label}
        saveTone={save.tone}
        online={online}
        remainingMs={remainingMs}
        durationMinutes={initialState.durationMinutes}
        onExit={() => setReviewOpen(true)}
      />

      <div className="flex flex-1 overflow-hidden">
        <QuestionNavigator
          questions={questions}
          answers={answers}
          index={index}
          answeredCount={answeredCount}
          flaggedCount={flaggedCount}
          totalMarks={initialState.totalMarks}
          onSelect={setIndex}
        />

        <main className="flex flex-1 flex-col overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-5 py-6">
            {submitError ? (
              <Alert variant="danger" title="Submission didn't go through">
                {submitError} Your answers are saved — try submitting again.
              </Alert>
            ) : null}
            {!online ? (
              <Alert variant="warning" title="You're offline">
                Keep working — your answers are held on this device and will
                upload automatically the moment your connection returns. Don&apos;t
                close this tab.
              </Alert>
            ) : null}

            {current ? (
              <QuestionCard
                question={current}
                answer={answers[current.snapshotId]}
                number={index + 1}
                total={questions.length}
                disabled={phase !== "in_exam"}
                onSelect={selectOption}
                onToggleReview={toggleReview}
              />
            ) : (
              <Alert variant="info" title="No questions to display">
                This exam didn&apos;t deliver any questions. Return to My Exams and
                contact your institution if this persists.
              </Alert>
            )}

            <div className="mt-auto flex items-center justify-between gap-3 pt-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={index === 0}
              >
                ← Previous
              </Button>
              {index < questions.length - 1 ? (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => setIndex((i) => Math.min(questions.length - 1, i + 1))}
                >
                  Next →
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => setReviewOpen(true)}
                >
                  Review &amp; submit
                </Button>
              )}
            </div>
          </div>
        </main>
      </div>

      <ConfirmDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        title="Submit your exam?"
        tone="primary"
        confirmLabel={phase === "submitting" ? "Submitting…" : "Submit exam"}
        cancelLabel="Keep working"
        onConfirm={() => void submitAttempt(false)}
        description={
          <div className="flex flex-col gap-3">
            <p>
              You&apos;ve answered{" "}
              <span className="font-semibold text-ink">
                {answeredCount} of {questions.length}
              </span>{" "}
              questions
              {flaggedCount > 0 ? (
                <>
                  {" "}
                  and flagged <span className="font-semibold text-ink">{flaggedCount}</span>{" "}
                  for review
                </>
              ) : null}
              . Once you submit, your answers are locked and can&apos;t be changed.
            </p>
            {answeredCount < questions.length ? (
              <Alert variant="warning" title="Unanswered questions">
                {questions.length - answeredCount} question
                {questions.length - answeredCount === 1 ? "" : "s"} still have no
                answer. You can go back to them, or submit now.
              </Alert>
            ) : null}
            <p className="text-2xs text-ink-subtle">
              Grading happens on the server after you submit; your result appears
              once your institution releases it.
            </p>
          </div>
        }
      />
    </div>
  );
}

// --- Sub-views ---------------------------------------------------------------

function ExamHeader({
  examTitle,
  saveLabel,
  saveTone,
  online,
  remainingMs,
  durationMinutes,
  onExit,
}: {
  examTitle: string;
  saveLabel: string;
  saveTone: "success" | "brand" | "warning" | "info";
  online: boolean;
  remainingMs: number;
  durationMinutes: number;
  onExit: () => void;
}) {
  const lowTime = remainingMs <= 5 * 60_000;
  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
      <div className="min-w-0">
        <p className="truncate text-base font-bold tracking-tight text-ink">
          {examTitle}
        </p>
        <p className="truncate text-xs text-ink-subtle">Computer-Based Test</p>
      </div>
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${online ? "bg-success" : "bg-warning"}`}
          />
          {saveLabel}
        </span>
        <Badge tone={saveTone}>{saveLabel}</Badge>
        <div
          className="flex flex-col items-end"
          role="timer"
          aria-live="off"
          aria-label={`${formatCountdown(remainingMs)} of ${durationMinutes} minutes remaining`}
        >
          <span
            className={`text-2xl font-bold tabular-nums tracking-tight ${
              lowTime ? "text-danger" : "text-ink"
            }`}
          >
            {formatCountdown(remainingMs)}
          </span>
          <span className="text-2xs uppercase tracking-wide text-ink-subtle">
            Time remaining
          </span>
        </div>
        <Button type="button" variant="danger" size="sm" onClick={onExit}>
          Exit &amp; submit
        </Button>
      </div>
    </header>
  );
}

function QuestionNavigator({
  questions,
  answers,
  index,
  answeredCount,
  flaggedCount,
  totalMarks,
  onSelect,
}: {
  questions: AttemptState["questions"];
  answers: Record<string, AnswerState>;
  index: number;
  answeredCount: number;
  flaggedCount: number;
  totalMarks: number;
  onSelect: (index: number) => void;
}) {
  const percent =
    questions.length > 0
      ? Math.round((answeredCount / questions.length) * 100)
      : 0;
  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto border-r border-border bg-surface px-4 py-5 lg:flex">
      <div>
        <h2 className="mb-2 text-sm font-semibold text-ink">Question Navigator</h2>
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-ink-muted">
          <li className="flex items-center gap-1">
            <span className="h-3 w-3 rounded bg-success-soft ring-1 ring-success-border" />
            Answered
          </li>
          <li className="flex items-center gap-1">
            <span className="h-3 w-3 rounded bg-brand" />
            Current
          </li>
          <li className="flex items-center gap-1">
            <span className="h-3 w-3 rounded bg-warning-soft ring-1 ring-warning-border" />
            Review
          </li>
          <li className="flex items-center gap-1">
            <span className="h-3 w-3 rounded border border-border bg-surface" />
            Not answered
          </li>
        </ul>
        <div className="grid grid-cols-6 gap-1.5">
          {questions.map((question, position) => {
            const answer = answers[question.snapshotId];
            const isAnswered = answer && answer.displayIndex >= 0;
            const isFlagged = answer && answer.markedForReview;
            const isCurrent = position === index;
            const tone = isCurrent
              ? "bg-brand text-white border-brand"
              : isFlagged
                ? "bg-warning-soft text-warning-strong border-warning-border"
                : isAnswered
                  ? "bg-success-soft text-success-strong border-success-border"
                  : "bg-surface text-ink-muted border-border";
            return (
              <button
                key={question.snapshotId}
                type="button"
                onClick={() => onSelect(position)}
                aria-current={isCurrent ? "true" : undefined}
                aria-label={`Question ${position + 1}${isAnswered ? ", answered" : ""}${
                  isFlagged ? ", marked for review" : ""
                }`}
                className={`h-8 rounded-md border text-xs font-semibold tabular-nums transition-colors hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand ${tone}`}
              >
                {position + 1}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-sm">
          <span className="font-semibold text-ink">Progress</span>
          <span className="tabular-nums text-ink-muted">{percent}%</span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
          role="progressbar"
          aria-valuenow={answeredCount}
          aria-valuemin={0}
          aria-valuemax={questions.length}
          aria-label={`${answeredCount} of ${questions.length} answered`}
        >
          <div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-1 text-2xs text-ink-subtle">
          {answeredCount} of {questions.length} answered · {flaggedCount} flagged ·{" "}
          {totalMarks} marks total
        </p>
      </div>

      <div className="mt-auto rounded-lg border border-warning-border bg-warning-soft p-3">
        <p className="mb-1 text-xs font-semibold text-warning-strong">Important notes</p>
        <ul className="flex flex-col gap-1 text-2xs leading-4 text-ink-muted">
          <li>· Your answers save automatically as you go.</li>
          <li>· Don&apos;t close this tab until you&apos;ve submitted.</li>
          <li>· Explanations and results appear only after release.</li>
        </ul>
      </div>
    </aside>
  );
}

function QuestionCard({
  question,
  answer,
  number,
  total,
  disabled,
  onSelect,
  onToggleReview,
}: {
  question: AttemptState["questions"][number];
  answer: AnswerState | undefined;
  number: number;
  total: number;
  disabled: boolean;
  onSelect: (displayIndex: number) => void;
  onToggleReview: () => void;
}) {
  const selected = answer?.displayIndex ?? -1;
  const flagged = answer?.markedForReview ?? false;
  return (
    <div className="flex flex-col gap-4 rounded-card border border-border bg-surface p-6 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold tracking-tight text-ink">
          Question {number} of {total}
        </h1>
        <div className="flex items-center gap-2">
          <Badge tone="neutral">{question.marks} mark{question.marks === 1 ? "" : "s"}</Badge>
          <Badge tone="info" className="capitalize">
            {question.difficulty}
          </Badge>
          <Button
            type="button"
            variant={flagged ? "primary" : "secondary"}
            size="sm"
            onClick={onToggleReview}
            disabled={disabled}
            aria-pressed={flagged}
          >
            {flagged ? "★ Marked" : "☆ Mark for review"}
          </Button>
        </div>
      </div>

      <p className="text-base leading-7 text-ink">{question.questionText}</p>

      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Answer options">
        {question.options.map((option) => {
          const isSelected = selected === option.displayIndex;
          return (
            <button
              key={option.displayIndex}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={disabled}
              onClick={() => onSelect(option.displayIndex)}
              className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed ${
                isSelected
                  ? "border-brand bg-brand-50 text-ink ring-1 ring-brand"
                  : "border-border bg-surface text-ink hover:border-border-strong hover:bg-surface-muted"
              }`}
            >
              <span
                aria-hidden="true"
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  isSelected ? "bg-brand text-white" : "bg-surface-muted text-ink-muted"
                }`}
              >
                {String.fromCharCode(65 + option.displayIndex)}
              </span>
              <span className="leading-6">{option.text}</span>
            </button>
          );
        })}
      </div>

      <p className="flex items-center gap-2 rounded-lg bg-surface-muted px-3 py-2 text-2xs text-ink-subtle">
        <span aria-hidden="true">🔒</span>
        The correct answer and explanation stay hidden until after your
        institution releases results.
      </p>
    </div>
  );
}

function SubmittedScreen({
  examTitle,
  status,
  answeredCount,
  totalQuestions,
  onExit,
}: {
  examTitle: string;
  status: "submitted" | "expired";
  answeredCount: number;
  totalQuestions: number;
  onExit: () => void;
}) {
  const expired = status === "expired";
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-5 py-10">
      <div className="w-full max-w-lg rounded-card border border-border bg-surface p-8 text-center shadow-card">
        <div
          className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full ${
            expired ? "bg-warning-soft" : "bg-success-soft"
          }`}
          aria-hidden="true"
        >
          <span className="text-2xl">{expired ? "⏱" : "✓"}</span>
        </div>
        <h1 className="text-xl font-bold tracking-tight text-ink">
          {expired ? "Time expired — attempt closed" : "Exam submitted"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-ink-muted">
          {expired
            ? "Your time ran out and your answers were saved and locked automatically."
            : "Your answers have been recorded and locked. You can't change them now."}{" "}
          You answered {answeredCount} of {totalQuestions} questions on{" "}
          <span className="font-medium text-ink">{examTitle}</span>.
        </p>
        <p className="mt-3 text-2xs text-ink-subtle">
          Grading is done on the server. Your result will appear in My Exams
          once your institution releases it.
        </p>
        <div className="mt-6 flex justify-center">
          <Button type="button" variant="primary" onClick={onExit}>
            Back to My Exams
          </Button>
        </div>
      </div>
    </div>
  );
}
