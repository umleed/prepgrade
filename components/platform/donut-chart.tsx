import { cn } from "@/lib/utils";

/*
 * Dependency-free SVG donut chart for real distribution data (user
 * distribution by role). Segments are drawn with stroke-dasharray on a
 * single circle per slice; colours reference design tokens via CSS variables
 * so the chart follows the theme instead of ad-hoc hex values. Server-safe:
 * pure markup, no interactivity.
 */

export type DonutSegment = {
  label: string;
  value: number;
  /** CSS color value — normally a design token variable, e.g.
   *  `var(--color-brand-600)`. */
  color: string;
};

const RADIUS = 42;
const STROKE = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function DonutChart({
  segments,
  centerValue,
  centerLabel,
  className,
}: {
  segments: DonutSegment[];
  /** Big number in the hole (real total), formatted by the caller. */
  centerValue: string;
  centerLabel: string;
  className?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  let offset = 0;
  const arcs =
    total > 0
      ? segments
          .filter((segment) => segment.value > 0)
          .map((segment) => {
            const fraction = segment.value / total;
            const arc = {
              ...segment,
              dash: fraction * CIRCUMFERENCE,
              offset,
            };
            offset += fraction * CIRCUMFERENCE;
            return arc;
          })
      : [];

  return (
    <svg
      viewBox="0 0 120 120"
      role="img"
      aria-label={`Donut chart: ${centerValue} ${centerLabel}. ${segments
        .map((segment) => `${segment.label}: ${segment.value}`)
        .join(", ")}.`}
      className={cn("h-40 w-40", className)}
    >
      {/* Track — also the honest "nothing to split yet" rendering. */}
      <circle
        cx="60"
        cy="60"
        r={RADIUS}
        fill="none"
        stroke="var(--color-surface-muted)"
        strokeWidth={STROKE}
      />
      {arcs.map((arc) => (
        <circle
          key={arc.label}
          cx="60"
          cy="60"
          r={RADIUS}
          fill="none"
          stroke={arc.color}
          strokeWidth={STROKE}
          strokeDasharray={`${arc.dash} ${CIRCUMFERENCE - arc.dash}`}
          strokeDashoffset={-arc.offset}
          transform="rotate(-90 60 60)"
        />
      ))}
      <text
        x="60"
        y="57"
        textAnchor="middle"
        className="fill-ink text-[13px] font-bold"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {centerValue}
      </text>
      <text x="60" y="70" textAnchor="middle" className="fill-ink-muted text-[7px]">
        {centerLabel}
      </text>
    </svg>
  );
}
