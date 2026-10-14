import { cn } from "@/lib/utils";

/*
 * Link-based pagination so result lists (questions, students, attempts) stay
 * server-renderable and crawl-free without client JS. Callers map pages to
 * search-param URLs via `hrefFor`. The range collapses to first/last pages
 * with ellipses for long trails.
 */

export type PageItem = number | "ellipsis-left" | "ellipsis-right";

/**
 * Compute the visible page trail: always first and last page, a window of
 * `siblingCount` pages around the current one, and ellipsis gaps.
 * Exported as a pure function so it can be unit-tested when a test runner is
 * approved.
 */
export function getPageItems(
  page: number,
  totalPages: number,
  siblingCount = 1,
): PageItem[] {
  if (totalPages <= 1) return [1];

  const pageCount = 2 + 3 * siblingCount + 2; // first..siblings..current..siblings..last + 2 ellipses
  if (totalPages <= pageCount) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const left = Math.max(2, page - siblingCount);
  const right = Math.min(totalPages - 1, page + siblingCount);

  const items: PageItem[] = [1];
  if (left > 2) items.push("ellipsis-left");
  for (let current = left; current <= right; current += 1) {
    items.push(current);
  }
  if (right < totalPages - 1) items.push("ellipsis-right");
  items.push(totalPages);
  return items;
}

const chevronBase =
  "inline-flex h-8 w-8 items-center justify-center rounded-field border " +
  "border-border-strong bg-surface text-ink-muted transition-colors " +
  "hover:bg-surface-muted hover:text-ink aria-[disabled]:pointer-events-none " +
  "aria-[disabled]:opacity-50";

export type PaginationProps = {
  page: number;
  totalPages: number;
  /** Build the URL for a given 1-based page number. */
  hrefFor: (page: number) => string;
  /** Accessible name for the trail, e.g. "Question bank pages". */
  label?: string;
  className?: string;
};

export function Pagination({
  page,
  totalPages,
  hrefFor,
  label = "Pagination",
  className,
}: PaginationProps) {
  if (totalPages <= 1) return null;
  const items = getPageItems(page, totalPages);

  return (
    <nav aria-label={label} className={cn("flex items-center gap-1", className)}>
      <a
        href={hrefFor(Math.max(1, page - 1))}
        aria-disabled={page <= 1 ? true : undefined}
        rel={page <= 1 ? undefined : "prev"}
        className={chevronBase}
      >
        <span aria-hidden="true">‹</span>
        <span className="sr-only">Previous page</span>
      </a>
      <ol className="flex items-center gap-1">
        {items.map((item) =>
          typeof item === "number" ? (
            <li key={item}>
              {item === page ? (
                <span
                  aria-current="page"
                  className="inline-flex h-8 min-w-8 items-center justify-center rounded-field border border-brand bg-brand px-2 text-sm font-medium text-white"
                >
                  {item}
                </span>
              ) : (
                <a
                  href={hrefFor(item)}
                  className="inline-flex h-8 min-w-8 items-center justify-center rounded-field border border-border-strong bg-surface px-2 text-sm text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
                >
                  {item}
                  <span className="sr-only">: Page {item}</span>
                </a>
              )}
            </li>
          ) : (
            <li
              key={item}
              aria-hidden="true"
              className="inline-flex h-8 min-w-6 items-center justify-center px-1 text-sm text-ink-subtle"
            >
              …
            </li>
          ),
        )}
      </ol>
      <a
        href={hrefFor(Math.min(totalPages, page + 1))}
        aria-disabled={page >= totalPages ? true : undefined}
        rel={page >= totalPages ? undefined : "next"}
        className={chevronBase}
      >
        <span aria-hidden="true">›</span>
        <span className="sr-only">Next page</span>
      </a>
    </nav>
  );
}
