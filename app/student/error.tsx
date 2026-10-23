"use client";

import { RouteError } from "@/components/route-error";
import { Button } from "@/components/ui";
import Link from "next/link";

/**
 * Student workspace error boundary (prompt 37). Covers the student dashboard,
 * My Exams, results, and performance pages inside the student shell. The
 * full-screen exam itself lives under /exam and is guarded by the root
 * boundary, so a mid-exam failure still recovers without dropping this nav.
 */
export default function StudentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      error={error}
      reset={reset}
      title="This section couldn't load"
      secondary={
        <Link href="/student">
          <Button type="button" variant="secondary">
            Back to dashboard
          </Button>
        </Link>
      }
    />
  );
}
