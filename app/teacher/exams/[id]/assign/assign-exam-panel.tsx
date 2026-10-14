"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Input,
  Select,
  Tabs,
} from "@/components/ui";
import {
  examEffectiveStudentCount,
  examPublishBlocker,
  formatDuration,
  type ExamStatus,
} from "@/lib/exams";
import { setExamAudienceAction, setExamStatusAction } from "../../actions";

/**
 * Assignment & publishing panel (prompt 19) — the design's "Assign to
 * Students" step rendered as a focused flow on the exam. Teachers pick
 * whole classes, individual students, or a combination; the Review tab is
 * the confirmation step that summarises WHO receives the exam and WHEN it
 * is available before anything is released.
 *
 * Presentation only: the checkboxes narrow choices, but the server
 * re-validates every id, the exam's status, the schedule, and the audience
 * on save and again at publish (AGENTS.md §5). "Publish exam" saves the
 * audience first and only then requests the transition — and the
 * transition is gated by the SAME pure `examPublishBlocker` the server
 * uses, so the button can never offer a publish the backend would refuse.
 */

export type AssignableClassOption = {
  id: string;
  name: string;
  academicSessionName: string | null;
  studentCount: number;
  assignedExamCount: number;
};

export type AssignableStudentOption = {
  id: string;
  fullName: string;
  studentCode: string;
  classId: string | null;
};

export type AssignExamInfo = {
  id: string;
  title: string;
  subjectName: string;
  durationMinutes: number;
  maxAttempts: number;
  questionCount: number;
  totalMarks: number;
  startsAt: string | null;
  endsAt: string | null;
  status: ExamStatus;
};

type Props = {
  exam: AssignExamInfo;
  classes: AssignableClassOption[];
  students: AssignableStudentOption[];
  initialClassIds: string[];
  initialStudentIds: string[];
};

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

