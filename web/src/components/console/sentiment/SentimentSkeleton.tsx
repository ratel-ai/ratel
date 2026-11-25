"use client";

import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Skeleton } from "@ratel/design-system/states";
import { useParams } from "next/navigation";
import { SENTIMENT_DESCRIPTION } from "@/components/console/sentiment/copy";
import { projectRoot } from "@/lib/console/navigation";
import { agentHealthHref } from "@/lib/readings/trace-signals/view";

/** The page's layout while it loads: the same header, the four numbers, the task statuses, the daily chart and the reasons table. */
export function SentimentSkeleton({
  title = "Sentiment analysis",
  description = SENTIMENT_DESCRIPTION,
  parent = "traces",
}: {
  title?: string;
  description?: string /** The page it sits under, as its breadcrumb. */;
  parent?: "traces" | "health";
} = {}) {
  const params = useParams<{ projectId?: string }>();
  const projectId = typeof params?.projectId === "string" ? params.projectId : null;
  const crumb = !projectId
    ? undefined
    : parent === "health"
      ? { label: "Agent health", href: agentHealthHref(projectId) }
      : { label: "Traces", href: `${projectRoot(projectId)}/traces` };
  return (
    <Page>
      <PageHeader title={title} crumbs={crumb ? [crumb] : undefined} description={description} />
      <PageBody wide>
        <div aria-hidden className="flex flex-col gap-8">
          <Skeleton className="h-28 w-full" />
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-2 w-full" />
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-[13rem] w-full" />
          </div>
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-52" />
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        </div>
      </PageBody>
    </Page>
  );
}
