import { Page, PageBody } from "@ratel/design-system/page-header";
import { Skeleton } from "@ratel/design-system/states";

/** Mirrors the fix page: header, what the fix changes, and the simulation lines. */
export default function FixLoading() {
  return (
    <Page>
      <div className="border-b border-line px-6 py-3 lg:px-8">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="mt-3 h-7 w-72" />
      </div>
      <PageBody wide>
        <Skeleton className="h-16 w-96" />
        <Skeleton className="h-40" />
      </PageBody>
    </Page>
  );
}
