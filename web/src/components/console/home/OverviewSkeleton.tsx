import { Skeleton } from "@ratel/design-system/states";
import { GridCells } from "@/components/console/grid/GridCells";
import { DEFAULT_LAYOUT, visibleWidgets } from "@/lib/views/overview-layout/domain/layout";

/**
 * Overview while it loads: the same header, and the widgets where the default layout (what most
 * people have) puts them, so nothing moves when the data lands (DESIGN.md, Every state is designed).
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
      <div
        aria-hidden
        className="flex max-w-[75rem] flex-col gap-8 px-6 py-6 lg:px-8"
        data-skeleton="recap"
      >
        <GridCells cards={visibleWidgets(DEFAULT_LAYOUT)}>
          {() => <Skeleton className="h-full min-h-44 w-full rounded-lg" />}
        </GridCells>
      </div>
    </div>
  );
}
