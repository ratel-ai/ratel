import type { EvidenceSample } from "@/lib/readings/trace-signals/signals/accumulators";
import { evidenceOf, laneOf, round4 } from "@/lib/readings/trace-signals/signals/build";
import type { Floors } from "@/lib/readings/trace-signals/signals/catalog";
import {
  modelMixOf,
  type OtelStats,
  type OtelToolStats,
} from "@/lib/readings/trace-signals/signals/otel-accumulators";
import { wilson, wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import type { AnalysisContext, DetectedSignal } from "@/lib/readings/trace-signals/signals/types";

/**
 * The agent's tool list, read from OTel: tools it calls that it does not have,
 * and tools it is handed every time and never calls.
 *
 * - `unknown_tool` (subject: the called name): calls failing with a
 *   tool-not-found error type (`UNKNOWN_TOOL_ERROR`), or calls of a name absent
 *   from the trace's captured tool menu. An error type like `TaskNotFound`
 *   also matches, and is the tool reporting a missing record rather than being
 *   missing itself, so error-type matches only count for a name that never
 *   succeeded in the window; menu misses always count. Fires at `minCalls`
 *   such calls; severity is the Wilson lower bound of their share of the
 *   name's calls. Measured whenever the window has OTel turns.
 * - `unused_tool` (subject: the project, one signal listing the tools): tools
 *   offered in the menus of at least `minModelCalls` model calls across at
 *   least `minTurns` turns and never called in the window on any lane, nor by
 *   the usage counters since the window opened. One finding, not one per
 *   tool: a big menu can hold dozens, and the fix is the same for all of
 *   them. Severity is the Wilson lower bound of their share of the offered
 *   tools. Measured only when menus are captured.
 */

function sortedTools(stats: OtelStats): OtelToolStats[] {
  return [...stats.tools.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Calls and turns of a tool that count as unknown, after the never-succeeded guard. */
function unknownCounts(tool: OtelToolStats): { calls: number; turns: number; byError: number } {
  const errorCounts = tool.okCalls === 0;
  const byError = errorCounts ? tool.unknownByError : 0;
  return {
    calls: byError + tool.unknownByMenu - (errorCounts ? tool.unknownByBoth : 0),
    turns:
      (errorCounts ? tool.errorTurns : 0) +
      tool.menuTurnsUnknown -
      (errorCounts ? tool.bothTurns : 0),
    byError,
  };
}

/** Error and menu samples, one per turn. */
function unknownSamples(tool: OtelToolStats, withErrors: boolean): EvidenceSample[] {
  const samples = [
    ...(withErrors ? tool.errorEvidence.values() : []),
    ...tool.menuEvidence.values(),
  ];
  return [...new Map(samples.map((s) => [s.turnId, s] as const)).values()];
}

export function unknownTools(stats: OtelStats, floors: Floors): DetectedSignal[] {
  return sortedTools(stats).flatMap((tool) => unknownTool(tool, floors));
}

function unknownTool(tool: OtelToolStats, floors: Floors): DetectedSignal[] {
  const unknown = unknownCounts(tool);
  if (unknown.calls < floors.unknown_tool.minCalls || tool.calls === 0) return [];
  const interval = wilson(unknown.calls, tool.calls);
  return [
    {
      kind: "unknown_tool",
      subjectKind: "tool",
      subjectKey: tool.id,
      subjectIds: [tool.id],
      entryKind: "tool",
      lane: laneOf(tool.mix),
      severity: round4(wilsonLow(unknown.calls, tool.calls)),
      impact: unknown.calls,
      n: tool.calls,
      route: "show_turns",
      metrics: {
        unknown: unknown.calls,
        calls: tool.calls,
        byError: unknown.byError,
        byMenu: tool.unknownByMenu,
        share: round4(unknown.calls / tool.calls),
        low: round4(interval?.low ?? 0),
        high: round4(interval?.high ?? 1),
      },
      evidence: evidenceOf(unknownSamples(tool, unknown.byError > 0), unknown.turns),
    },
  ];
}

function calledSinceWindowOpened(context: AnalysisContext): Set<string> {
  return new Set(
    context.usage
      .filter((u) => u.calls > 0 && u.lastUsedAt.getTime() >= context.windowStart.getTime())
      .map((u) => u.toolId),
  );
}

/** Tools named on the signal at most, most offered first. */
export const MAX_UNUSED_LISTED = 40;

export function unusedTools(
  stats: OtelStats,
  context: AnalysisContext,
  floors: Floors,
): DetectedSignal[] {
  const f = floors.unused_tool;
  const counted = calledSinceWindowOpened(context);
  const unused = sortedTools(stats)
    .filter((tool) => tool.menuCalls >= f.minModelCalls && tool.menuTurns >= f.minTurns)
    .filter((tool) => !stats.calledTools.has(tool.id) && !counted.has(tool.id))
    .sort((a, b) => b.menuCalls - a.menuCalls || (a.id < b.id ? -1 : 1));
  return unused.length === 0 ? [] : [unusedToolsSignal(stats, unused)];
}

function unusedToolsSignal(stats: OtelStats, unused: readonly OtelToolStats[]): DetectedSignal {
  const offered = [...stats.tools.values()].filter((tool) => tool.menuCalls > 0).length;
  const interval = wilson(unused.length, Math.max(offered, unused.length));
  const modelCalls = Math.max(...unused.map((tool) => tool.menuCalls));
  return {
    kind: "unused_tool",
    subjectKind: "project",
    subjectKey: "unused_tools",
    subjectIds: unused.slice(0, MAX_UNUSED_LISTED).map((tool) => tool.id),
    entryKind: "tool",
    lane: laneOf(modelMixOf(stats)),
    severity: round4(interval?.low ?? 0),
    impact: unused.reduce((sum, tool) => sum + tool.menuCalls, 0),
    n: modelCalls,
    route: "retire_tool",
    metrics: {
      tools: unused.length,
      offered,
      modelCalls,
      turns: Math.max(...unused.map((tool) => tool.menuTurns)),
      menuTurns: stats.menuTurns,
      share: round4(unused.length / Math.max(1, offered)),
      low: round4(interval?.low ?? 0),
      high: round4(interval?.high ?? 1),
    },
    evidence: { turnIds: [], traceEventIds: [], totalTurns: 0, turnSourceMix: modelMixOf(stats) },
  };
}
