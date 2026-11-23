import type { TraceContentView } from "@/lib/synthesis/traces/content-view";
import type { AgentSubtree } from "@/lib/synthesis/traces/v2/agent-rollup";
import type { RunMetrics } from "@/lib/synthesis/traces/v2/run-metrics";
import type { RunTotals } from "@/lib/synthesis/traces/v2/run-summary";
import type { RunStatus } from "@/lib/synthesis/traces/v2/runs";
import type { TraceWaterfallView } from "@/lib/synthesis/traces/waterfall";
import type { TraceSession } from "@/lib/views/session-chat/trace-session";

/**
 * The props of one run's full-trace view, for the code under lib/ that builds them: the trace
 * page's loader (`trace-view-props.ts`), get_trace's MCP view (`lib/mcp/operations/observability.ts`)
 * and the content-free copy (`without-captured-text.ts`).
 *
 * Owned, no upstream counterpart (ADR-0004): upstream declares these in
 * `components/traces/v2/TraceView.tsx` and imports them from lib/; here lib/ never imports the
 * UI, so the same shape lives in the layer that builds it. `rewrites.json` partitions the two
 * names out of the component's specifier. The component keeps its own declaration, and the trace
 * page hands these props straight to it, so a drift between the two fails the typecheck.
 */
export type TraceTab = "timeline" | "conversation" | "details" | "ranking";

/** A lifecycle record the Ranking tab lists, as `components/console/traces/TraceRanking.tsx` reads it. */
export interface LifecycleRecord {
  id: string;
  eventName: string;
  occurredAt: string;
  experimentName: string | null;
  experimentArm: string | null;
  experimentRole: string | null;
  experimentAttrs: Record<string, unknown>;
}

export interface TraceViewProps {
  projectId: string;
  traceId: string;
  /** The ask when captured, else the root span in plain words. */
  title: string;
  service: string | null;
  startedAt: string;
  status: RunStatus;
  totals: RunTotals;
  waterfall: TraceWaterfallView;
  /** The run's agents with each subtree's totals (AOBS-5); empty without a sub-agent. */
  agents?: readonly AgentSubtree[];
  /** How the run ran (AOBS-7): time split, context, cache and run events; null with nothing to show. */
  runMetrics?: RunMetrics | null;
  truncated: boolean;
  /** The run's `events.payload` content, read on the server; the spans' own content wins when they carry any. */
  payloadContent?: TraceContentView | null;
  lifecycle: readonly LifecycleRecord[];
  /** The list this trace was opened from, filters and page included. */
  listHref: string;
  /** The list with this run picked for comparison. */
  compareHref: string;
  initialTab: TraceTab;
  initialSpanId: string | null;
  runtimeEventsRoot: string | null;
  /** Inside another page (the session replay's Trace view): no page frame, a heading row instead. */
  embedded?: boolean;
  /** The session this turn is part of, and its turns (RC-472). */
  session?: TraceSession | null;
  /**
   * Read the run's raw spans from the app's raw route (views redesign). Off in an MCP view, which
   * cannot reach the app's routes: the span pane keeps the stored spans, as when the read fails.
   */
  fetchRaw?: boolean;
}
