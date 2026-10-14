import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * Lightweight hover/focus tooltip rendered with pure CSS state (no JS, no
 * dependency). The tip uses `invisible`/`visible`, so it stays out of the
 * accessibility tree until shown; the trigger must carry its own accessible
 * name (text or aria-label) — the tooltip is supplementary, never the only
 * label.
 */

export type TooltipSide = "top" | "bottom" | "left" | "right";

const sideClasses: Record<TooltipSide, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
  left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
  right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
};

export type TooltipProps = {
  /** Short supplementary text; keep to roughly one sentence. */
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  className?: string;
};

export function Tooltip({
  content,
  children,
  side = "top",
  className,
}: TooltipProps) {
  return (
    <span className={cn("group/tt relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-30 invisible opacity-0",
          "max-w-64 rounded-field bg-ink px-2 py-1 text-2xs leading-4",
          "text-white shadow-raised transition-opacity duration-150",
          "group-hover/tt:visible group-hover/tt:opacity-100",
          "group-focus-within/tt:visible group-focus-within/tt:opacity-100",
          sideClasses[side],
        )}
      >
        {content}
      </span>
    </span>
  );
}
