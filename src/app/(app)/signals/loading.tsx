import { Skeleton, SkeletonPage } from "../skeletons";

export default function SignalsLoading() {
  return (
    <SkeletonPage titleWidth="w-20" headerRight={<Skeleton className="h-7 w-24" />}>
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="ml-auto h-7 w-28" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-px px-5 py-4">
          {Array.from({ length: 9 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 rounded-md bg-surface px-3 py-2.5 shadow-xs">
              <Skeleton className="size-8 rounded-md" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-64" />
                <Skeleton className="h-3 w-40" />
              </div>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    </SkeletonPage>
  );
}
