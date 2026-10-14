import Link from "next/link";
import type { ReactNode } from "react";
import type { MetricState } from "@/lib/data/platform-overview";
import { Card } from "@/components/ui";
import { cn } from "@/lib/utils";

/*
 * Dashboard metric tile shared by the platform screens — white card, pastel
 * icon tile, label / big value / hint, and an optional navigation chevron
 * (only when the whole card links somewhere real). Values come from
 * `MetricState`: an unavailable metric renders "—", never a fabricated zero
 * (AGENTS.md §8, prompt 31 rule).
 */

export type MetricTone = "brand" | "success" | "warning" | "purple" | "neutral";

const toneClasses: Record<MetricTone, string> = {
  brand: "bg-brand-50 text-brand-600",
  success: "bg-success-soft text-success-strong",
  warning: "bg-warning-soft text-warning-strong",
  purple: "bg-accent-purple-soft text-accent-purple",
  neutral: "bg-surface-muted text-ink-muted",
};

export type PlatformMetricCardProps = {
  label: string;
  metric: MetricState<number>;
  tone: MetricTone;
  icon: ReactNode;
  /** Hint shown under an available value (real data only). */
  hint?: ReactNode;
  /** Hint shown when the metric is unavailable, per reason. */
  missingHint?: string;
  /** Real in-app destination; the chevron only renders when present. */
  href?: string;
};

function MetricValue({
  metric,
  missingHint,
}: {
  metric: MetricState<number>;
  missingHint?: string;
}) {
  if (metric.state === "available") {
    return (
      <p className="text-2xl font-bold tracking-tight text-ink tabular-nums lg:text-3xl">
        {metric.value.toLocaleString()}
      </p>
    );
  }
  return (
    <p
      className="text-2xl font-bold tracking-tight text-ink-subtle tabular-nums lg:text-3xl"
      title={
        metric.reason === "missing_table"
          ? missingHint ?? "Not yet available — the data source does not exist yet."
          : "Temporarily unavailable — the data source could not be read."
      }
    >
      <span aria-label="Not available">—</span>
    </p>
  );
}

export function PlatformMetricCard({
  label,
  metric,
  tone,
  icon,
  hint,
  missingHint,
  href,
}: PlatformMetricCardProps) {
  const body = (
    <div className="flex items-center gap-4 p-5">
      <span
        aria-hidden="true"
        className={cn(
          "flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl",
          toneClasses[tone],
        )}
      >
        <span className="[&>svg]:h-7 [&>svg]:w-7">{icon}</span>
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-ink-muted">{label}</span>
        <MetricValue metric={metric} missingHint={missingHint} />
        <span className="text-2xs leading-4 text-ink-subtle">
          {metric.state === "available"
            ? hint ?? ""
            : metric.reason === "missing_table"
              ? missingHint ?? "Not yet available"
              : "Temporarily unavailable"}
        </span>
      </div>
      {href ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ml-auto h-4 w-4 shrink-0 text-ink-subtle"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      ) : null}
    </div>
  );

  if (href) {
    return (
      <Card className="transition-colors hover:border-border-strong">
        <Link href={href} className="flex flex-col">
          {body}
        </Link>
      </Card>
    );
  }
  return <Card>{body}</Card>;
}
