"use client";

import { useId } from "react";
import type { ReactElement } from "react";
import { cn } from "@/lib/utils";
import {
  INTENT_HINTS,
  INTENT_LABELS,
  REGISTRATION_INTENTS,
  type RegistrationIntent,
} from "@/lib/auth/registration";
import {
  CbtDeliveryIcon,
  SchoolIcon,
  StudentIcon,
  TeacherIcon,
} from "@/components/marketing/icons";

/*
 * The four account types a new user can declare at sign-up. Presentation-only:
 * this component reads and writes a `RegistrationIntent` value; the security
 * meaning of that value lives in `lib/auth/registration.ts` and is enforced
 * fail-closed by `normalizeRegistrationIntent`. Privileged roles
 * (`SUPER_ADMIN`, `INSTITUTION_ADMIN`) are not — and cannot be — options here.
 *
 * The card shell uses a native `<input type="radio">` for keyboard, screen
 * reader, and mobile behaviour (matching `components/ui/checkbox.tsx`). The
 * visible label, icon, and description are wired via `htmlFor`/`id` so the
 * whole card is clickable and announced as one control.
 */

const INTENT_ICONS: Record<
  RegistrationIntent,
  (props: { className?: string }) => ReactElement
> = {
  student: StudentIcon,
  teacher: TeacherIcon,
  cbt_centre: CbtDeliveryIcon,
  school: SchoolIcon,
};

export type RegistrationIntentPickerProps = {
  /** Currently selected intent, or `null` when nothing is chosen yet. */
  value: RegistrationIntent | null;
  /** Called whenever the user picks an option. Never fires on blur. */
  onChange: (intent: RegistrationIntent) => void;
  /** Set when the field is invalid — the parent decides what "invalid" means. */
  error?: string;
  /** Optional helper text rendered under the legend. */
  description?: string;
  /** Disable every option (e.g. while the sign-up request is in flight). */
  disabled?: boolean;
  /**
   * Optional name for the radio group. Defaults to a generated id so multiple
   * pickers on the same screen never share a selection.
   */
  name?: string;
};

export function RegistrationIntentPicker({
  value,
  onChange,
  error,
  description,
  disabled,
  name,
}: RegistrationIntentPickerProps) {
  const generatedName = useId();
  const groupName = name ?? generatedName;
  const descriptionId = description ? `${groupName}-description` : undefined;
  const errorId = error ? `${groupName}-error` : undefined;
  const describedBy =
    [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <fieldset
      className="flex flex-col gap-2 border-0 p-0"
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
      disabled={disabled}
    >
      <legend className="text-sm font-medium leading-5 text-ink">
        I&apos;m joining PrepGrade as a…
      </legend>
      {description ? (
        <p id={descriptionId} className="text-sm leading-5 text-ink-muted">
          {description}
        </p>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        {REGISTRATION_INTENTS.map((intent) => {
          const Icon = INTENT_ICONS[intent];
          const checked = value === intent;
          const controlId = `${groupName}-${intent}`;
          return (
            <label
              key={intent}
              htmlFor={controlId}
              className={cn(
                "flex cursor-pointer gap-3 rounded-card border p-3 text-left transition-colors",
                "hover:border-brand",
                checked
                  ? "border-brand bg-brand-50 shadow-card"
                  : "border-border-strong bg-surface",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                id={controlId}
                type="radio"
                name={groupName}
                value={intent}
                checked={checked}
                onChange={() => onChange(intent)}
                className="sr-only"
                disabled={disabled}
              />
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-field border",
                  checked
                    ? "border-brand bg-surface text-brand"
                    : "border-border bg-surface-muted text-ink-muted",
                )}
              >
                <Icon className="h-5 w-5" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-semibold text-ink">
                  {INTENT_LABELS[intent]}
                </span>
                <span className="text-xs leading-5 text-ink-muted">
                  {INTENT_HINTS[intent]}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {error ? (
        <p
          id={errorId}
          role="alert"
          className="text-sm leading-5 text-danger-strong"
        >
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
