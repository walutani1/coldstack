import { Skeleton, SkeletonListRows } from "@/app/(app)/skeletons";

/* Mirrors campaigns-client: standard "Campaigns" header, then a split body — a
   fixed-width left campaign list (label + New button, search, two filter
   selects, then campaign rows) beside a flex-1 detail area that shows a centered
   "Select a campaign" placeholder. */
export default function Loading() {
  return (
    <div className="flex h-full flex-col overflow-hidden" role="status" aria-busy="true">
      <span className="sr-only">Loading</span>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-5">
        <Skeleton className="size-4" />
        <Skeleton className="h-4 w-28" />
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Left: campaign list */}
        <aside className="flex shrink-0 flex-col border-b border-border lg:w-72 lg:border-b-0 lg:border-r">
          <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-28" />
            </div>
            <Skeleton className="h-7 w-full" />
            <div className="flex items-center gap-1.5">
              <Skeleton className="h-7 flex-1" />
              <Skeleton className="h-7 flex-1" />
            </div>
          </div>
          <div className="p-2">
            <SkeletonListRows rows={8} avatar={false} />
          </div>
        </aside>

        {/* Right: detail placeholder */}
        <div className="flex min-w-0 flex-1 items-center justify-center p-8">
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-2.5 w-56" />
          </div>
        </div>
      </div>
    </div>
  );
}
