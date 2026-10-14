import { Skeleton, SkeletonText } from "@/components/ui";

/**
 * Suspense fallback for the student dashboard (prompt 20). Mirrors the real
 * layout — greeting header, four metric tiles, exam card grid — with
 * skeletons so loading to loaded is a stable transition, not a jump
 * (AGENTS.md §8).
 */
export default function StudentDashboardLoading() {
  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-64" />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
          <SkeletonText lines={1} />
          <div className="grid gap-4 lg:grid-cols-2">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-56 w-full" />
            ))}
          </div>
        </div>
      </main>
    </>
  );
}
