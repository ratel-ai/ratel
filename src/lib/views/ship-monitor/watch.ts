import type { FixKind } from "@/lib/views/fixes/kinds";
import { toolChanges } from "./changes";

/**
 * Ship → Monitor: how a shipped fix behaves in live traffic. For each tool the
 * fix changes, its calls, error rate and median latency since the ship beside
 * the 7 days before it; for each tool the fix takes out of the agent's calls,
 * how often it is still called (expected: never); for the runs that use the
 * fix's tools, tool calls and tokens per run before and after; and a verdict.
 *
 * "Runs of the fix's task" are read as the runs that call one of its tools:
 * a run after the ship is assigned a task only when the analysis runs again,
 * and a live watch cannot wait for that. Pure, client-safe; `load.ts` reads
 * the facts.
 */

export type WatchStatus = "healthy" | "watching" | "regressed";

export interface WatchShipment {
  id: string;
  fixId: string;
  fixKind: FixKind;
  fixTitle: string | null;
  version: string;
  /** ISO time. */
  shippedAt: string;
  /** The tools the fix names, in its order. */
  tools: string[];
}

/** One tool's calls in a window, as read. */
export interface ToolFacts {
  toolId: string;
  calls: number;
  errors: number;
  p50Ms: number | null;
}

/** Totals over the runs that call one of the fix's tools. */
export interface RunFacts {
  runs: number;
  toolCalls: number;
  /** Input plus output tokens of their model calls; null when none carry a count. */
  tokens: number | null;
}

export interface TraceFacts {
  traceId: string;
  startedAt: string;
  /** The fix's tools the trace called. */
  tools: string[];
  error: boolean;
}

export interface WatchFacts {
  /** The 7 days before the ship. */
  before: { tools: ToolFacts[]; runs: RunFacts };
  /** From the ship to now. */
  after: { tools: ToolFacts[]; runs: RunFacts };
  /** Newest first. */
  traces: TraceFacts[];
}

export interface ToolWindow {
  calls: number;
  errors: number;
  errorRate: number | null;
  p50Ms: number | null;
}

export interface ChangedToolWatch {
  toolId: string;
  after: ToolWindow;
  baseline: ToolWindow;
}

export interface RemovedToolWatch {
  toolId: string;
  /** Calls since the ship; 0 is what the fix promises. */
  callsAfter: number;
  baselineCalls: number;
  flagged: boolean;
}

export interface RunWindow {
  runs: number;
  toolCallsPerRun: number | null;
  tokensPerRun: number | null;
}

export interface WatchTrace extends TraceFacts {
  href: string;
  calledRemoved: boolean;
}

export interface ShipmentWatch {
  shipment: WatchShipment;
  checkedAt: string;
  changed: ChangedToolWatch[];
  removed: RemovedToolWatch[];
  runs: { tools: string[]; before: RunWindow; after: RunWindow };
  verdict: { status: WatchStatus; reasons: string[] };
  traces: WatchTrace[];
  minRuns: number;
}

/** Runs since the ship before a verdict other than Watching (small, for a live demo). */
export const MIN_RUNS = 10;
/** The baseline window, before the ship. */
export const BASELINE_DAYS = 7;
/** Calls in each window before a tool's errors or latency are compared. */
const MIN_COMPARED_CALLS = 5;
/** Clearly worse: the error rate up by 5 points and by half; the median latency up by half and 100 ms. */
const ERROR_POINTS = 0.05;
const WORSE_RATIO = 1.5;
const LATENCY_FLOOR_MS = 100;

