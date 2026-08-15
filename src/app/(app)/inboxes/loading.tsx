import {
  Skeleton,
  SkeletonCard,
  SkeletonChart,
  SkeletonListRows,
  SkeletonPage,
} from "@/app/(app)/skeletons";

/* Mirrors inboxes-client: header carries a view toggle (in the title slot) plus
   a right-aligned stat strip (Warmup / Campaigns / Health / Deliverability) and
   a "Buy inboxes" button. Body is the master-detail split: a ~380px left column
   (search + filter selects + chips, then grouped rows) and a right Overview pane
   (warmup activity chart card + health card, then a full-width reputation card). */
export default function Loading() {
  return (
    <SkeletonPage
      titleWidth="w-40"
      headerRight={
        <>
          <div className="hidden items-center gap-3 sm:flex">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-1">
                <Skeleton className="h-2.5 w-10" />
                <Skeleton className="h-3 w-8" />
              </div>
            ))}
          </div>
          <Skeleton className="h-8 w-28" />
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Master list column */}
        <aside className="flex shrink-0 flex-col border-b border-border lg:h-full lg:min-h-0 lg:w-[380px] lg:border-b-0 lg:border-r">
          <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2.5">
            <Skeleton className="h-8 w-full" />
            <div className="flex gap-1.5">
              <Skeleton className="h-7 flex-1" />
              <Skeleton className="h-7 flex-1" />
              <Skeleton className="size-7 shrink-0" />
            </div>
            <div className="flex gap-1.5">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-14 rounded-full" />
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden p-2">
            <SkeletonListRows rows={8} avatar={false} />
          </div>
        </aside>

        {/* Detail / Overview pane */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[1060px] flex-col gap-5 px-5 py-6">
            <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
              <SkeletonCard>
                <SkeletonChart height="h-44" bars={14} />
              </SkeletonCard>
              <SkeletonCard />
            </div>
            <SkeletonCard />
          </div>
        </div>
      </div>
    </SkeletonPage>
  );
}
