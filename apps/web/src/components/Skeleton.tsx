import { cn } from "../lib/utils";

/**
 * A single shimmering placeholder block. The building block for every skeleton
 * loader below.
 *
 * Plain words: a grey, gently-pulsing rectangle that stands in for content while
 * the real thing loads — so the layout doesn't jump and the wait feels shorter
 * than a bare spinner. Pass Tailwind size/shape classes (h-*, w-*, rounded-*).
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded bg-zinc-800/70", className ?? "h-4 w-full")}
    />
  );
}

/**
 * Content-shaped placeholder for a transcript that's still loading: a few
 * message-like rows (a thin role bar + a couple of text lines each), alternating
 * sides so it reads like a conversation rather than a generic block. Replaces the
 * bare centered spinner in TranscriptPane's pre-page state.
 */
export function TranscriptSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" className="flex flex-col gap-5 px-6 py-6" aria-busy="true" aria-label="Loading transcript">
      {Array.from({ length: rows }).map((_, i) => {
        const assistant = i % 2 === 1;
        return (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-full min-h-[2.5rem] w-0.5 shrink-0 rounded-full bg-zinc-800" />
            <div className={cn("flex min-w-0 flex-1 flex-col gap-2", assistant ? "" : "items-start")}>
              <Skeleton className="h-3 w-16 rounded-md" />
              <Skeleton className="h-3.5 w-[min(38rem,90%)]" />
              {assistant ? <Skeleton className="h-3.5 w-[min(30rem,70%)]" /> : null}
              <Skeleton className="h-3.5 w-[min(22rem,55%)]" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Content-shaped placeholder for a loading session/list row: a title line and a
 * shorter meta line, matching SessionsPane's row layout. Render several inside a
 * list container for a full-list skeleton.
 */
export function ListRowSkeleton() {
  return (
    <div className="mb-0.5 flex flex-col gap-2 rounded-lg px-2.5 py-2">
      <Skeleton className="h-3.5 w-[70%]" />
      <Skeleton className="h-2.5 w-[45%]" />
    </div>
  );
}

/** A column of {@link ListRowSkeleton}s for a loading list pane. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" className="px-1.5 py-1" aria-busy="true" aria-label="Loading list">
      {Array.from({ length: rows }).map((_, i) => (
        <ListRowSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * A stat-card placeholder: a small label line and a big value line inside a
 * bordered card. Mirrors the dashboard's metric cards so its loading state holds
 * the grid shape instead of collapsing to a centered spinner.
 */
export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-4",
        className,
      )}
    >
      <Skeleton className="h-3 w-20 rounded-md" />
      <Skeleton className="h-7 w-28" />
      <Skeleton className="h-2.5 w-16" />
    </div>
  );
}

/**
 * The dashboard's loading state: a row of metric cards plus a wide panel block,
 * so the page reserves its layout while the stats request is in flight.
 */
export function DashboardSkeleton() {
  return (
    <div
      role="status"
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-8 py-8"
      aria-busy="true"
      aria-label="Loading dashboard"
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
      <Skeleton className="h-44 w-full rounded-xl" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-60 w-full rounded-xl" />
        <Skeleton className="h-60 w-full rounded-xl" />
      </div>
    </div>
  );
}
