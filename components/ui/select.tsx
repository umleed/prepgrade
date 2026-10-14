import type { ReactNode, SelectHTMLAttributes } from "react";
import { useId } from "react";
import { cn } from "@/lib/utils";
import { FieldMessage, Label, controlClasses } from "./input";

/*
 * Native `<select>` restyled with the shared field shell. Deliberately native
 * rather than a custom listbox: keyboard, screen-reader, and mobile behaviour
 * come for free, which fits the MVP accessibility bar (AGENTS.md §8).
 */

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  label?: ReactNode;
  id?: string;
  description?: ReactNode;
  error?: ReactNode;
  /** Static placeholder option rendered first and disabled. */
  placeholder?: string;
};

/** Select control with an optional built-in label, description, and error. */
export function Select({
  label,
  id,
  description,
  error,
  placeholder,
  className,
  children,
  required,
  ...rest
}: SelectProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy =
    [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {label ? <Label htmlFor={controlId}>{label}</Label> : null}
      <div className="relative">
        <select
          id={controlId}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={controlClasses(
            Boolean(error),
            cn(
              "h-10 cursor-pointer appearance-none pr-9",
              // Placeholder value renders in the muted tone until chosen.
              "[&:invalid]:text-ink-subtle",
              className,
            ),
          )}
          {...rest}
        >
          {placeholder ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {children}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
        >
          <path
            d="m4 6 4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
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
