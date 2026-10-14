"use client";

import { useId } from "react";
import type { InputHTMLAttributes } from "react";
import { controlClasses, FieldMessage, Label } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Email input with a leading envelope icon, sharing the same field shell as
 * `Input`/`PasswordField` so the auth forms stay visually consistent.
 */
export type EmailFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  id?: string;
  label?: string;
  error?: string;
  description?: string;
};

export function EmailField({
  label,
  id,
  error,
  description,
  required,
  ...rest
}: EmailFieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {label ? <Label htmlFor={controlId}>{label}</Label> : null}
      <div className="relative">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle"
        >
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 7 9 6 9-6" />
        </svg>
        <input
          id={controlId}
          type="email"
          required={required}
          autoComplete="email"
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [descriptionId, errorId].filter(Boolean).join(" ") || undefined
          }
          className={cn(controlClasses(Boolean(error)), "h-10 pl-9")}
          {...rest}
        />
      </div>
      {error ? (
        <FieldMessage id={errorId!} tone="error">
          {error}
        </FieldMessage>
      ) : description ? (
        <FieldMessage id={descriptionId!} tone="muted">
          {description}
        </FieldMessage>
      ) : null}
    </div>
  );
}