export function AssignExamPanel({
  exam,
  classes,
  students,
  initialClassIds,
  initialStudentIds,
}: Props) {
  const router = useRouter();
  const [classQuery, setClassQuery] = useState("");
  const [studentQuery, setStudentQuery] = useState("");
  const [studentClassFilter, setStudentClassFilter] = useState("");
  const [selectedClasses, setSelectedClasses] = useState<Set<string>>(
    () => new Set(initialClassIds),
  );
  const [selectedStudents, setSelectedStudents] = useState<Set<string>>(
    () => new Set(initialStudentIds),
  );
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);

  const studentById = useMemo(
    () => new Map(students.map((student) => [student.id, student])),
    [students],
  );
  const classById = useMemo(
    () => new Map(classes.map((entry) => [entry.id, entry])),
    [classes],
  );

  const filteredClasses = useMemo(() => {
    const query = classQuery.trim().toLowerCase();
    if (!query) return classes;
    return classes.filter(
      (entry) =>
        entry.name.toLowerCase().includes(query) ||
        (entry.academicSessionName ?? "").toLowerCase().includes(query),
    );
  }, [classes, classQuery]);

  const filteredStudents = useMemo(() => {
    const query = studentQuery.trim().toLowerCase();
    return students.filter((student) => {
      if (studentClassFilter && student.classId !== studentClassFilter) {
        return false;
      }
      if (!query) return true;
      return (
        student.fullName.toLowerCase().includes(query) ||
        student.studentCode.toLowerCase().includes(query)
      );
    });
  }, [students, studentQuery, studentClassFilter]);

  // The deduplicated audience, computed with the SAME pure helper the
  // server stamps `published_to` from — the confirmation numbers are the
  // server's numbers, not a client-side guess.
  const audience = useMemo(() => {
    const rosterStudentIds = new Set<string>();
    for (const classId of selectedClasses) {
      for (const student of students) {
        if (student.classId === classId) rosterStudentIds.add(student.id);
      }
    }
    const directIds = [...selectedStudents];
    const overlap = directIds.filter((id) => rosterStudentIds.has(id)).length;
    // Roster counts come from the server-side live counts (the picker only
    // carries a bounded sample of students), so per-class totals are the
    // source of truth for "students in class".
    const classStudentTotal = [...selectedClasses].reduce(
      (sum, id) => sum + (classById.get(id)?.studentCount ?? 0),
      0,
    );
    const effective = examEffectiveStudentCount({
      classStudentCount: classStudentTotal,
      directStudentCount: directIds.length,
      overlapCount: overlap,
    });
    return {
      classCount: selectedClasses.size,
      directCount: directIds.length,
      effective,
    };
  }, [selectedClasses, selectedStudents, students, classById]);

  const toggle = (
    set: Set<string>,
    update: (next: Set<string>) => void,
    id: string,
  ): void => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update(next);
    setDirty(true);
    setSaved(false);
  };

  const publishBlocker = examPublishBlocker(
    exam.status,
    exam.questionCount,
    audience.effective,
    exam.endsAt,
  );

  async function saveAudience(): Promise<boolean> {
    const result = await setExamAudienceAction(
      exam.id,
      [...selectedClasses],
      [...selectedStudents],
    );
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setError(undefined);
    setDirty(false);
    setSaved(true);
    router.refresh();
    return true;
  }

  async function publish(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      // Save first — publishing an unsaved audience would release the exam
      // to the wrong students (or none at all).
      if (dirty) {
        const saved_ = await saveAudience();
        if (!saved_) return;
      }
      const result = await setExamStatusAction(exam.id, "published");
      if (!result.ok) {
        setError(result.message ?? "We couldn't publish this exam. Please try again.");
        return;
      }
      router.push(`/teacher/exams/${exam.id}`);
      router.refresh();
    } catch {
      setError("We couldn't publish this exam. Please try again.");
    } finally {
      setBusy(false);
      setConfirmPublish(false);
    }
  }

  const classesTab = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Search classes or groups"
          placeholder="Search classes or groups…"
          value={classQuery}
          onChange={(event) => setClassQuery(event.target.value)}
          className="max-w-xs"
        />
      </div>
      {filteredClasses.length === 0 ? (
        <EmptyState
          title={classes.length === 0 ? "No classes yet" : "No classes match"}
          description={
            classes.length === 0
              ? "Create classes under Classes before assigning this exam to a group."
              : "Try a different search term."
          }
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Selectable classes">
          {filteredClasses.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-4 rounded-field border border-border bg-surface px-4 py-3"
            >
              <Checkbox
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{entry.name}</span>
                    {entry.academicSessionName ? (
                      <span className="text-xs text-ink-subtle">
                        {entry.academicSessionName}
                      </span>
                    ) : null}
                  </span>
                }
                checked={selectedClasses.has(entry.id)}
                disabled={busy}
                onChange={() =>
                  toggle(selectedClasses, setSelectedClasses, entry.id)
                }
              />
              <span className="shrink-0 text-sm tabular-nums text-ink-muted">
                {entry.studentCount} student
                {entry.studentCount === 1 ? "" : "s"}
                <span className="text-ink-subtle">
                  {" · "}
                  {entry.assignedExamCount} exam
                  {entry.assignedExamCount === 1 ? "" : "s"} assigned
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const studentsTab = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Input
          aria-label="Search students"
          placeholder="Search by name or code…"
          value={studentQuery}
          onChange={(event) => setStudentQuery(event.target.value)}
          className="max-w-xs"
        />
        <Select
          aria-label="Filter students by class"
          value={studentClassFilter}
          onChange={(event) => setStudentClassFilter(event.target.value)}
          className="max-w-48"
        >
          <option value="">All classes</option>
          {classes.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </Select>
      </div>
      {filteredStudents.length === 0 ? (
        <EmptyState
          title={students.length === 0 ? "No assignable students yet" : "No students match"}
          description={
            students.length === 0
              ? "Add active students to your institution before assigning this exam individually."
              : "Try a different search term or class filter."
          }
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Selectable students">
          {filteredStudents.map((student) => {
            const covered = student.classId
              ? selectedClasses.has(student.classId)
              : false;
            return (
              <li
                key={student.id}
                className="flex items-center justify-between gap-4 rounded-field border border-border bg-surface px-4 py-3"
              >
                <Checkbox
                  label={
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{student.fullName}</span>
                      <span className="text-xs text-ink-subtle">
                        {student.studentCode}
                      </span>
                    </span>
                  }
                  description={
                    covered
                      ? "Already covered by a selected class — assigning individually is optional."
                      : undefined
                  }
                  checked={selectedStudents.has(student.id)}
                  disabled={busy}
                  onChange={() =>
                    toggle(selectedStudents, setSelectedStudents, student.id)
                  }
                />
                <span className="shrink-0 text-sm text-ink-muted">
                  {student.classId
                    ? classById.get(student.classId)?.name ?? "—"
                    : "No class"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  const reviewTab = (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="review-classes">
        <h3 id="review-classes" className="text-sm font-semibold text-ink">
          Classes ({audience.classCount})
        </h3>
        {selectedClasses.size === 0 ? (
          <p className="mt-1 text-sm text-ink-subtle">
            No classes selected — the exam will only reach students you
            assign individually.
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {[...selectedClasses].map((id) => {
              const entry = classById.get(id);
              return (
                <li key={id}>
                  <Badge tone="brand">
                    {entry?.name ?? "Unknown class"}
                    {entry ? ` · ${entry.studentCount}` : ""}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="review-students">
        <h3 id="review-students" className="text-sm font-semibold text-ink">
          Individual students ({audience.directCount})
        </h3>
        {selectedStudents.size === 0 ? (
          <p className="mt-1 text-sm text-ink-subtle">
            No individual students selected.
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {[...selectedStudents].map((id) => (
              <li key={id}>
                <Badge tone="neutral">
                  {studentById.get(id)?.fullName ?? "Unknown student"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-field border border-border bg-surface-muted px-4 py-3">
        <h3 className="text-sm font-semibold text-ink">When it is available</h3>
        <p className="mt-1 text-sm text-ink-muted">
          {exam.startsAt || exam.endsAt ? (
            <>
              {formatDateTime(exam.startsAt)} → {formatDateTime(exam.endsAt)} ·{" "}
              {formatDuration(exam.durationMinutes)} per attempt ·{" "}
              {exam.maxAttempts} attempt{exam.maxAttempts === 1 ? "" : "s"} per
              student
            </>
          ) : (
            <>
              No availability window is set — publish will be refused until a
              window exists in the exam details.
            </>
          )}
        </p>
        <p className="mt-2 text-sm font-medium text-ink">
          Total students who will receive this exam:{" "}
          <span className="tabular-nums">{audience.effective}</span>
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-muted">
          <li>Only assigned students will be able to access this exam.</li>
          <li>Students will see the exam in their dashboard at the start time.</li>
          <li>You can change assignments any time before publishing.</li>
          <li>Ensure exam settings and dates are correct before publishing.</li>
        </ul>
      </section>
    </div>
  );

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1">
        {error ? (
          <div className="mb-4">
            <Alert variant="danger" title="Assignment failed">
              {error}
            </Alert>
          </div>
        ) : null}
        {saved && !error ? (
          <div className="mb-4">
            <Alert variant="success" title="Assignments saved">
              The audience was saved — this exam is still a draft until you
              publish it.
            </Alert>
          </div>
        ) : null}

        <Tabs
          tabs={[
            { value: "classes", label: "Assign by Class / Group", content: classesTab },
            { value: "students", label: "Assign Individual Students", content: studentsTab },
            {
              value: "review",
              label: `Review Selection (${audience.effective})`,
              content: reviewTab,
            },
          ]}
        />

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <Link href={`/teacher/exams/${exam.id}`}>
            <Button type="button" variant="ghost" size="sm" disabled={busy}>
              ← Back to exam
            </Button>
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !dirty}
              onClick={() => {
                setBusy(true);
                void saveAudience().finally(() => setBusy(false));
              }}
            >
              {busy ? "Saving…" : "Save assignments"}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={busy || Boolean(publishBlocker)}
              title={publishBlocker ?? undefined}
              onClick={() => setConfirmPublish(true)}
            >
              Publish exam →
            </Button>
          </div>
        </div>
        {publishBlocker ? (
          <p className="mt-2 text-right text-xs text-ink-subtle">
            {publishBlocker}
          </p>
        ) : null}
      </div>

      <aside className="w-full shrink-0 lg:w-80">
        <Card>
          <div className="p-5">
            <h2 className="text-sm font-semibold text-ink">Exam information</h2>
            <p className="mt-1 text-sm font-medium text-ink">{exam.title}</p>
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Subject</dt>
                <dd className="text-right text-ink">{exam.subjectName}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Questions</dt>
                <dd className="text-right tabular-nums text-ink">
                  {exam.questionCount} · {exam.totalMarks} marks
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Duration</dt>
                <dd className="text-right text-ink">
                  {formatDuration(exam.durationMinutes)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Attempts</dt>
                <dd className="text-right tabular-nums text-ink">
                  {exam.maxAttempts}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Starts</dt>
                <dd className="text-right text-ink">{formatDateTime(exam.startsAt)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Ends</dt>
                <dd className="text-right text-ink">{formatDateTime(exam.endsAt)}</dd>
              </div>
            </dl>

            <h2 className="mt-5 text-sm font-semibold text-ink">
              Assignment summary
            </h2>
            <div className="mt-2 flex items-baseline gap-6">
              <div>
                <p className="text-2xl font-bold tabular-nums text-ink">
                  {audience.classCount}
                </p>
                <p className="text-xs text-ink-muted">Classes selected</p>
              </div>
              <div>
                <p className="text-2xl font-bold tabular-nums text-ink">
                  {audience.effective}
                </p>
                <p className="text-xs text-ink-muted">Total students</p>
              </div>
            </div>
            {audience.directCount > 0 ? (
              <p className="mt-1 text-xs text-ink-muted">
                Including {audience.directCount} individually assigned
                student{audience.directCount === 1 ? "" : "s"} (deduplicated
                against class rosters).
              </p>
            ) : null}
            {dirty ? (
              <p className="mt-2 text-xs font-medium text-amber-700">
                Unsaved assignment changes — Save or Publish to apply them.
              </p>
            ) : null}
          </div>
        </Card>
      </aside>

      {confirmPublish ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirmPublish(false);
          }}
          tone="primary"
          confirmLabel="Publish exam"
          title="Publish this exam?"
          description={`This releases the exam to ${audience.effective} student${
            audience.effective === 1 ? "" : "s"
          } across ${audience.classCount} classe${
            audience.classCount === 1 ? "" : "s"
          }${
            audience.directCount > 0
              ? ` plus ${audience.directCount} individual assignment${
                  audience.directCount === 1 ? "" : "s"
                }`
              : ""
          }${
            dirty ? " (saving your current selection first)" : ""
          }. Questions, marks, and delivery settings freeze at publish, and the availability window (${formatDateTime(
            exam.startsAt,
          )} → ${formatDateTime(exam.endsAt)}) begins as configured.`}
          onConfirm={() => {
            setBusy(true);
            void publish().finally(() => setBusy(false));
          }}
        />
      ) : null}
    </div>
  );
}
