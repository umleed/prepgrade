"use client";

import { RouteError } from "@/components/route-error";
import { Button } from "@/components/ui";
import Link from "next/link";

/**
 * Institution workspace error boundary (prompt 37). Renders inside the
 * institution shell, so the sidebar and role context stay intact when a page
 * throws — the admin recovers in place with a retry instead of losing the
 * whole tenant portal.
 */
export default function InstitutionError({
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
        <Link href="/institution">
          <Button type="button" variant="secondary">
            Back to dashboard
          </Button>
        </Link>
      }
    />
  );
}