export function buildWatch(
  projectId: string,
  shipment: WatchShipment,
  facts: WatchFacts,
  now: Date,
): ShipmentWatch {
  const { changed, removed } = toolChanges(shipment.fixKind, shipment.tools);
  const toolsBefore = byTool(facts.before.tools);
  const toolsAfter = byTool(facts.after.tools);
  const changedWatch = changed.map((toolId) => ({
    toolId,
    after: windowOf(toolsAfter.get(toolId)),
    baseline: windowOf(toolsBefore.get(toolId)),
  }));
  const removedWatch = removed.map((toolId) => {
    const callsAfter = toolsAfter.get(toolId)?.calls ?? 0;
    return {
      toolId,
      callsAfter,
      baselineCalls: toolsBefore.get(toolId)?.calls ?? 0,
      flagged: callsAfter > 0,
    };
  });
  const after = runWindow(facts.after.runs);
  const removedSet = new Set(removed);
  return {
    shipment,
    checkedAt: now.toISOString(),
    changed: changedWatch,
    removed: removedWatch,
    runs: { tools: [...changed, ...removed], before: runWindow(facts.before.runs), after },
    verdict: verdictOf(changedWatch, removedWatch, after.runs),
    traces: facts.traces.map((trace) => ({
      ...trace,
      href: `/project/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(trace.traceId)}`,
      calledRemoved: trace.tools.some((tool) => removedSet.has(tool)),
    })),
    minRuns: MIN_RUNS,
  };
}

/** Regressed beats Watching: a removed tool called once is already a finding. */
function verdictOf(
  changed: readonly ChangedToolWatch[],
  removed: readonly RemovedToolWatch[],
  runsAfter: number,
): ShipmentWatch["verdict"] {
  const regressions = [
    ...removed
      .filter((tool) => tool.flagged)
      .map(
        (tool) =>
          `${tool.toolId} was called ${plural(tool.callsAfter, "time")} after the ship. Expected 0.`,
      ),
    ...changed.flatMap(worseThanBefore),
  ];
  if (regressions.length > 0) return { status: "regressed", reasons: regressions };
  if (runsAfter < MIN_RUNS)
    return { status: "watching", reasons: [`${runsAfter} of ${MIN_RUNS} runs since the ship.`] };
  return {
    status: "healthy",
    reasons: [
      `${runsAfter} runs since the ship. Errors and latency are in line with the 7 days before.`,
    ],
  };
}

function worseThanBefore(tool: ChangedToolWatch): string[] {
  const { after, baseline } = tool;
  if (after.calls < MIN_COMPARED_CALLS || baseline.calls < MIN_COMPARED_CALLS) return [];
  const out: string[] = [];
  if (
    after.errorRate !== null &&
    baseline.errorRate !== null &&
    after.errorRate >= baseline.errorRate + ERROR_POINTS &&
    after.errorRate >= baseline.errorRate * WORSE_RATIO
  ) {
    out.push(
      `${tool.toolId} fails ${percent(after.errorRate)} of calls, up from ${percent(baseline.errorRate)}.`,
    );
  }
  if (
    after.p50Ms !== null &&
    baseline.p50Ms !== null &&
    after.p50Ms >= baseline.p50Ms * WORSE_RATIO &&
    after.p50Ms - baseline.p50Ms >= LATENCY_FLOOR_MS
  ) {
    out.push(
      `${tool.toolId} takes ${Math.round(after.p50Ms)} ms at the median, up from ${Math.round(baseline.p50Ms)} ms.`,
    );
  }
  return out;
}

function byTool(tools: readonly ToolFacts[]): Map<string, ToolFacts> {
  return new Map(tools.map((tool) => [tool.toolId, tool]));
}

function windowOf(facts: ToolFacts | undefined): ToolWindow {
  if (!facts) return { calls: 0, errors: 0, errorRate: null, p50Ms: null };
  return {
    calls: facts.calls,
    errors: facts.errors,
    errorRate: facts.calls > 0 ? facts.errors / facts.calls : null,
    p50Ms: facts.p50Ms,
  };
}

function runWindow(facts: RunFacts): RunWindow {
  const perRun = (n: number | null) => (n === null || facts.runs === 0 ? null : n / facts.runs);
  return {
    runs: facts.runs,
    toolCallsPerRun: perRun(facts.toolCalls),
    tokensPerRun: perRun(facts.tokens),
  };
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
