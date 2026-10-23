"use client";

import Link from "next/link";
import { Button } from "@/components/ui";
import { RouteError } from "@/components/route-error";

/**
 * Root route-error boundary (prompt 37). Catches render/data failures for
 * every segment that has no more specific boundary — the marketing pages,
 * pricing, demo request, onboarding, auth, and the full-screen CBT exam route.
 * `reset()` re-renders the failed segment; for the exam route this simply
 * re-runs the server component, which re-syncs the authoritative attempt.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex-1">
      <RouteError
        error={error}
        reset={reset}
        secondary={
          <Link href="/">
            <Button type="button" variant="secondary">
              Back to home
            </Button>
          </Link>
        }
      />
    </main>
  );
}
