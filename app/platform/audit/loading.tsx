import { Skeleton } from "@/components/ui";

/** Suspense fallback for the platform audit log — mirrors the title block
 *  and table shape. */
export default function AuditLoading() {
  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-8 w-64" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </main>
  );
}
