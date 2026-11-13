import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Skeleton } from "@ratel/design-system/states";
import { SUMMARY_TITLE } from "@/components/console/health/v2/summary-model";

/**
 * The Summary while it loads, in the page's own order: the header, the
 * readings, turn shapes, the issue rows, the self-corrections row and the
 * tasks that need a look, so nothing moves when the data lands (DESIGN.md,
 * Loading).
 */
export function SummarySkeleton() {
  return (
    <Page>
      <span role="status" className="sr-only">
        Loading Agent health…
      </span>
      <PageHeader title={SUMMARY_TITLE} description="What your agent gets wrong." />
      <PageBody>
        <Cells count={4} />
        <div aria-hidden className="flex flex-col gap-3">
          <Heading />
          <div className="grid gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="flex h-14 items-center gap-3 border-b border-line">
                <Skeleton className="h-6 w-28" />
                <Skeleton className="h-3 flex-1" />
                <Skeleton className="h-3 w-10" />
              </div>
            ))}
          </div>
        </div>
        <div aria-hidden className="flex flex-col gap-3" data-summary-skeleton="">
          <Heading />
          <div>
            <div className="flex h-9 items-center gap-6 border-b border-line px-3">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="ml-auto h-3 w-16" />
            </div>
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="flex h-11 items-center gap-3 border-b border-line px-3">
                <Skeleton className="size-4" />
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="ml-auto h-3 w-16" />
                <Skeleton className="h-3 w-10" />
                <Skeleton className="h-7 w-16" />
              </div>
            ))}
          </div>
        </div>
        <div aria-hidden className="flex flex-col gap-3">
          <Heading />
          <Cells count={4} />
        </div>
        <div aria-hidden className="flex flex-col gap-3">
          <Heading />
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      </PageBody>
    </Page>
  );
}

function Heading() {
  return <Skeleton className="h-4 w-36" />;
}

function Cells({ count }: { count: number }) {
  return (
    <div
      aria-hidden
      className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-4"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col gap-2 bg-app p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-6 w-14" />
          <Skeleton className="mt-2 h-5 w-16" />
        </div>
      ))}
    </div>
  );
}
