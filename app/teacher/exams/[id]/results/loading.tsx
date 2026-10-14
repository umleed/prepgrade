import { Skeleton, SkeletonText } from "@/components/ui";

/**
 * Suspense fallback for the exam results screens (prompt 25). Mirrors the real
 * layout — page header, four summary cards, a results table — with skeletons so
 * loading to loaded is a stable transition, not a jump (AGENTS.md §8).
 */
export default function ExamResultsLoading() {
  return (
    <>
      <header className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-6 py-4">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-3 w-72" />
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
          <SkeletonText lines={1} />
          <Skeleton className="h-72 w-full" />
        </div>
      </main>
    </>
  );
}
