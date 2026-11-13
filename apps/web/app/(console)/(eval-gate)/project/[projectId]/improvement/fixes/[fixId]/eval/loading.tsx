import { Page, PageBody } from "@ratel/design-system/page-header";
import { Skeleton } from "@ratel/design-system/states";

/** The eval page's layout while it loads: header, the numbers, the runs. */
export default function FixEvalLoading() {
  return (
    <Page>
      <div className="border-b border-line px-6 py-3 lg:px-8">
        <Skeleton className="h-7 w-72" />
      </div>
      <PageBody wide>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-24 w-full" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      </PageBody>
    </Page>
  );
}
