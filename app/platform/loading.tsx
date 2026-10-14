import { Skeleton, SkeletonText } from "@/components/ui";

/**
 * Suspense fallback for the platform overview. Mirrors the real layout —
 * title block, four metric cards, two chart rows, and the planned-panel row
 * — with skeletons so the loaded page doesn't jump (AGENTS.md §8).
 */
export default function PlatformLoading() {
  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Skeleton className="h-64 w-full lg:col-span-2" />
          <Skeleton className="h-64 w-full" />
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <SkeletonText lines={6} className="lg:col-span-2" />
          <SkeletonText lines={6} />
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      </div>
    </main>
  );
}
