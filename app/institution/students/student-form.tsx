"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Button, Input, Select } from "@/components/ui";
import {
  STUDENT_INPUT_EMPTY,
  STUDENT_STATUS_LABELS,
  validateStudent,
  type StudentErrors,
  type StudentInput,
} from "@/lib/students";
import {
  createStudentAction,
  updateStudentAction,
  type StudentActionResult,
} from "./actions";

type ClassOption = { id: string; name: string };

/**
 * Shared create/edit student form. Runs the same pure validator the server uses
 * for instant feedback, then calls the corresponding server action, which
 * re-validates and re-scopes to the tenant authoritatively. `mode` decides the
 * action and whether a class assignment is shown as optional.
 */
export function StudentForm({
  mode,
  studentId,
  classes,
  initial,
}: {
  mode: "create" | "edit";
  studentId?: string;
  classes: ClassOption[];
  initial?: StudentInput;
}) {
  const router = useRouter();
  const [values, setValues] = useState<StudentInput>(initial ?? STUDENT_INPUT_EMPTY);
  const [errors, setErrors] = useState<StudentErrors>({});
  const [message, setMessage] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  function setField<K extends keyof StudentInput>(key: K, value: StudentInput[K]) {
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
    const clientErrors = validateStudent(values);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }

    setErrors({});
    setMessage(undefined);
    setSubmitting(true);
    try {
      const result: StudentActionResult =
        mode === "edit" && studentId
          ? await updateStudentAction(studentId, values)
          : await createStudentAction(values);

      if (result.ok && result.id) {
        router.push(`/institution/students/${result.id}`);
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
        <Alert variant="danger" title="Couldn't save this student">
          {message}
        </Alert>
      ) : null}

      <Input
        label="Full name"
        name="fullName"
        autoComplete="off"
        value={values.fullName}
        onChange={(e) => setField("fullName", e.target.value)}
        error={errors.fullName}
        required
      />

      <Input
        label="Student code"
        name="studentCode"
        autoComplete="off"
        description="Admission, index, or roster number. Unique within your institution."
        value={values.studentCode}
        onChange={(e) => setField("studentCode", e.target.value)}
        error={errors.studentCode}
        required
      />

      <Select
        label="Class"
        name="classId"
        required={false}
        value={values.classId}
        onChange={(e) => setField("classId", e.target.value)}
        error={errors.classId}
        description={
          classes.length === 0
            ? "No classes exist yet. You can assign a class once one is created."
            : "Optional — assign to one of your institution's classes."
        }
      >
        <option value="">Unassigned</option>
        {classes.map((cls) => (
          <option key={cls.id} value={cls.id}>
            {cls.name}
          </option>
        ))}
      </Select>

      <Select
        label="Status"
        name="status"
        value={values.status}
        onChange={(e) => setField("status", e.target.value)}
        error={errors.status}
        required
      >
        {(["active", "inactive"] as const).map((s) => (
          <option key={s} value={s}>
            {STUDENT_STATUS_LABELS[s]}
          </option>
        ))}
      </Select>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" size="md" disabled={submitting}>
          {submitting
            ? "Saving…"
            : mode === "edit"
              ? "Save changes"
              : "Create student"}
        </Button>
        <Link
          href={
            mode === "edit" && studentId
              ? `/institution/students/${studentId}`
              : "/institution/students"
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
