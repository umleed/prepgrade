"use client";

import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/*
 * Controlled modal built on the native <dialog> element: the browser provides
 * the focus trap, top layer rendering, inert background, and Escape
 * cancellation, so no third-party dependency is needed. The scrim comes from
 * the global `dialog::backdrop` rule in app/globals.css.
 */

export type DialogSize = "sm" | "md" | "lg";

const sizeClasses: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Action row rendered in the padded footer, e.g. Cancel / Save buttons. */
  footer?: ReactNode;
  size?: DialogSize;
  /** Set false to keep the dialog open on backdrop clicks (e.g. during saves). */
  dismissable?: boolean;
  className?: string;
};

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissable = true,
  className,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;

  // Sync the imperative dialog API with the controlled `open` prop.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        if (!dismissable) {
          // Keep the modal open while Escape cancels (e.g. mid-save).
          event.preventDefault();
          return;
        }
        onOpenChange(false);
      }}
      onClick={(event) => {
        // Clicks on the backdrop land on the <dialog> element itself.
        if (dismissable && event.target === dialogRef.current) {
          onOpenChange(false);
        }
      }}
      className={cn(
        "m-auto w-[calc(100vw-2rem)] rounded-card border border-border",
        "bg-surface p-0 text-ink shadow-raised open:animate-pop-in",
        sizeClasses[size],
        className,
      )}
    >
      <div className="flex flex-col gap-5 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-sm leading-6 text-ink-muted">
                {description}
              </p>
            ) : null}
          </div>
          {dismissable ? (
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cn(
                "-mr-1 -mt-1 inline-flex size-8 shrink-0 items-center",
                "justify-center rounded-field text-ink-muted transition-colors",
                "hover:bg-surface-muted hover:text-ink",
              )}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                fill="none"
                className="h-4 w-4"
              >
                <path
                  d="m4 4 8 8m0-8-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              <span className="sr-only">Close dialog</span>
            </button>
          ) : null}
        </div>
        {children ? <div className="min-w-0">{children}</div> : null}
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-3">
            {footer}
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
