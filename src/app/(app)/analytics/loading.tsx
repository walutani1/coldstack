import {
  Skeleton,
  SkeletonCard,
  SkeletonChart,
  SkeletonKpiStrip,
  SkeletonPage,
  SkeletonTable,
  SkeletonToolbar,
} from "@/app/(app)/skeletons";

/* Mirrors analytics-client: standard "Analytics" header, a bordered controls
   strip (range + campaign filter), then a max-w-[1600px] scroll column with the
   KPI strip, the categorized-per-day chart card, the campaign comparison table,
   and the two reply-breakdown cards. */
export default function Loading() {
  return (
    <SkeletonPage titleWidth="w-20">
      {/* Controls row (range segmented control + campaign filter). */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
        <SkeletonToolbar items={2} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-4 p-6 xl:p-8">
          <SkeletonKpiStrip tiles={8} />
          <SkeletonCard>
            <SkeletonChart height="h-40" />
          </SkeletonCard>
          <SkeletonTable rows={8} cols={7} />
          <div className="grid gap-4 lg:grid-cols-2">
            <SkeletonCard>
              <div className="flex flex-col gap-2.5">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-3 w-full" />
                ))}
              </div>
            </SkeletonCard>
            <SkeletonCard>
              <div className="flex flex-col gap-2.5">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-3 w-full" />
                ))}
              </div>
            </SkeletonCard>
          </div>
        </div>
      </div>
    </SkeletonPage>
  );
}
