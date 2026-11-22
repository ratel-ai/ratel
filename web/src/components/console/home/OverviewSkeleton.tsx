import { Skeleton } from "@ratel/design-system/states";
import type { ReactNode } from "react";

/**
 * Overview while it loads: the same header, stat row, product tiles, list
 * and narrow runs column, so nothing moves when the data lands (DESIGN.md,
 * Every state is designed).
 */
export function OverviewSkeleton() {
  return (
    <div data-page="v2" role="status" aria-busy="true" className="flex min-h-full flex-col">
      {/* Also the fallback for project pages without their own skeleton. */}
      <span className="sr-only">Loading page…</span>
      <div
        aria-hidden
        className="flex min-h-13 items-center gap-4 border-b border-line px-6 lg:px-8"
      >
        <Skeleton className="h-5 w-40" />
        <Skeleton className="ml-auto h-7 w-36" />
      </div>
      <div aria-hidden className="flex max-w-[75rem] flex-col gap-8 px-6 py-6 lg:px-8">
        <Cells height="h-28">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="mt-auto h-7 w-10" />
        </Cells>
        <Cells height="h-28">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-14" />
          <Skeleton className="mt-auto h-6 w-32" />
        </Cells>
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          {[
            { rows: 5, height: "h-11" },
            { rows: 5, height: "h-9" },
          ].map(({ rows, height }, column) => (
            <div key={column} className="flex flex-col gap-3">
              <Skeleton className="h-4 w-32" />
              <div className="divide-y divide-line rounded-lg border border-line">
                {Array.from({ length: rows }, (_, row) => (
                  <div key={row} className={`flex ${height} items-center gap-3 px-4`}>
                    <Skeleton className="size-4 shrink-0" />
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="ml-auto h-3 w-10" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Four cells in a hairline grid: the stat row, then the product tiles. */
function Cells({ height, children }: { height: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-4">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className={`flex ${height} flex-col gap-2 bg-app p-4`}>
          {children}
        </div>
      ))}
    </div>
  );
}
