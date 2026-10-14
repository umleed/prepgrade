import { Skeleton } from "@/components/ui";

/** Suspense fallback for the institution directory — mirrors the title,
 *  summary cards, tabs, and table shape. */
export default function InstitutionsLoading() {
  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-80" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
        <Skeleton className="h-10 w-full max-w-2xl" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      </div>
    </main>
  );
}
