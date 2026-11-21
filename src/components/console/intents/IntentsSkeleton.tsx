import { DotLoader } from "@ratel/design-system/dot-matrix";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Skeleton } from "@ratel/design-system/states";
import type { ReactNode } from "react";

/**
 * The Intents pages' loading state: the final layout's header and the list or
 * canvas below, so nothing shifts when the reading lands. A list row has the
 * intent and its example ask on two lines, then its numbers.
 */
export function IntentsSkeleton({
  title,
  description,
  canvas = false,
}: {
  title: string;
  description?: ReactNode;
  canvas?: boolean;
}) {
  return (
    <Page>
      <PageHeader crumbs={[]} title={title} description={description} />
      <PageBody wide>
        {canvas ? (
          <div className="flex h-[min(640px,72dvh)] min-h-[420px] items-center justify-center rounded-lg border border-line bg-app dot-grid">
            <DotLoader label={`Loading ${title.toLowerCase()}`} />
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="h-9 border-b border-line" />
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="flex h-14 items-center gap-6 border-b border-line px-3">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-72 max-w-full" />
                </div>
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-24 max-sm:hidden" />
                <Skeleton className="h-3 w-24 max-md:hidden" />
                <Skeleton className="h-5 w-32 max-lg:hidden" />
              </div>
            ))}
          </div>
        )}
      </PageBody>
    </Page>
  );
}
