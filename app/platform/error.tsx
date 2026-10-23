"use client";

import { RouteError } from "@/components/route-error";
import { Button } from "@/components/ui";
import Link from "next/link";

/**
 * Platform (super-admin) error boundary (prompt 37). Renders inside the
 * platform shell so the admin keeps their navigation on a failure. Copy stays
 * neutral and honest — no fabricated support channels or status guarantees.
 */
export default function PlatformError({
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
      title="This area couldn't load"
      secondary={
        <Link href="/platform">
          <Button type="button" variant="secondary">
            Back to overview
          </Button>
        </Link>
      }
    />
  );
}
