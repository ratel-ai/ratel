import { Skeleton } from "@ratel/design-system/states";

/**
 * Quality while it loads: the same header, headline, tabs and list, so nothing
 * moves when the data lands (DESIGN.md, Loading).
 */
export function QualitySkeleton() {
  return (
    <div data-page="v2" role="status" aria-busy="true" className="flex min-h-full flex-col">
      <span className="sr-only">Loading quality…</span>
      <div aria-hidden className="border-b border-line px-6 lg:px-8">
        <div className="flex min-h-13 items-center gap-4 py-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="ml-auto h-8 w-32" />
          <Skeleton className="h-8 w-36" />
        </div>
        <div className="flex items-center gap-3 pb-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="flex items-center gap-1 pb-2">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-7 w-28" />
        </div>
      </div>
      <div aria-hidden className="flex flex-col gap-3 px-6 py-6 lg:px-8">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="ml-auto h-3 w-24" />
        </div>
        <div>
          <div className="flex h-9 items-center gap-6 border-b border-line px-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="ml-auto h-3 w-20" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
          {Array.from({ length: 8 }, (_, row) => (
            <div key={row} className="flex h-9 items-center gap-6 border-b border-line px-3">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="ml-auto h-3 w-28" />
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
