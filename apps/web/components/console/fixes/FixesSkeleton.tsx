import { Skeleton } from "@ratel/design-system/states";

/**
 * Fixes while it loads: the header, the numbers with their marks, the
 * filters and two tables in their final places, so nothing moves when the
 * data lands (DESIGN.md, Loading).
 */
export function FixesSkeleton() {
  return (
    <div data-page="v2" role="status" aria-busy="true" className="flex min-h-full flex-col">
      <span className="sr-only">Loading fixes…</span>
      <div aria-hidden className="border-b border-line px-6 lg:px-8">
        <div className="flex min-h-13 items-center gap-2 py-2">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-14" />
        </div>
        <div className="pb-3">
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
      </div>
      <div aria-hidden className="flex flex-col gap-8 px-6 py-6 lg:px-8">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, cell) => (
            <div key={cell} className="flex flex-col gap-2 bg-app p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-12" />
              <Skeleton className="mt-1 h-2 w-32" />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-8 w-52" />
          <Skeleton className="ml-auto h-3 w-24" />
        </div>
        {[3, 6].map((rows, table) => (
          <div key={table} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Skeleton className="size-4" />
                <Skeleton className="h-4 w-40" />
              </div>
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
            <div>
              <div className="flex h-9 items-center gap-6 border-b border-line px-3">
                <Skeleton className="h-3 w-10" />
                <Skeleton className="ml-auto h-3 w-14 max-md:hidden" />
                <Skeleton className="h-3 w-12 max-sm:hidden" />
                <Skeleton className="h-3 w-16 max-lg:hidden" />
                <Skeleton className="h-3 w-20" />
              </div>
              {Array.from({ length: rows }, (_, row) => (
                <div key={row} className="flex h-9 items-center gap-6 border-b border-line px-3">
                  <div className="flex w-1/3 min-w-0 items-center gap-2.5">
                    <Skeleton className="size-4 shrink-0" />
                    <Skeleton className="h-3 w-4/5" />
                  </div>
                  <Skeleton className="ml-auto h-6 w-48 max-md:hidden" />
                  <Skeleton className="h-3 w-24 max-sm:hidden" />
                  <Skeleton className="h-3 w-16 max-lg:hidden" />
                  <Skeleton className="h-7 w-28" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
