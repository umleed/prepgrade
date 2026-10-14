"use client";

import { useState, type FormEvent } from "react";
import {
  Alert,
  Button,
  Input,
  Select,
  Textarea,
} from "@/components/ui";
import { ArrowRightIcon } from "./icons";
import { submitDemoRequest } from "@/app/demo-request/actions";
import {
  DEMO_REQUEST_EMPTY,
  DEMO_ROLES,
  INSTITUTION_TYPES,
  STUDENT_COUNT_RANGES,
  validateDemoRequest,
  type DemoRequestErrors,
  type DemoRequestInput,
} from "@/lib/demo-request";

type Status = "idle" | "submitting" | "success" | "error";

/**
 * Demo-request form. Runs the shared validator on the client for instant
 * feedback, then calls the server action which re-validates authoritatively.
 * A hidden honeypot (`website`) provides basic, dependency-free bot filtering;
 * production hardening (rate limiting / captcha) is noted in the action.
 */
export function DemoRequestForm() {
  const [values, setValues] = useState<DemoRequestInput>(DEMO_REQUEST_EMPTY);
  const [errors, setErrors] = useState<DemoRequestErrors>({});
  const [status, setStatus] = useState<Status>("idle");

  function setField<K extends keyof DemoRequestInput>(
    key: K,
    value: DemoRequestInput[K],
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
    // Clear a field's error as soon as the user edits it.
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "submitting") return;

    const clientErrors = validateDemoRequest(values);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      setStatus("idle");
      return;
    }

    setErrors({});
    setStatus("submitting");
    try {
      const result = await submitDemoRequest(values);
      if (result.ok) {
        setStatus("success");
        setValues(DEMO_REQUEST_EMPTY);
      } else {
        setErrors(result.errors);
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div className="rounded-card border border-success-border bg-success-soft p-6 text-center sm:p-8">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success text-white">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="h-6 w-6"
          >
            <path d="m5 13 4 4L19 7" />
          </svg>
        </span>
        <h2 className="mt-4 text-xl font-bold tracking-tight text-ink">
          Request received — thank you!
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-muted">
          A member of the PrepGrade team will reach out to schedule your
          walkthrough. We typically respond within one business day.
        </p>
        <Button
          variant="secondary"
          className="mt-6"
          onClick={() => setStatus("idle")}
        >
          Submit another request
        </Button>
      </div>
    );
  }

  const submitting = status === "submitting";

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      {status === "error" ? (
        <Alert variant="danger" title="We couldn't send your request">
          Something went wrong on our side. Please check the highlighted fields
          and try again, or email us directly if the problem continues.
        </Alert>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          label="Institution / centre name"
          name="institutionName"
          autoComplete="organization"
          value={values.institutionName}
          onChange={(e) => setField("institutionName", e.target.value)}
          error={errors.institutionName}
          required
        />
        <Input
          label="Contact person"
          name="contactPerson"
          autoComplete="name"
          value={values.contactPerson}
          onChange={(e) => setField("contactPerson", e.target.value)}
          error={errors.contactPerson}
          required
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Select
          label="Your role"
          name="role"
          placeholder="Select your role"
          value={values.role}
          onChange={(e) => setField("role", e.target.value)}
          error={errors.role}
          required
        >
          {DEMO_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </Select>
        <Select
          label="Institution type"
          name="institutionType"
          placeholder="Select institution type"
          value={values.institutionType}
          onChange={(e) => setField("institutionType", e.target.value)}
          error={errors.institutionType}
          required
        >
          {INSTITUTION_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </Select>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          label="Email address"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          description="We'll use this to confirm your demo."
          value={values.email}
          onChange={(e) => setField("email", e.target.value)}
          error={errors.email}
        />
        <Input
          label="Phone number"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required={false}
          description="Optional — helpful if you prefer a call."
          value={values.phone}
          onChange={(e) => setField("phone", e.target.value)}
          error={errors.phone}
        />
      </div>

      <Select
        label="Approximate student count"
        name="studentCount"
        placeholder="Select a range"
        value={values.studentCount}
        onChange={(e) => setField("studentCount", e.target.value)}
        error={errors.studentCount}
        required
      >
        {STUDENT_COUNT_RANGES.map((range) => (
          <option key={range} value={range}>
            {range}
          </option>
        ))}
      </Select>

      <Textarea
        label="Anything you'd like us to know?"
        name="message"
        required={false}
        rows={4}
        placeholder="Current exam process, timelines, subjects, or questions."
        value={values.message}
        onChange={(e) => setField("message", e.target.value)}
        error={errors.message}
      />

      {/* Honeypot — visually and programmatically hidden from real users. */}
      <div aria-hidden="true" className="hidden">
        <label htmlFor="demo-website">Leave this field empty</label>
        <input
          id="demo-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={values.website}
          onChange={(e) => setField("website", e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-3">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={submitting}
        >
          {submitting ? "Sending request…" : "Request a demo"}
          {submitting ? null : <ArrowRightIcon className="h-4 w-4" />}
        </Button>
        <p className="text-xs leading-5 text-ink-subtle">
          By submitting, you agree to be contacted about PrepGrade. We keep your
          details minimal and never sell them.
        </p>
      </div>
    </form>
  );
}
