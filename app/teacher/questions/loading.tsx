import { Skeleton, SkeletonText } from "@/components/ui";

/**
 * Suspense fallback for the question bank. Mirrors the real layout
 * (toolbar, stat cards, filter row, tree + table) with skeletons so the
 * transition from loading to loaded is stable rather than a jump
 * (AGENTS.md §8).
 */
export default function QuestionBankLoading() {
  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-72" />
        </div>
        <Skeleton className="h-8 w-32" />
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
            <Skeleton className="h-64 w-full" />
            <div className="flex flex-col gap-3">
              <SkeletonText lines={1} />
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
