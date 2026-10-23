import { cn } from "@/lib/utils";

/*
 * Dependency-free SVG line chart for REAL platform time-series data
 * (/platform/usage). Server-safe: pure markup, no interactivity, no JS.
 *
 * Honesty rules encoded here (AGENTS.md §8, prompt 31 contract):
 *  - axes are labelled with the unit ("items per day/week/month") — the
 *    chart never renders unlabelled numbers that could be misread;
 *  - a successful-but-empty window draws a flat baseline PLUS the caller's
 *    "no activity in this period" note — a zero is shown as a zero, and the
 *    note keeps it from being mistaken for missing data;
 *  - the accessible description lists every series total, so screen-reader
 *    users get the same facts as the picture.
 */

export type TrendChartBucket = {
  /** Short axis label, e.g. "5 Oct" or "Oct 2026" (UTC-aligned). */
  label: string;
};

export type TrendChartSeries = {
  label: string;
  /** CSS color — design-token variable, e.g. `var(--color-brand-600)`. */
  color: string;
  /** One count per bucket (same length as `buckets`). */
  points: number[];
};

const WIDTH = 720;
const HEIGHT = 260;
const MARGIN = { top: 12, right: 14, bottom: 30, left: 46 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;

/** Round the axis maximum up to a friendly value (1-2-5 ladder). */
export function niceAxisMax(peak: number): number {
  if (peak <= 4) return Math.max(peak, 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(peak)));
  const normalized = peak / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function xFor(index: number, bucketCount: number): number {
  if (bucketCount <= 1) return MARGIN.left + PLOT_W / 2;
  return MARGIN.left + (index / (bucketCount - 1)) * PLOT_W;
}

function yFor(value: number, axisMax: number): number {
  const ratio = axisMax === 0 ? 0 : value / axisMax;
  return MARGIN.top + PLOT_H - ratio * PLOT_H;
}

export function TrendChart({
  buckets,
  series,
  unitLabel,
  emptyNote,
  className,
}: {
  buckets: TrendChartBucket[];
  series: TrendChartSeries[];
  /** Y-axis unit, e.g. "items per day (UTC)". Rendered, never implied. */
  unitLabel: string;
  /** Honest caption when every series is all-zero (a successful empty). */
  emptyNote?: string;
  className?: string;
}) {
  const bucketCount = buckets.length;
  const peak = series.reduce(
    (max, s) => s.points.reduce((m, n) => (n > m ? n : m), max),
    0,
  );
  const axisMax = niceAxisMax(peak);
  const isEmpty = peak === 0;

  const yTicks = [0, axisMax / 2, axisMax];
  const labelStep = Math.max(1, Math.ceil(bucketCount / 8));

  const summary = series
    .map(
      (s) =>
        `${s.label}: ${s.points.reduce((sum, n) => sum + n, 0).toLocaleString()} total`,
    )
    .join(", ");

  return (
    <figure className={cn("flex flex-col gap-3", className)}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Line chart, ${unitLabel}. ${summary || "No data."}`}
        className="h-auto w-full"
      >
        {/* Plot frame + y gridlines with labelled ticks. */}
        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={PLOT_W}
          height={PLOT_H}
          fill="var(--color-surface)"
          stroke="var(--color-border)"
        />
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + PLOT_W}
              y1={yFor(tick, axisMax)}
              y2={yFor(tick, axisMax)}
              stroke="var(--color-border)"
              strokeDasharray={tick === 0 ? undefined : "3 4"}
            />
            <text
              x={MARGIN.left - 8}
              y={yFor(tick, axisMax) + 3}
              textAnchor="end"
              className="fill-ink-subtle text-[10px]"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {tick.toLocaleString()}
            </text>
          </g>
        ))}
        {/* Y-axis unit caption. */}
        <text
          x={MARGIN.left}
          y={MARGIN.top - 2}
          textAnchor="start"
          className="fill-ink-muted text-[9px]"
        >
          {unitLabel}
        </text>

        {/* X labels (thinned so they never overlap). */}
        {buckets.map((bucket, index) =>
          index % labelStep === 0 || index === bucketCount - 1 ? (
            <text
              key={`${bucket.label}-${index}`}
              x={xFor(index, bucketCount)}
              y={MARGIN.top + PLOT_H + 16}
              textAnchor="middle"
              className="fill-ink-subtle text-[9px]"
            >
              {bucket.label}
            </text>
          ) : null,
        )}

        {/* Series lines + point markers with native tooltips. */}
        {series.map((s) => {
          const linePoints = s.points
            .map((value, index) => `${xFor(index, bucketCount)},${yFor(value, axisMax)}`)
            .join(" ");
          return (
            <g key={s.label}>
              <polyline
                points={linePoints}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {s.points.map((value, index) => (
                <circle
                  key={`${s.label}-${index}`}
                  cx={xFor(index, bucketCount)}
                  cy={yFor(value, axisMax)}
                  r={3}
                  fill={s.color}
                >
                  <title>{`${s.label} · ${buckets[index]?.label ?? ""}: ${value.toLocaleString()}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>

      {/* Legend with real per-series totals for the window. */}
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-2" aria-label="Chart legend">
        {series.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-xs text-ink">
            <span
              aria-hidden="true"
              className="h-2.5 w-4 shrink-0 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            {s.label}
            <span className="tabular-nums text-ink-muted">
              {s.points.reduce((sum, n) => sum + n, 0).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>

      {isEmpty && emptyNote ? (
        <p className="text-sm text-ink-muted">{emptyNote}</p>
      ) : null}
    </figure>
  );
}
