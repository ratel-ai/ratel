import { notFound } from "next/navigation";
import { TracesUnavailable } from "@/components/console/traces/TracesUnavailable";
import { type TraceTab, TraceView } from "@/components/console/traces/TraceView";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import {
  getTraceSpansWithTruncation,
  listTraceLifecycleEvents,
} from "@/lib/synthesis/traces/queries";
import { firstParam, searchFromParams } from "@/lib/synthesis/traces/v2/filters";
import { buildRunSummary } from "@/lib/synthesis/traces/v2/run-summary";
import type { TraceListSearchParams } from "@/lib/synthesis/traces/view";
import { buildTraceWaterfall } from "@/lib/synthesis/traces/waterfall";

const TABS: ReadonlySet<string> = new Set(["timeline", "conversation", "details", "ranking"]);

/**
 * The v2 full trace's data: the same span load and lifecycle records the v1
 * page reads, plus the run summary for the header. The list's query rides
 * along so the crumb goes back to the exact list view.
 */
export async function TracePageV2({
  projectId,
  traceId,
  searchParams,
}: {
  projectId: string;
  traceId: string;
  searchParams: TraceListSearchParams & {
    span?: string | readonly string[];
    tab?: string | readonly string[];
  };
}) {
  if (!isDbConfigured()) return <TracesUnavailable title="Trace" />;
  // The project layout already guarded the id against the session.
  const project = { id: projectId };

  const id = traceId.toLowerCase();
  const [load, lifecycle] = await Promise.all([
    withStatementTimeout((db) => getTraceSpansWithTruncation(project.id, id, db), {
      operation: "trace_detail",
    }),
    withStatementTimeout((db) => listTraceLifecycleEvents(project.id, id, db), {
      operation: "trace_lifecycle",
    }),
  ]);
  if (load.spans.length === 0) notFound();

  const summary = buildRunSummary(load.spans, 0);
  const root = load.spans.find((span) => span.parentSpanId === null) ?? load.spans[0];
  const { span, tab, ...listParams } = searchParams;
  const requestedTab = firstParam(tab);
  const tracesPath = `/project/${encodeURIComponent(project.id)}/traces`;
  const listSearch = searchFromParams({
    ...listParams,
    peek: undefined,
    compare: undefined,
    project: undefined,
  });

  return (
    <TraceView
      projectId={project.id}
      traceId={id}
      title={summary.title}
      service={root?.serviceName ?? null}
      startedAt={summary.startedAt}
      status={summary.status}
      totals={summary.totals}
      waterfall={buildTraceWaterfall(load.spans)}
      truncated={load.truncated}
      lifecycle={lifecycle.map((event) => ({
        id: event.id,
        eventName: event.eventName,
        occurredAt: event.occurredAt.toISOString(),
        experimentName: event.experimentName,
        experimentArm: event.experimentArm,
        experimentRole: event.experimentRole,
        experimentAttrs: event.experimentAttrs,
      }))}
      listHref={`${tracesPath}${listSearch}`}
      compareHref={`${tracesPath}${searchFromParams({ ...listParams, peek: undefined, project: undefined, compare: id })}`}
      initialTab={requestedTab && TABS.has(requestedTab) ? (requestedTab as TraceTab) : "timeline"}
      initialSpanId={firstParam(span) ?? null}
      // No runtime-events page in this build.
      runtimeEventsRoot={null}
    />
  );
}
