import { notFound } from "next/navigation";
import { TracesUnavailable } from "@/components/console/traces/TracesUnavailable";
import {
  type TraceTab,
  TraceView,
  type TraceViewProps,
} from "@/components/console/traces/TraceView";
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

  const { span, tab, ...listParams } = searchParams;
  const requestedTab = firstParam(tab);
  const tracesPath = `/project/${encodeURIComponent(project.id)}/traces`;
  const id = traceId.toLowerCase();
  const props = await loadTraceViewProps(project.id, id, {
    listHref: `${tracesPath}${searchFromParams({ ...listParams, peek: undefined, compare: undefined, project: undefined })}`,
    compareHref: `${tracesPath}${searchFromParams({ ...listParams, peek: undefined, project: undefined, compare: id })}`,
    tab: requestedTab,
    spanId: firstParam(span) ?? null,
  });
  if (!props) notFound();
  return <TraceView {...props} />;
}

/**
 * One run's full-trace props: its spans and lifecycle records, read under
 * the page's statement timeouts. Null when the project has no span of it.
 * The session replay's Trace view reads a turn's run through this too.
 */
export async function loadTraceViewProps(
  projectId: string,
  traceId: string,
  options: {
    listHref: string;
    compareHref: string;
    tab: string | undefined;
    spanId: string | null;
  },
): Promise<TraceViewProps | null> {
  const id = traceId.toLowerCase();
  const [load, lifecycle] = await Promise.all([
    withStatementTimeout((db) => getTraceSpansWithTruncation(projectId, id, db), {
      operation: "trace_detail",
    }),
    withStatementTimeout((db) => listTraceLifecycleEvents(projectId, id, db), {
      operation: "trace_lifecycle",
    }),
  ]);
  if (load.spans.length === 0) return null;
  const summary = buildRunSummary(load.spans, 0);
  const root = load.spans.find((span) => span.parentSpanId === null) ?? load.spans[0];
  return {
    projectId,
    traceId: id,
    title: summary.title,
    service: root?.serviceName ?? null,
    startedAt: summary.startedAt,
    status: summary.status,
    totals: summary.totals,
    waterfall: buildTraceWaterfall(load.spans),
    truncated: load.truncated,
    lifecycle: lifecycle.map((event) => ({
      id: event.id,
      eventName: event.eventName,
      occurredAt: event.occurredAt.toISOString(),
      experimentName: event.experimentName,
      experimentArm: event.experimentArm,
      experimentRole: event.experimentRole,
      experimentAttrs: event.experimentAttrs,
    })),
    listHref: options.listHref,
    compareHref: options.compareHref,
    initialTab: options.tab && TABS.has(options.tab) ? (options.tab as TraceTab) : "timeline",
    initialSpanId: options.spanId,
    runtimeEventsRoot: `/project/${encodeURIComponent(projectId)}/runtime-events`,
  };
}
