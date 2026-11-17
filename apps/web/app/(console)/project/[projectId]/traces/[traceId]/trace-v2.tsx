import { notFound } from "next/navigation";
import { TracesUnavailable } from "@/components/console/traces/TracesUnavailable";
import {
  type TraceTab,
  TraceView,
  type TraceViewProps,
} from "@/components/console/traces/TraceView";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { loadPayloadContentSafely } from "@/lib/synthesis/traces/payload-content";
import {
  getTraceSpansWithTruncation,
  listTraceLifecycleEvents,
} from "@/lib/synthesis/traces/queries";
import { firstParam, searchFromParams } from "@/lib/synthesis/traces/v2/filters";
import { runsListPath } from "@/lib/synthesis/traces/v2/run-noun";
import { buildRunSummary } from "@/lib/synthesis/traces/v2/run-summary";
import type { TraceListSearchParams } from "@/lib/synthesis/traces/view";
import { buildTraceWaterfall } from "@/lib/synthesis/traces/waterfall";
import { loadTraceSession } from "@/lib/views/session-chat/trace-session";
import { contentOptIn } from "@/lib/views/session-replay/runs";

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
  // RC-503: Traces opens on Sessions, so the crumb and Compare go back to the Turns tab.
  const list = runsListPath(tracesPath);
  props.listHref = props.listHref.replace(tracesPath, list);
  props.compareHref = props.compareHref.replace(tracesPath, list);
  // RC-472: a turn links to its full session, and keeps the session's turns on top.
  const traceSession = await loadOrFallback({
    operation: "trace_session",
    distinctId: `project:${project.id}`,
    fallback: null,
    load: () =>
      withStatementTimeout(
        async (db) =>
          loadTraceSession(project.id, id, { readContent: await contentOptIn(project.id, db) }, db),
        { operation: "trace_session" },
      ),
  });
  return <TraceView {...props} session={traceSession} />;
}

/**
 * One run's full-trace props: its spans and lifecycle records, read under
 * the page's statement timeouts. Null when the project has no span of it.
 * The session replay's Trace view reads a turn's run through this too. The
 * run's `events.payload` content fills in what the spans do not carry (RC-393).
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
  const [load, lifecycle, payload] = await Promise.all([
    withStatementTimeout((db) => getTraceSpansWithTruncation(projectId, id, db), {
      operation: "trace_detail",
    }),
    withStatementTimeout((db) => listTraceLifecycleEvents(projectId, id, db), {
      operation: "trace_lifecycle",
    }),
    loadPayloadContentSafely(projectId, id, "trace_payload"),
  ]);
  if (load.spans.length === 0) return null;
  const summary = buildRunSummary(load.spans, 0, payload);
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
    payloadContent: payload?.view ?? null,
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
