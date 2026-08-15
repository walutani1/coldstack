import { Skeleton, SkeletonCard, SkeletonPage } from "@/app/(app)/skeletons";

/* Mirrors NotificationsClient: a "Notifications" header, then a single
   readable column — a description line, the "Channels" list, and a full-width
   "Add a channel" form card below it. */
export default function Loading() {
  return (
    <SkeletonPage titleWidth="w-32">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex w-full max-w-3xl flex-col gap-5 px-5 py-6">
          <Skeleton className="h-3 w-80" />

          {/* Channels */}
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-24" />
            {Array.from({ length: 2 }).map((_, i) => (
              <SkeletonCard key={i} title={false}>
                <div className="flex items-center gap-3">
                  <Skeleton className="size-8 shrink-0 rounded-md" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Skeleton className="h-3 w-1/3" />
                    <Skeleton className="h-2.5 w-1/2" />
                  </div>
                </div>
              </SkeletonCard>
            ))}
          </div>

          {/* Add a channel */}
          <SkeletonCard title={false}>
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-8 w-44" />
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px]">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
            <Skeleton className="h-4 w-20" />
            <div className="flex flex-wrap gap-1.5">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-6 w-24" />)}
            </div>
            <Skeleton className="h-8 w-32 self-end" />
          </SkeletonCard>
        </div>
      </div>
    </SkeletonPage>
  );
}
