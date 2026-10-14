"use client";

import { useId } from "react";
import type { InputHTMLAttributes } from "react";
import { controlClasses, FieldMessage, Label } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Numeric verification-code input used by the Clerk email-code (OTP) flows.
 * Shares the same field shell as `EmailField` so the auth screens stay visually
 * consistent. Digits-only, auto-stripped, and centered with wide tracking to
 * read like a one-time code.
 */
export type OtpFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "type" | "onChange"
> & {
  id?: string;
  label?: string;
  error?: string;
  description?: string;
  /** Maximum code length (Clerk email codes are 6 digits). */
  length?: number;
  /** Receives the sanitized digits-only value. */
  onChange?: (value: string) => void;
};

export function OtpField({
  label = "Verification code",
  id,
  error,
  description,
  length = 6,
  value,
  onChange,
  ...rest
}: OtpFieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {label ? <Label htmlFor={controlId}>{label}</Label> : null}
      <input
        id={controlId}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        maxLength={length}
        pattern="[0-9]*"
        value={value}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "").slice(0, length);
          onChange?.(digits);
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [descriptionId, errorId].filter(Boolean).join(" ") || undefined
        }
        placeholder={"•".repeat(length)}
        className={cn(
          controlClasses(Boolean(error)),
          "h-11 text-center font-mono text-lg tracking-[0.5em]",
        )}
        {...rest}
      />
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
