import type { ReactNode } from "react";

/* Shared loading-skeleton toolkit. Pure static markup (no hooks), so it is
   safe to render from both route loading.tsx (server) and client components.
   Everything uses the app's existing pulse idiom (animate-pulse + bg-muted),
   sized to occupy the same space as the real content so there is no layout
   shift when data arrives. Decorative blocks are aria-hidden; wrap a screenful
   in SkeletonPage (or set role="status" aria-busy) so assistive tech announces
   the loading state once. */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-md bg-muted ${className}`} />;
}

/* Full-height content column with the standard h-14 header bar (icon + title,
   optional right-aligned slot). Matches every page's header grammar. */
export function SkeletonPage({
  children,
  titleWidth = "w-28",
  headerRight,
}: {
  children: ReactNode;
  titleWidth?: string;
  headerRight?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden" role="status" aria-busy="true">
      <span className="sr-only">Loading</span>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-5">
        <Skeleton className="size-4" />
        <Skeleton className={`h-4 ${titleWidth}`} />
        {headerRight ? <div className="ml-auto flex items-center gap-3">{headerRight}</div> : null}
      </header>
      {children}
    </div>
  );
}

/* A KPI/stat strip: the exact grid the campaign overview and analytics tiles
   use (2 / 3 / N columns, hairline dividers via the bg-border gap trick). */
export function SkeletonKpiStrip({ tiles = 6, className = "" }: { tiles?: number; className?: string }) {
  const lg = tiles >= 7 ? "lg:grid-cols-7" : tiles === 6 ? "lg:grid-cols-6" : tiles === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4";
  return (
    <div className={`grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border shadow-xs sm:grid-cols-3 ${lg} ${className}`}>
      {Array.from({ length: tiles }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2 bg-surface px-4 py-3">
          <Skeleton className="h-2.5 w-12" />
          <Skeleton className="h-4 w-10" />
        </div>
      ))}
    </div>
  );
}

/* Deterministic bar heights (no Math.random, so server render and any later
   hydration agree). */
const BAR_HEIGHTS = [42, 68, 50, 82, 45, 72, 58, 90, 55, 76, 48, 84, 60, 70, 52, 88, 46, 78];

/* A bar-chart shaped block: a baseline with columns of varied height. Drop it
   where a real chart will render (analytics, warmup activity, reply-by-day). */
export function SkeletonChart({ height = "h-40", bars = 14, className = "" }: { height?: string; bars?: number; className?: string }) {
  return (
    <div className={`flex ${height} items-end gap-[3px] border-b border-border/70 pt-3 ${className}`}>
      {Array.from({ length: bars }).map((_, i) => (
        <div
          key={i}
          aria-hidden
          className="flex-1 animate-pulse rounded-t bg-muted"
          style={{ height: `${BAR_HEIGHTS[i % BAR_HEIGHTS.length]}%` }}
        />
      ))}
    </div>
  );
}

/* A titled card wrapper (rounded-xl surface with a header line), for the
   overview-style cards that hold a chart or a stat block. */
export function SkeletonCard({ children, className = "", title = true }: { children?: ReactNode; className?: string; title?: boolean }) {
  return (
    <div className={`flex flex-col gap-3 rounded-xl bg-surface px-4 py-3.5 shadow-xs ${className}`}>
      {title ? <Skeleton className="h-3 w-32" /> : null}
      {children ?? <Skeleton className="h-24 w-full bg-muted/60" />}
    </div>
  );
}

/* A data table: tinted header strip + body rows. First column is wider. */
export function SkeletonTable({ rows = 8, cols = 5, className = "" }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-xl bg-surface shadow-xs ${className}`}>
      <div className="flex items-center gap-4 border-b border-border bg-surface-muted px-4 py-2.5">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className={`h-2.5 ${i === 0 ? "w-28" : "w-16"} ${i === cols - 1 ? "ml-auto" : ""}`} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-border/60 px-4 py-3 last:border-b-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={`h-3 ${c === 0 ? "w-40" : "w-20"} ${c === cols - 1 ? "ml-auto" : ""}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* Conversation / inbox-style list rows: avatar + two text lines. */
export function SkeletonListRows({ rows = 8, avatar = true, className = "" }: { rows?: number; avatar?: boolean; className?: string }) {
  return (
    <div className={`flex flex-col ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5">
          {avatar ? <Skeleton className="size-8 shrink-0 rounded-full" /> : null}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-2.5 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* A row of control-shaped blocks (search + filter pills / selects). */
export function SkeletonToolbar({ items = 4, className = "" }: { items?: number; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {Array.from({ length: items }).map((_, i) => (
        <Skeleton key={i} className={`h-8 ${i === 0 ? "w-56" : "w-24"}`} />
      ))}
    </div>
  );
}
