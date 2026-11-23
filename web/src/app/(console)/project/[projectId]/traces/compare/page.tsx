import { notFound } from "next/navigation";
import { BackLink } from "@/components/console/traces/compare/BackLink";
import { TraceCompareView } from "@/components/console/traces/compare/TraceCompareView";
import { TraceLifecycleComparison } from "@/components/console/traces/compare/TraceLifecycleEvents";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getProjectById } from "@/lib/platform/projects/queries";
import { summarizeTraceForComparison } from "@/lib/synthesis/traces/comparison";
import {
  getTraceSpansWithTruncation,
  listTraceLifecycleEvents,
  TRACE_SPAN_LIMIT,
} from "@/lib/synthesis/traces/queries";
import { buildTraceListHref } from "@/lib/synthesis/traces/record-table";
import { resolveTraceCompareIds, type TraceCompareSearchParams } from "@/lib/synthesis/traces/view";

export const metadata = { title: "Compare traces" };

/** Two runs side by side: upstream's compare content, for a project the layout already guarded. */
export default async function TraceComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<TraceCompareSearchParams>;
}) {
  if (!isDbConfigured()) {
    return (
      <p className="rounded-lg border border-coral/40 bg-coral/10 p-3 font-mono text-xs text-cream-dim">
        No database connected yet. Traces become available once setup finishes.
      </p>
    );
  }

  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const traceIds = resolveTraceCompareIds(query);
  if (!traceIds) notFound();

  const project = await getProjectById(projectId);
  if (!project) notFound();
  const [leftLoad, rightLoad] = await Promise.all([
    getTraceSpansWithTruncation(project.id, traceIds[0]),
    getTraceSpansWithTruncation(project.id, traceIds[1]),
  ]);
  if (leftLoad.spans.length === 0 || rightLoad.spans.length === 0) {
    notFound();
  }
  const [leftLifecycleEvents, rightLifecycleEvents] = await Promise.all([
    listTraceLifecycleEvents(project.id, traceIds[0]),
    listTraceLifecycleEvents(project.id, traceIds[1]),
  ]);

  const backHref = buildTraceListHref(`/project/${project.id}/traces`, {
    ...query,
    project: project.slug,
    a: undefined,
    b: undefined,
  });

  return (
    <div className="flex flex-col gap-5">
      <BackLink href={backHref}>All traces</BackLink>
      <TraceCompareView
        left={summarizeTraceForComparison(leftLoad.spans)}
        right={summarizeTraceForComparison(rightLoad.spans)}
        leftTruncated={leftLoad.truncated}
        rightTruncated={rightLoad.truncated}
        spanLimit={TRACE_SPAN_LIMIT}
        spanComparison={
          <TraceLifecycleComparison
            leftEvents={leftLifecycleEvents}
            rightEvents={rightLifecycleEvents}
          />
        }
      />
    </div>
  );
}
