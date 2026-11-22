import { Page, PageBody } from "@ratel/design-system/page-header";
import { Skeleton } from "@ratel/design-system/states";

/** Mirrors the Evals page: header, a summary line and the table. */
export default function EvalsLoading() {
  return (
    <Page>
      <div className="border-b border-line px-6 py-3 lg:px-8">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="mt-3 h-7 w-44" />
      </div>
      <PageBody wide>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-96" />
      </PageBody>
    </Page>
  );
}
