import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * Inline alert banners for save results, exam states, and system notices.
 * Danger alerts use role="alert" (assertive); the rest use role="status"
 * (polite) so screen readers are not interrupted by routine messages.
 */

export type AlertVariant = "info" | "success" | "warning" | "danger";

const containerClasses: Record<AlertVariant, string> = {
  info: "border-info-border bg-info-soft text-info-strong",
  success: "border-success-border bg-success-soft text-success-strong",
  warning: "border-warning-border bg-warning-soft text-warning-strong",
  danger: "border-danger-border bg-danger-soft text-danger-strong",
};

/** Minimal 16px stroke icons, one per variant, drawn from token colour. */
function AlertIcon({ variant }: { variant: AlertVariant }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      className="mt-0.5 h-4 w-4 shrink-0"
    >
      {variant === "danger" ? (
        <path
          d="M8 1.5 15 14H1L8 1.5Zm0 4v4m0 2v.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : variant === "warning" ? (
        <path
          d="M8 1.5 15 14H1L8 1.5Zm0 4v4m0 2v.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : variant === "success" ? (
        <path
          d="M8 14.5A6.5 6.5 0 1 1 8 1.5a6.5 6.5 0 0 1 0 13ZM5.25 8l2 2 3.5-4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M8 14.5A6.5 6.5 0 1 1 8 1.5a6.5 6.5 0 0 1 0 13Zm0-9v.5m0 2v4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export type AlertProps = HTMLAttributes<HTMLDivElement> & {
  variant?: AlertVariant;
  /** Optional bold heading above the body text. */
  title?: ReactNode;
  /** Set false for purely informational banners that should not be announced. */
  announce?: boolean;
  children?: ReactNode;
};

export function Alert({
  variant = "info",
  title,
  announce = true,
  className,
  children,
  ...rest
}: AlertProps) {
  return (
    <div
      role={announce ? (variant === "danger" ? "alert" : "status") : undefined}
      className={cn(
        "flex gap-2.5 rounded-card border p-4 text-sm leading-6",
        containerClasses[variant],
        className,
      )}
      {...rest}
    >
      <AlertIcon variant={variant} />
      {/* Title/body share the column so wrapping aligns past the icon. */}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? (
          <div className={cn("text-ink", title && "mt-1")}>{children}</div>
        ) : null}
      </div>
    </div>
  );
}
