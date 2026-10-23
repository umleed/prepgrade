import { Skeleton, SkeletonText } from "@/components/ui";

/**
 * Suspense fallback for My Performance (prompt 29). Mirrors the real layout —
 * page header, a summary line, four metric cards, and the paired analysis
 * cards — with skeletons so loading to loaded is a stable transition, not a
 * jump (AGENTS.md §8).
 */
export default function StudentPerformanceLoading() {
  return (
    <>
      <header className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-6 py-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3 w-80" />
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <Skeleton className="h-3 w-72" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-56 w-full" />
            ))}
          </div>
          <SkeletonText lines={3} />
        </div>
      </main>
    </>
  );
}
