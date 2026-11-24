import { Skeleton } from "@ratel/design-system/states";

/**
 * Overview while it loads: the same header, then the Health card and the map,
 * so nothing moves when the data lands (DESIGN.md, Every state is designed).
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
        {["h-64", "h-96"].map((height) => (
          <div key={height} className="flex flex-col gap-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className={`w-full rounded-lg ${height}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
