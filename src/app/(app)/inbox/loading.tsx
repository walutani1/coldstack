import { Skeleton, SkeletonListRows } from "@/app/(app)/skeletons";

/* Mirrors inbox-client's three-pane grid (list / thread / review rail). The
   inbox has no standard page header — each pane owns its own h-12 toolbar — so
   this reproduces that shell rather than SkeletonPage: a 336px list column with
   a search toolbar, title, tab row and conversation rows; a flex-1 thread area
   with a faint centered empty block; and a 352px context rail. */
export default function Loading() {
  return (
    <div
      className="grid h-full min-h-0 grid-cols-[336px_minmax(0,1fr)_352px]"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">Loading</span>

      {/* List pane */}
      <aside className="flex min-h-0 flex-col border-r border-border bg-surface">
        <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border-strong bg-surface px-3">
          <Skeleton className="h-8 flex-1" />
          <Skeleton className="size-8" />
          <Skeleton className="size-8" />
          <Skeleton className="size-8" />
        </div>
        <div className="flex items-center gap-2 px-3.5 pb-0.5 pt-3">
          <Skeleton className="h-3.5 w-14" />
          <Skeleton className="h-3.5 w-6" />
        </div>
        {/* Tab row */}
        <div className="mx-3 my-2 flex shrink-0 gap-1 rounded-md bg-muted/60 p-0.5">
          <Skeleton className="h-7 flex-auto" />
          <Skeleton className="h-7 flex-auto" />
          <Skeleton className="h-7 flex-auto" />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-2 pb-3">
          <SkeletonListRows rows={10} />
        </div>
      </aside>

      {/* Thread pane */}
      <section className="flex min-h-0 flex-col bg-surface-muted/30">
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <Skeleton className="size-9 rounded-full" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-2.5 w-56" />
        </div>
      </section>

      {/* Review rail */}
      <aside className="flex min-h-0 flex-col border-l border-border bg-surface">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-strong bg-surface px-4">
          <Skeleton className="size-4" />
          <Skeleton className="h-3.5 w-20" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </aside>
    </div>
  );
}
