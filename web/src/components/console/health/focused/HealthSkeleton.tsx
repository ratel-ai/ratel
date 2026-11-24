import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Skeleton } from "@ratel/design-system/states";
import { SUMMARY_TITLE } from "@/components/console/health/v2/summary-model";
import { HARM_LEVELS } from "@/lib/readings/trace-signals/health-score";

/**
 * Agent health while it loads, in the page's own order: the header, the score's ring beside its
 * lines, then the issues as one row per category, so nothing moves when the data lands
 * (DESIGN.md, Loading).
 */
export function HealthSkeleton() {
  return (
    <Page>
      <span role="status" className="sr-only">
        Loading Agent health…
      </span>
      <PageHeader title={SUMMARY_TITLE} description="What your agent gets wrong." />
      <PageBody>
        <div
          aria-hidden
          data-health-skeleton="score"
          className="flex flex-col items-center gap-6 rounded-lg border border-line bg-raised p-5 sm:flex-row sm:gap-8 sm:p-6"
        >
          <Skeleton className="size-44 shrink-0 rounded-full" />
          <div className="flex w-full min-w-0 flex-1 flex-col gap-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
        <div aria-hidden className="flex flex-col gap-3">
          <Skeleton className="h-4 w-36" />
          <div className="divide-y divide-line rounded-lg border border-line">
            {HARM_LEVELS.map((level) => (
              <div
                key={level}
                data-health-skeleton="category"
                className="flex h-14 items-center gap-3 px-4"
              >
                <Skeleton className="size-4" />
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="ml-auto h-3 w-12" />
              </div>
            ))}
          </div>
        </div>
      </PageBody>
    </Page>
  );
}
