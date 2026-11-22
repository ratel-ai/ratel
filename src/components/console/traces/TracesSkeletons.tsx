import { cn } from "@ratel/design-system/cn";
import { Page, PageBody } from "@ratel/design-system/page-header";
import { Skeleton } from "@ratel/design-system/states";

/**
 * Loading for the v2 Traces pages (DESIGN.md, Loading): the final layout's
 * frame, rows and columns, so nothing shifts when the data lands. Server
 * markup only, so a route's `loading.tsx` can show it instantly.
 */

/** The Runs page: header and tabs, filter row, key numbers, chart, then the table's rows. */
export function RunsSkeleton({ className }: { className?: string }) {
  return (
    <Page className={className}>
      <SkeletonHeader tabs />
      <PageBody wide className="gap-6">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-7 w-20" />
        </div>
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-5">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="flex flex-col gap-2 bg-app p-4">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-7 w-20" />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-[146px] w-full rounded-lg" />
          </div>
          <TableSkeleton columns={["w-20", "flex-1", "w-24", "w-16", "w-40", "w-14", "w-14"]} />
        </div>
      </PageBody>
    </Page>
  );
}

/** Spans and Logs: header and tabs, the filter row, then the list. */
export function ListSkeleton({ className }: { className?: string }) {
  return (
    <Page className={className}>
      <SkeletonHeader tabs />
      <PageBody wide className="gap-6">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-7 w-20" />
        </div>
        <TableSkeleton columns={["w-20", "flex-1", "w-24", "w-20", "w-14", "w-14"]} />
      </PageBody>
    </Page>
  );
}

/** One run in full: crumb and title, key numbers, tabs, then the timeline beside the inspector. */
export function TraceSkeleton({ className }: { className?: string }) {
  return (
    <Page className={className}>
      <SkeletonHeader crumb />
      <PageBody wide className="gap-6">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2 bg-app p-4">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))}
        </div>
        <div className="flex gap-1">
          {["w-20", "w-24", "w-16"].map((width) => (
            <Skeleton key={width} className={cn("h-7", width)} />
          ))}
        </div>
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex flex-col rounded-lg border border-line">
            {Array.from({ length: 10 }, (_, index) => (
              <div
                key={index}
                className="flex h-8 items-center gap-3 border-b border-line px-3 last:border-b-0"
              >
                <span
                  className="flex w-[38%] shrink-0"
                  style={{ paddingLeft: Math.min(index, 4) * 14 }}
                >
                  <Skeleton className="h-3 w-40" />
                </span>
                <span className="flex flex-1" style={{ paddingLeft: `${(index * 7) % 40}%` }}>
                  <Skeleton className="h-1.5 w-1/3" />
                </span>
                <Skeleton className="h-3 w-10" />
              </div>
            ))}
          </div>
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      </PageBody>
    </Page>
  );
}

function SkeletonHeader({ tabs = false, crumb = false }: { tabs?: boolean; crumb?: boolean }) {
  return (
    <header className="border-b border-line px-6 lg:px-8">
      <div className="flex min-h-13 items-center gap-2 py-2">
        {crumb ? <Skeleton className="h-5 w-16" /> : null}
        <Skeleton className="h-5 w-40" />
        <Skeleton className="ml-auto h-7 w-32" />
      </div>
      {tabs ? (
        <div className="flex gap-1 pb-2">
          {["w-14", "w-14", "w-12"].map((width, index) => (
            <Skeleton key={index} className={cn("h-7", width)} />
          ))}
        </div>
      ) : null}
    </header>
  );
}

function TableSkeleton({ columns }: { columns: readonly string[] }) {
  return (
    <div className="flex flex-col" aria-hidden>
      <div className="flex h-9 items-center gap-6 border-b border-line px-3">
        {columns.map((width, index) => (
          <Skeleton key={index} className={cn("h-3", width === "flex-1" ? "w-16" : width)} />
        ))}
      </div>
      {Array.from({ length: 10 }, (_, row) => (
        <div key={row} className="flex h-9 items-center gap-6 border-b border-line px-3">
          {columns.map((width, index) => (
            <Skeleton key={index} className={cn("h-3", width)} />
          ))}
        </div>
      ))}
    </div>
  );
}
