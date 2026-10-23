"use client";

import { RouteError } from "@/components/route-error";
import { Button } from "@/components/ui";
import Link from "next/link";

/**
 * Teacher workspace error boundary (prompt 37). Kept within the teacher shell
 * so navigation survives a failure; retry re-runs the failing server read.
 */
export default function TeacherError({
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
        <Link href="/teacher">
          <Button type="button" variant="secondary">
            Back to dashboard
          </Button>
        </Link>
      }
    />
  );
}
