import {
  Skeleton,
  SkeletonCard,
  SkeletonListRows,
  SkeletonPage,
} from "@/app/(app)/skeletons";

/* Mirrors enrichment-home-client: header is just the "Enrichment" title (the
   numbers that matter live on each workbook and table row). Body is a
   centered max-w-[1100px] column: an action row (New workbook / New folder +
   view toggle), then a "Workbooks" section as a two-column grid of rich
   workbook cards (header, stat band, nested table rows). */
export default function Loading() {
  return (
    <SkeletonPage titleWidth="w-24">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-6 p-6 xl:p-8">
          {/* Action row */}
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-8 w-28" />
            <div className="ml-auto flex items-center gap-2">
              <Skeleton className="h-8 w-16" />
            </div>
          </div>

          {/* Workbooks section */}
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-4 w-28" />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <SkeletonCard key={i}>
                  <div className="flex gap-7 py-1">
                    <Skeleton className="h-9 w-16" />
                    <Skeleton className="h-9 w-16" />
                    <Skeleton className="h-9 w-16" />
                  </div>
                  <SkeletonListRows rows={2} avatar={false} />
                </SkeletonCard>
              ))}
            </div>
          </div>
        </div>
      </div>
    </SkeletonPage>
  );
}
