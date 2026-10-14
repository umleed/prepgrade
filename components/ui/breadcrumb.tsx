import { cn } from "@/lib/utils";

/*
 * Breadcrumb trail for portal navigation (Institution → Exams → Exam detail).
 * Rendered as a labelled <nav> with an ordered list; the final item is the
 * current page and is not a link.
 */

export type BreadcrumbItem = {
  label: string;
  /** Omit `href` for the current (last) page or non-linkable segments. */
  href?: string;
};

export type BreadcrumbsProps = {
  items: BreadcrumbItem[];
  className?: string;
};

export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("text-sm text-ink-muted", className)}
    >
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-1.5">
              {index > 0 ? (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  fill="none"
                  className="h-3.5 w-3.5 text-ink-subtle"
                >
                  <path
                    d="m6 3.5 5 4.5-5 4.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null}
              {item.href && !isLast ? (
                <a
                  href={item.href}
                  className="rounded-sm transition-colors hover:text-ink hover:underline"
                >
                  {item.label}
                </a>
              ) : (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className={cn(isLast && "font-medium text-ink")}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
