import { Skeleton, SkeletonCard } from "@/app/(app)/skeletons";

/* Mirrors untracked-client: a non-standard header (back-to-inbox link, divider,
   MailQuestion icon, "Untracked replies" title, description), a bordered tab
   strip (Needs review / Cleaned / Dismissed / Imported / Errors), then a
   centered max-w-3xl column of review cards. Built inline because the header is
   not the standard icon+title bar. */
export default function Loading() {
  return (
    <div className="flex h-full flex-col overflow-hidden" role="status" aria-busy="true">
      <span className="sr-only">Loading</span>

      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <Skeleton className="h-3.5 w-24" />
        <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
        <Skeleton className="size-4" />
        <Skeleton className="h-4 w-36" />
        <Skeleton className="hidden h-3 w-80 md:block" />
      </header>

      {/* Tab strip */}
      <div className="flex shrink-0 items-center border-b border-border bg-surface px-4 py-2">
        <div className="flex gap-1 rounded-md bg-muted/60 p-0.5">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-7 w-14" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-5 py-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonCard key={i} title={false} className="min-h-28">
              <div className="flex items-center gap-2">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="ml-auto h-4 w-16" />
              </div>
              <Skeleton className="h-2.5 w-3/4" />
              <Skeleton className="h-2.5 w-2/3" />
              <div className="mt-auto flex items-center gap-2">
                <Skeleton className="h-7 w-20" />
                <Skeleton className="h-7 w-20" />
              </div>
            </SkeletonCard>
          ))}
        </div>
      </div>
    </div>
  );
}
