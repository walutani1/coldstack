import { Skeleton, SkeletonPage } from "@/app/(app)/skeletons";

/* This route is a thin redirect to the workbook's first table, so it renders
   nothing of substance. Keep the loading state to the standard header shell plus
   a calm centered placeholder before the redirect resolves. */
export default function Loading() {
  return (
    <SkeletonPage titleWidth="w-28">
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <Skeleton className="h-8 w-40" />
      </div>
    </SkeletonPage>
  );
}
