import { Skeleton } from "@/components/ui";

/** Suspense fallback for the institution detail view — mirrors the identity
 *  card, metric row, and content cards. */
export default function InstitutionDetailLoading() {
  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-24 w-full" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <Skeleton className="h-72 w-full lg:col-span-2" />
          <Skeleton className="h-72 w-full" />
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <Skeleton className="h-56 w-full lg:col-span-2" />
          <Skeleton className="h-56 w-full" />
        </div>
      </div>
    </main>
  );
}
