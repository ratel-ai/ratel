import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadPayloadContentSafely } from "@/lib/synthesis/traces/payload-content";
import {
  getTraceSpansWithTruncation,
  listTraceLifecycleEvents,
} from "@/lib/synthesis/traces/queries";
import {
  type AgentSubtree,
  agentSubtrees,
  hasSubAgents,
} from "@/lib/synthesis/traces/v2/agent-rollup";
import { buildRunMetrics, type RunMetrics } from "@/lib/synthesis/traces/v2/run-metrics";
import { buildRunSummary } from "@/lib/synthesis/traces/v2/run-summary";
import { buildTraceWaterfall } from "@/lib/synthesis/traces/waterfall";
import type { TraceTab, TraceViewProps } from "@/lib/views/traces/trace-view-types";

const TABS: ReadonlySet<string> = new Set(["timeline", "conversation", "details", "ranking"]);

/**
 * One run's full-trace props: its spans and lifecycle records, read under
 * the page's statement timeouts. Null when the project has no span of it.
 * The trace page (app/(app)/project/[projectId]/traces/[traceId]), the session
 * replay's Trace view and get_trace's MCP view read a run through this. The
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
  const runtimeEventsEnabled = true;
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
    // AOBS-5: the run's agents with each subtree's totals, when it handed work to a sub-agent.
    agents: subAgentRows(agentSubtrees(load.spans)),
    // AOBS-7: how the run ran.
    runMetrics: shownRunMetrics(buildRunMetrics(load.spans)),
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
    runtimeEventsRoot: runtimeEventsEnabled
      ? `/project/${encodeURIComponent(projectId)}/runtime-events`
      : null,
  };
}

/** A run with no model call, no run attribute and no event has nothing to show. */
function shownRunMetrics(metrics: RunMetrics): RunMetrics | null {
  return metrics.empty ? null : metrics;
}

/** A run with only its main agent has nothing to break down: the header already has its totals. */
function subAgentRows(agents: AgentSubtree[]): AgentSubtree[] {
  return hasSubAgents(agents) ? agents : [];
}
