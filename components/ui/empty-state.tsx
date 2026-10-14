import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * Meaningful empty states (AGENTS.md §8): what is missing, why it matters,
 * and what to do next. `action` is normally a <Button> or link. No cartoon
 * illustrations — a quiet dashed surface keeps the portal professional.
 */

export type EmptyStateProps = {
  /** Optional simple icon (inline SVG element); decorative by default. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Primary next action, e.g. <Button href="/questions/new">Add question</Button>. */
  action?: ReactNode;
  className?: string;
};

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <section
      className={cn(
        "flex flex-col items-center gap-3 rounded-card border border-dashed",
        "border-border-strong bg-surface px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="inline-flex size-10 items-center justify-center rounded-full bg-surface-muted text-ink-muted"
        >
          {icon}
        </span>
      ) : null}
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {description ? (
        <p className="max-w-md text-sm leading-6 text-ink-muted">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </section>
  );
}
