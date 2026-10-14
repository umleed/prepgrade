import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { useId } from "react";
import { cn } from "@/lib/utils";

/*
 * Form field primitives. Every control shares one field shell (label on top,
 * control, helper text or error below) and one visual language so screens do
 * not restyle inputs individually. Errors are announced via aria-describedby
 * and reflected with aria-invalid for assistive technologies.
 */

type LabelProps = LabelHTMLAttributes<HTMLLabelElement> & {
  children: ReactNode;
};

/** Standalone field label for custom layouts. */
export function Label({ className, ...rest }: LabelProps) {
  return (
    <label
      className={cn(
        "text-sm font-medium leading-5 text-ink peer-disabled:opacity-60",
        className,
      )}
      {...rest}
    />
  );
}

/** Shared control styling for text-like inputs. Exported for `Select` etc. */
export function controlClasses(hasError?: boolean, className?: string): string {
  return cn(
    "w-full rounded-field border bg-surface px-3 text-sm text-ink",
    "placeholder:text-ink-subtle transition-colors",
    "hover:border-ink-subtle",
    "disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-muted disabled:opacity-70",
    hasError
      ? "border-danger focus-visible:outline-danger"
      : "border-border-strong",
    className,
  );
}

/** Helper or error text wired below a control. */
export function FieldMessage({
  id,
  tone,
  children,
}: {
  id: string;
  tone: "muted" | "error";
  children: ReactNode;
}) {
  return (
    <p
      id={id}
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "text-sm leading-5",
        tone === "error" ? "text-danger-strong" : "text-ink-muted",
      )}
    >
      {children}
    </p>
  );
}

function OptionalMarker({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className="font-normal text-ink-subtle"> (optional)</span>;
}

/** Join optional element ids for aria-describedby. */
function joinIds(...ids: Array<string | undefined>): string | undefined {
  const present = ids.filter((id): id is string => Boolean(id));
  return present.length > 0 ? present.join(" ") : undefined;
}

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  /** Visible label. Omit only when an external `Label` is wired manually. */
  label?: ReactNode;
  id?: string;
  /** Helper text shown when there is no error. */
  description?: ReactNode;
  /** Error message; sets aria-invalid and danger styling when present. */
  error?: ReactNode;
};

/** Text-like input with an optional built-in label, description, and error. */
export function Input({
  label,
  id,
  description,
  error,
  className,
  required,
  ...rest
}: InputProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <Label htmlFor={controlId}>
          {label}
          <OptionalMarker show={required === false} />
        </Label>
      ) : null}
      <input
        id={controlId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={joinIds(descriptionId, errorId)}
        className={controlClasses(Boolean(error), className)}
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

export type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & {
  label?: ReactNode;
  id?: string;
  description?: ReactNode;
  error?: ReactNode;
};

/** Multi-line text control using the same field shell as `Input`. */
export function Textarea({
  label,
  id,
  description,
  error,
  className,
  required,
  rows = 4,
  ...rest
}: TextareaProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <Label htmlFor={controlId}>
          {label}
          <OptionalMarker show={required === false} />
        </Label>
      ) : null}
      <textarea
        id={controlId}
        rows={rows}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={joinIds(descriptionId, errorId)}
        className={controlClasses(Boolean(error), cn("py-2.5", className))}
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
