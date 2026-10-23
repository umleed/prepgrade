import { Skeleton, SkeletonText } from "@/components/ui";

/**
 * Suspense fallback for the institution analytics dashboard. Mirrors the real
 * layout (filter row, summary grid, chart, tables) with skeletons so the
 * transition from loading to loaded is stable rather than a jump.
 */
export default function InstitutionAnalyticsLoading() {
  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-3 w-72" />
        </div>
        <Skeleton className="h-8 w-36" />
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-28 rounded-field" />
            ))}
          </div>
          <SkeletonText lines={2} />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-card" />
            ))}
          </div>
          <Skeleton className="h-56 w-full rounded-card" />
          <Skeleton className="h-64 w-full rounded-card" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-72 w-full rounded-card" />
            <Skeleton className="h-72 w-full rounded-card" />
          </div>
        </div>
      </main>
    </>
  );
}
