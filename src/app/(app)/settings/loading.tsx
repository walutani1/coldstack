import { Skeleton, SkeletonCard, SkeletonPage } from "@/app/(app)/skeletons";

/* Mirrors settings-client: a plain "Settings" header, then a centered
   max-w-[1680px] two-column layout — a ~w-48 section nav (Reply categories /
   Reply defaults / Integrations / Notifications / Workspace) on the left and a
   content pane (section heading + cards) on the right. */
export default function Loading() {
  return (
    <SkeletonPage titleWidth="w-20">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1680px] gap-6 px-5 py-6 xl:gap-8 xl:px-8">
          {/* Section nav */}
          <nav className="hidden w-48 shrink-0 flex-col gap-0.5 sm:flex">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </nav>

          {/* Content pane */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <Skeleton className="h-4 w-40" />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        </div>
      </div>
    </SkeletonPage>
  );
}
