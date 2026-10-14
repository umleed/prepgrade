import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";
import { cn } from "@/lib/utils";

/*
 * Checkbox and radio controls styled with the brand token. Labels are always
 * real <label> elements wired by id; `description` is linked with
 * aria-describedby so helper text is announced with the control.
 */

const controlClasses =
  "h-4 w-4 shrink-0 cursor-pointer rounded border-border-strong " +
  "accent-brand disabled:cursor-not-allowed disabled:opacity-60";

type CheckLikeProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type"> & {
  /** Visible label text rendered next to the control. */
  label: ReactNode;
  id?: string;
  description?: ReactNode;
};

function CheckLike({
  as,
  label,
  id,
  description,
  className,
  ...rest
}: CheckLikeProps & { as: "checkbox" | "radio" }) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = description ? `${controlId}-description` : undefined;

  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <input
        id={controlId}
        type={as === "radio" ? "radio" : "checkbox"}
        aria-describedby={descriptionId}
        className={cn(controlClasses, as === "radio" && "rounded-full")}
        {...rest}
      />
      {/* Keep the label on the same line-height as the 4-unit control. */}
      <div className="flex flex-col gap-0.5">
        <label
          htmlFor={controlId}
          className="cursor-pointer text-sm leading-5 text-ink"
        >
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="text-sm leading-5 text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Checkbox with a wired label and optional description. */
export function Checkbox(props: CheckLikeProps) {
  return <CheckLike as="checkbox" {...props} />;
}

/** Radio button; group members share a `name` and each needs its own label. */
export function Radio(props: CheckLikeProps) {
  return <CheckLike as="radio" {...props} />;
}
