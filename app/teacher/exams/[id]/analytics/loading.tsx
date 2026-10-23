import { Skeleton, SkeletonText } from "@/components/ui";

/**
 * Suspense fallback for the class analytics screen (prompt 27). Mirrors the
 * real layout — header, six summary cards, chart row, and a results table —
 * with skeletons so loading to loaded is a stable transition, not a jump
 * (AGENTS.md §8).
 */
export default function ExamAnalyticsLoading() {
  return (
    <>
      <header className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-6 py-4">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-3 w-80" />
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
          <SkeletonText lines={1} />
          <Skeleton className="h-72 w-full" />
        </div>
      </main>
    </>
  );
}
