"use client";

import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Skeleton } from "@ratel/design-system/states";
import { useParams } from "next/navigation";
import { SELF_CORRECTIONS_DESCRIPTION } from "@/components/console/self-corrections/copy";
import { agentHealthHref } from "@/lib/readings/trace-signals/view";

/**
 * The page's layout while it loads: the same header (crumb included, so the
 * title does not move when the data lands), the hero, the three short lists
 * of where it happens, and the phrases beside their examples.
 */
export function SelfCorrectionsSkeleton() {
  const params = useParams<{ projectId?: string }>();
  const projectId = typeof params?.projectId === "string" ? params.projectId : null;
  return (
    <Page>
      <PageHeader
        title="Self-corrections"
        crumbs={
          projectId ? [{ label: "Agent health", href: agentHealthHref(projectId) }] : undefined
        }
        description={SELF_CORRECTIONS_DESCRIPTION}
      />
      <PageBody>
        <div
          aria-hidden
          className="flex flex-col gap-5 rounded-lg border border-line bg-raised p-5"
        >
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="flex items-end gap-6">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-9 w-24" />
              </div>
              <Skeleton className="h-8 w-32" />
            </div>
            <div className="flex gap-8">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="flex flex-col gap-2">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-6 w-12" />
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 border-t border-line pt-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-7 w-24" />
            ))}
          </div>
        </div>
        <div aria-hidden className="flex flex-col gap-3">
          <Skeleton className="h-4 w-36" />
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-3">
            {[0, 1, 2].map((side) => (
              <div key={side} className="flex flex-col gap-2">
                <Skeleton className="h-3 w-24" />
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="flex h-9 items-center gap-3">
                    <Skeleton className="h-6 flex-1" />
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-3 w-8" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div aria-hidden className="grid grid-cols-1 gap-10 xl:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:col-span-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-32 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </PageBody>
    </Page>
  );
}
