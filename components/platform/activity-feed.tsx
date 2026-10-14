import Link from "next/link";
import type { PlatformAuditEntry } from "@/lib/data/audit";
import { platformAuditActionLabel } from "@/lib/audit/platform";
import { cn } from "@/lib/utils";
import { CheckCircleIcon, ClockIcon, ShieldIcon } from "./icons";

/*
 * "Recent Activity" feed for the platform dashboards, rendered from REAL
 * platform-audit rows only — never a mock event stream. Relative timestamps
 * are computed at render time from the stored `created_at`; the underlying
 * absolute time stays available via the title attribute.
 */

/** Compact "x minutes/hours/days ago" rendering of a stored ISO timestamp. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const OUTCOME_TILE_CLASSES: Record<PlatformAuditEntry["outcome"], string> = {
  success: "bg-success-soft text-success-strong",
  failed: "bg-warning-soft text-warning-strong",
  denied: "bg-danger-soft text-danger-strong",
};

function OutcomeIcon({ outcome }: { outcome: PlatformAuditEntry["outcome"] }) {
  if (outcome === "success") return <CheckCircleIcon className="h-5 w-5" />;
  if (outcome === "denied") return <ShieldIcon className="h-5 w-5" />;
  return <ClockIcon className="h-5 w-5" />;
}

export function ActivityFeed({
  entries,
  emptyMessage = "No platform audit events have been recorded yet. An empty feed means nothing has happened here — not that logging is broken.",
}: {
  entries: PlatformAuditEntry[];
  emptyMessage?: string;
}) {
  if (entries.length === 0) {
    return <p className="text-sm leading-6 text-ink-muted">{emptyMessage}</p>;
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
        >
          <span
            aria-hidden="true"
            className={cn(
              "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
              OUTCOME_TILE_CLASSES[entry.outcome],
            )}
          >
            <OutcomeIcon outcome={entry.outcome} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">
              {platformAuditActionLabel(entry.action)}
            </p>
            {entry.summary ? (
              <p className="truncate text-2xs leading-4 text-ink-muted">
                {entry.summary}
              </p>
            ) : null}
          </div>
          <time
            dateTime={entry.createdAt}
            title={new Date(entry.createdAt).toLocaleString("en-GB")}
            className="shrink-0 pt-0.5 text-2xs text-ink-subtle"
          >
            {relativeTime(entry.createdAt)}
          </time>
        </li>
      ))}
    </ul>
  );
}

/** Card header row: section title + a real "View all" destination. */
export function SectionHeading({
  title,
  description,
  viewAllHref,
  viewAllLabel = "View All",
  className,
}: {
  title: string;
  description?: string;
  viewAllHref?: string;
  viewAllLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
        ) : null}
      </div>
      {viewAllHref ? (
        <Link
          href={viewAllHref}
          className="shrink-0 text-xs font-medium text-brand hover:underline"
        >
          {viewAllLabel}
        </Link>
      ) : null}
    </div>
  );
}
