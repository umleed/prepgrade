"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Button, Checkbox, Input } from "@/components/ui";
import {
  TEACHER_INPUT_EMPTY,
  validateTeacher,
  type TeacherErrors,
  type TeacherInput,
} from "@/lib/teachers";
import {
  createTeacherAction,
  updateTeacherAction,
  type TeacherActionResult,
} from "./actions";

type ClassOption = { id: string; name: string };

/**
 * Shared invite/edit teacher form. Runs the same pure validator the server
 * uses for instant feedback, then calls the corresponding server action, which
 * re-validates and re-scopes to the tenant authoritatively. In `create` mode
 * the email is editable (it is the invitation/linking key); in `edit` mode it
 * is shown read-only because changing it would break the account link.
 */
export function TeacherForm({
  mode,
  teacherId,
  classes,
  initial,
}: {
  mode: "create" | "edit";
  teacherId?: string;
  classes: ClassOption[];
  initial?: TeacherInput;
}) {
  const router = useRouter();
  const [values, setValues] = useState<TeacherInput>(initial ?? TEACHER_INPUT_EMPTY);
  const [errors, setErrors] = useState<TeacherErrors>({});
  const [message, setMessage] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  function setField<K extends keyof TeacherInput>(key: K, value: TeacherInput[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function toggleClass(classId: string, checked: boolean) {
    setValues((prev) => ({
      ...prev,
      classIds: checked
        ? [...prev.classIds, classId]
        : prev.classIds.filter((id) => id !== classId),
    }));
    setErrors((prev) => {
      if (!prev.classIds) return prev;
      const next = { ...prev };
      delete next.classIds;
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // Client-side gate for UX; the server action repeats this authoritatively.
    const clientErrors = validateTeacher(values);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }

    setErrors({});
    setMessage(undefined);
    setSubmitting(true);
    try {
      const result: TeacherActionResult =
        mode === "edit" && teacherId
          ? await updateTeacherAction(teacherId, values)
          : await createTeacherAction(values);

      if (result.ok) {
        if (result.notice) {
          setMessage(result.notice);
          setSubmitting(false);
          if (result.id && mode === "create") {
            router.push(`/institution/teachers/${result.id}`);
            router.refresh();
          }
          return;
        }
        router.push(`/institution/teachers/${result.id ?? ""}`);
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
        <Alert variant={errors.fullName || errors.email || errors.employeeCode || errors.classIds ? "danger" : "info"} title={mode === "edit" ? "Couldn't save this teacher" : "Couldn't save this invitation"}>
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

      {mode === "create" ? (
        <Input
          label="Email address"
          name="email"
          type="email"
          autoComplete="off"
          description="Used for the invitation and to link their account later. Unique within your institution."
          value={values.email}
          onChange={(e) => setField("email", e.target.value)}
          error={errors.email}
          required
        />
      ) : (
        <Input
          label="Email address"
          name="email"
          value={values.email}
          readOnly
          disabled
          description="The email is the account-linking key and cannot be changed here."
        />
      )}

      <Input
        label="Employee code"
        name="employeeCode"
        autoComplete="off"
        description="Staff or payroll number. Unique within your institution."
        value={values.employeeCode}
        onChange={(e) => setField("employeeCode", e.target.value)}
        error={errors.employeeCode}
        required
      />

      <fieldset>
        <legend className="text-sm font-medium text-ink">Assigned classes</legend>
        <p className="mt-0.5 text-xs text-ink-muted">
          {classes.length === 0
            ? "No classes exist yet. You can assign classes once one is created."
            : "Teachers can only work with the classes assigned here."}
        </p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-6">
          {classes.map((cls) => (
            <Checkbox
              key={cls.id}
              label={cls.name}
              checked={values.classIds.includes(cls.id)}
              onChange={(e) => toggleClass(cls.id, e.target.checked)}
            />
          ))}
        </div>
        {errors.classIds ? (
          <p className="mt-1.5 text-xs text-danger-strong">{errors.classIds}</p>
        ) : null}
      </fieldset>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" size="md" disabled={submitting}>
          {submitting
            ? "Saving…"
            : mode === "edit"
              ? "Save changes"
              : "Invite teacher"}
        </Button>
        <Link
          href={
            mode === "edit" && teacherId
              ? `/institution/teachers/${teacherId}`
              : "/institution/teachers"
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
