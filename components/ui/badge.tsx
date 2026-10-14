import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * Status chips and count pills. `soft` is the default for dense data tables
 * and dashboards; `solid` is reserved for high-emphasis indicators. Tone
 * tokens come from app/globals.css so colours stay consistent everywhere.
 */

export type BadgeTone =
  | "neutral"
  | "brand"
  | "success"
  | "warning"
  | "danger"
  | "info";
export type BadgeVariant = "soft" | "solid";

const softClasses: Record<BadgeTone, string> = {
  neutral: "bg-surface-muted text-ink-muted border-border",
  brand: "bg-brand-50 text-brand-700 border-brand-200",
  success: "bg-success-soft text-success-strong border-success-border",
  warning: "bg-warning-soft text-warning-strong border-warning-border",
  danger: "bg-danger-soft text-danger-strong border-danger-border",
  info: "bg-info-soft text-info-strong border-info-border",
};

const solidClasses: Record<BadgeTone, string> = {
  neutral: "bg-ink text-white border-ink",
  brand: "bg-brand text-white border-brand",
  success: "bg-success text-white border-success",
  warning: "bg-warning text-white border-warning",
  danger: "bg-danger text-white border-danger",
  info: "bg-info text-white border-info",
};

const dotClasses: Record<BadgeTone, string> = {
  neutral: "bg-ink-subtle",
  brand: "bg-brand",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  /** Render a small status dot before the label. */
  dot?: boolean;
  children: ReactNode;
};

export function Badge({
  tone = "neutral",
  variant = "soft",
  dot = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5",
        "text-2xs font-medium leading-4 whitespace-nowrap",
        variant === "soft" ? softClasses[tone] : solidClasses[tone],
        className,
      )}
      {...rest}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", dotClasses[tone])}
        />
      ) : null}
      {children}
    </span>
  );
}
