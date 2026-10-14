import { cn } from "@/lib/utils";

/*
 * Loading placeholders. Marked aria-busy with an sr-only announcement so
 * screen-reader users hear "loading…" instead of silently receiving new DOM.
 * The pulse animation is disabled globally under prefers-reduced-motion.
 */

export type SkeletonProps = {
  className?: string;
};

/** Base shimmer block; give it a size via `className` (e.g. "h-4 w-32"). */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block animate-pulse rounded-field bg-surface-muted",
        className,
      )}
    />
  );
}

export type SkeletonTextProps = {
  /** Number of paragraph lines to render. */
  lines?: number;
  className?: string;
};

/** Multi-line text placeholder with a shorter trailing line. */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn("flex flex-col gap-2", className)}
    >
      <span className="sr-only">Loading…</span>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("h-4", index === lines - 1 && "w-2/3")}
        />
      ))}
    </div>
  );
}

export type SkeletonTableProps = {
  rows?: number;
  cols?: number;
  className?: string;
};

/** Table-shaped placeholder for results/question-bank loading states. */
export function SkeletonTable({
  rows = 5,
  cols = 4,
  className,
}: SkeletonTableProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn(
        "w-full rounded-card border border-border bg-surface p-4 shadow-card",
        className,
      )}
    >
      <span className="sr-only">Loading table…</span>
      <div className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, rowIndex) => (
          <div key={rowIndex} className="grid gap-4" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {Array.from({ length: cols }, (_, colIndex) => (
              <Skeleton key={colIndex} className="h-4 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
