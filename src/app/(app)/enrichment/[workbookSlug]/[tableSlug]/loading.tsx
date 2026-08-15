import {
  Skeleton,
  SkeletonPage,
  SkeletonTable,
  SkeletonToolbar,
} from "@/app/(app)/skeletons";

/* Mirrors enrichment-table: a breadcrumb header (Enrichment / Workbook / Table)
   with a right-aligned stat strip plus runner toggle, settings gear, and export
   actions; then a sheet-tab strip, a filter toolbar, and the big lead grid. */
export default function Loading() {
  return (
    <SkeletonPage
      titleWidth="w-64"
      headerRight={
        <>
          <div className="hidden items-center gap-3 border-r border-border pr-3 xl:flex">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-3.5 w-16" />
            ))}
          </div>
          <Skeleton className="h-8 w-20" />
          <Skeleton className="size-8" />
          <Skeleton className="h-8 w-28" />
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Sheet-tab strip */}
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-surface px-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-24" />
          ))}
        </div>

        {/* Filter toolbar */}
        <div className="shrink-0 border-b border-border bg-surface px-4 py-2">
          <SkeletonToolbar items={6} />
        </div>

        {/* Lead grid */}
        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <SkeletonTable rows={12} cols={6} />
        </div>
      </div>
    </SkeletonPage>
  );
}
