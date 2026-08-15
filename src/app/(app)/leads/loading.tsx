import { Skeleton, SkeletonPage, SkeletonTable, SkeletonToolbar } from "@/app/(app)/skeletons";

/* Mirrors leads-client: standard "Leads" header with a right-aligned count, a
   bordered controls row (search + campaign filter + chips + membership/window/
   sort selects), then the leads table (Lead, Company, Campaign, Membership,
   Exported, Last reply). */
export default function Loading() {
  return (
    <SkeletonPage titleWidth="w-16" headerRight={<Skeleton className="h-3 w-14" />}>
      {/* Controls row. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
        <SkeletonToolbar items={6} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-5 py-4">
          <SkeletonTable rows={10} cols={6} />
        </div>
      </div>
    </SkeletonPage>
  );
}
