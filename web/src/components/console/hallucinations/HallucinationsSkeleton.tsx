"use client";

import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Skeleton } from "@ratel/design-system/states";
import { useParams } from "next/navigation";
import { HALLUCINATIONS_DESCRIPTION } from "@/components/console/hallucinations/copy";
import { agentHealthHref } from "@/lib/readings/trace-signals/view";

/**
 * The Hallucinations page while it loads, in its own shape: the header under
 * Agent health, the three numbers, the ring beside its groups, then the
 * table of groups and kinds.
 */
export function HallucinationsSkeleton() {
  const params = useParams<{ projectId?: string }>();
  const projectId = typeof params?.projectId === "string" ? params.projectId : null;
  return (
    <Page>
      <PageHeader
        title="Hallucinations"
        crumbs={
          projectId ? [{ label: "Agent health", href: agentHealthHref(projectId) }] : undefined
        }
        description={HALLUCINATIONS_DESCRIPTION}
      />
      <PageBody wide>
        <div aria-hidden className="flex flex-col gap-8">
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} data-skeleton-stat="">
                <Skeleton className="h-24 w-full" />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-6 w-96 max-w-full" />
            <div className="flex flex-wrap items-center gap-x-10 gap-y-6">
              <div className="shrink-0" data-skeleton-ring="">
                <Skeleton className="size-44 rounded-full" />
              </div>
              <div className="flex min-w-[16rem] flex-1 flex-col gap-2">
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={i} data-skeleton-group="">
                    <Skeleton className="h-8 w-full max-w-md" />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-3" data-skeleton-table="">
            <Skeleton className="h-4 w-52" />
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        </div>
      </PageBody>
    </Page>
  );
}
