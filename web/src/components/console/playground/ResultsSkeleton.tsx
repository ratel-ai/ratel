import { Skeleton } from "@ratel/design-system/states";

/**
 * A search in flight, in the final layout's shape (DESIGN.md, Loading): the
 * section heading, the answer line and the ranked rows, so nothing shifts when
 * the results land.
 */
export function ResultsSkeleton({ rows, label }: { rows: number; label: string }) {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">{label}</span>
      <div aria-hidden className="flex flex-col gap-3">
        <div className="flex min-h-7 items-end justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-3.5 w-64" />
          </div>
          <Skeleton className="hidden h-8 w-60 sm:block" />
        </div>
        <Skeleton className="h-5 w-80" />
        <div className="overflow-hidden rounded-lg border border-line bg-raised">
          {Array.from({ length: rows }, (_, index) => (
            <div
              key={index}
              className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-x-3 border-b border-line px-3 py-2.5 last:border-b-0"
            >
              <Skeleton className="ml-auto h-4 w-3" />
              <div className="flex flex-col gap-1.5">
                <div style={{ width: `${36 - (index % 5) * 3}%` }}>
                  <Skeleton className="h-4 w-full" />
                </div>
                <div style={{ width: `${88 - (index % 5) * 7}%` }}>
                  <Skeleton className="h-3.5 w-full" />
                </div>
              </div>
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
