"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui";

/*
 * Shared route-error boundary view (prompt 37). Next.js error boundaries must
 * be client components and receive the thrown `error` plus a `reset()` that
 * re-renders the segment by retrying the Server Component / Server Action.
 *
 * Design goals carried over from the rest of the system:
 *   • The region is announced once via role="alert" so assistive tech reports
 *     the failure instead of silently swapping DOM.
 *   • Copy is honest — it never fabricates support contacts, ticket numbers,
 *     or guarantees. The only diagnostic shown is the real Next.js error
 *     `digest` (a server-logged reference id), and only when present.
 *   • The primary action is a retry; `secondary` lets each section offer the
 *     right recovery path (back to a dashboard, exit an exam, etc.) while
 *     reusing the one visual language instead of restyling per screen.
 */

export type RouteErrorProps = {
  error: Error & { digest?: string };
  /** Retries rendering of the failed segment. */
  reset: () => void;
  title?: ReactNode;
  description?: ReactNode;
  /** Optional recovery control, e.g. a <Link><Button>…</Button></Link>. */
  secondary?: ReactNode;
};

export function RouteError({
  error,
  reset,
  title = "This page couldn't load",
  description = "Something went wrong while loading this page. Your saved work is unaffected — try again. If the problem keeps happening, reload or return to your dashboard.",
  secondary,
}: RouteErrorProps) {
  return (
    <div
      role="alert"
      className="mx-auto flex w-full max-w-xl flex-col items-center gap-4 px-6 py-16 text-center"
    >
      <span
        aria-hidden="true"
        className="flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger-strong"
      >
        <svg viewBox="0 0 24 24" fill="none" className="size-6">
          <path
            d="M12 8v5m0 3h.01M10.3 4.3 2.5 18a1.5 1.5 0 0 0 1.3 2.2h16.4a1.5 1.5 0 0 0 1.3-2.2L13.7 4.3a1.5 1.5 0 0 0-2.6 0Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>

      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-bold tracking-tight text-ink">{title}</h2>
        <p className="text-sm leading-6 text-ink-muted">{description}</p>
      </div>

      <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
        <Button type="button" variant="primary" onClick={reset}>
          Try again
        </Button>
        {secondary}
      </div>

      {error.digest ? (
        <p className="text-2xs text-ink-subtle">Reference: {error.digest}</p>
      ) : null}
    </div>
  );
}
