import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Skeleton } from "@ratel/design-system/states";
import { SUMMARY_TITLE } from "@/components/console/health/v2/summary-model";

/**
 * Agent health while it loads, in the page's own order: the header, the score
 * card and the four categories, so nothing moves when the data lands
 * (DESIGN.md, Loading).
 */
export function SummarySkeleton() {
  return (
    <Page>
      <span role="status" className="sr-only">
        Loading Agent health…
      </span>
      <PageHeader title={SUMMARY_TITLE} description="What your agent gets wrong." />
      <PageBody>
        <div aria-hidden className="flex flex-col gap-8" data-summary-skeleton="">
          <div className="flex flex-col gap-6 rounded-lg border border-line bg-raised p-5 sm:flex-row sm:items-center sm:gap-8 sm:p-6">
            <Skeleton className="size-40 rounded-full" />
            <div className="flex flex-1 flex-col gap-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-5 w-40" />
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-64" />
            <div className="divide-y divide-line rounded-lg border border-line">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="flex h-12 items-center gap-2.5 px-4">
                  <Skeleton className="size-3.5" />
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="ml-auto h-3 w-20" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </PageBody>
    </Page>
  );
}
