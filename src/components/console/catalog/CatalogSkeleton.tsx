import { Skeleton } from "@ratel/design-system/states";

/**
 * Catalog while it loads, in its own shape: the tree beside the detail, or the
 * numbers above a table.
 */
export function CatalogSkeleton({ variant }: { variant: "explorer" | "table" }) {
  return (
    <div data-page="v2" role="status" aria-busy="true" className="flex min-h-full flex-col">
      <span className="sr-only">Loading catalog…</span>
      <div
        aria-hidden
        className="flex min-h-13 items-center gap-4 border-b border-line px-6 lg:px-8"
      >
        <Skeleton className="h-5 w-32" />
        <Skeleton className="ml-auto h-7 w-28" />
      </div>
      {variant === "explorer" ? (
        <div aria-hidden className="flex min-h-0 flex-1">
          <div className="flex w-80 shrink-0 flex-col gap-2 border-r border-line p-3 max-md:hidden">
            <Skeleton className="h-8 w-full" />
            {Array.from({ length: 12 }, (_, index) => (
              <Skeleton key={index} className={index % 4 === 0 ? "h-5 w-24" : "ml-4 h-5 w-40"} />
            ))}
          </div>
          <div className="flex flex-1 flex-col gap-4 p-8">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-4 w-full max-w-xl" />
            <Skeleton className="h-24 w-full max-w-3xl" />
          </div>
        </div>
      ) : (
        <div aria-hidden className="flex flex-col gap-6 px-6 py-6 lg:px-8">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="flex h-24 flex-col gap-2 bg-app p-4">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-7 w-20" />
              </div>
            ))}
          </div>
          <Skeleton className="h-8 w-72" />
          <div className="divide-y divide-line rounded-lg border border-line">
            {Array.from({ length: 10 }, (_, index) => (
              <div key={index} className="flex h-9 items-center gap-4 px-4">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3.5 flex-1" />
                <Skeleton className="h-3.5 w-16" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
