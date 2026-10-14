import { Skeleton, SkeletonText } from "@/components/ui";

/**
 * Suspense fallback for the student directory. Mirrors the real layout
 * (toolbar, filter row, table) with skeletons so the transition from loading to
 * loaded is stable rather than a jump (AGENTS.md §8).
 */
export default function StudentsLoading() {
  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-8 w-28" />
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
          <SkeletonText lines={1} />
          <div className="flex flex-col gap-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </div>
      </main>
    </>
  );
}
