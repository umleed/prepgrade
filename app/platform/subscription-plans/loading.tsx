import { Skeleton } from "@/components/ui";

/** Suspense fallback for the subscription-plans screen — mirrors the
 *  breadcrumb, title block, and single state panel it resolves to. */
export default function SubscriptionPlansLoading() {
  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <Skeleton className="h-4 w-56" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-56 w-full" />
      </div>
    </main>
  );
}
