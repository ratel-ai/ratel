import { evidenceOf, laneOf, round4 } from "@/lib/readings/trace-signals/signals/build";
import type { Floors } from "@/lib/readings/trace-signals/signals/catalog";
import type {
  OtelStats,
  OtelToolStats,
  SwitchStats,
} from "@/lib/readings/trace-signals/signals/otel-accumulators";
import { wilson, wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import type { DetectedSignal } from "@/lib/readings/trace-signals/signals/types";

/**
 * What the agent does when a tool lets it down, read from OTel tool spans.
 *
 * - `tool_switch` (subject: the ordered pair A>B): a call of A that failed, or
 *   came back empty when results are captured, followed at once by a call of a
 *   different tool B that worked. Fires when the switch happens in at least
 *   `minTurns` turns and in at least `minShare` of the OTel turns that call A
 *   (a point estimate, as `sequence_chain` uses). Turns rather than calls, so
 *   one turn retrying A five times before B counts once. Severity is the
 *   Wilson lower bound of that share. Works from errors alone; captured
 *   results add the empty case.
 * - `empty_result` (subject: the tool): the share of A's captured results that
 *   are empty. Fires at `minCaptured` captured results, a share of at least
 *   `minShare` and a Wilson lower bound of at least `minLow`, which is also
 *   its severity. Measured only when some result was captured.
 */

function sortedValues<T>(map: ReadonlyMap<string, T>): T[] {
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, value]) => value);
}

export function toolSwitches(stats: OtelStats, floors: Floors): DetectedSignal[] {
  return sortedValues(stats.switches).flatMap((pair) => toolSwitch(stats, pair, floors));
}

function toolSwitch(stats: OtelStats, pair: SwitchStats, floors: Floors): DetectedSignal[] {
  const f = floors.tool_switch;
  const n = stats.tools.get(pair.from)?.turns ?? 0;
  const k = pair.turns;
  if (k < f.minTurns || n === 0 || k / n < f.minShare) return [];
  const interval = wilson(k, n);
  return [
    {
      kind: "tool_switch",
      subjectKind: "tool_pair",
      subjectKey: `${pair.from}>${pair.to}`,
      subjectIds: [pair.from, pair.to],
      entryKind: "tool",
      lane: laneOf(stats.mix),
      severity: round4(wilsonLow(k, n)),
      impact: k,
      n,
      route: "disambiguate_pair",
      metrics: {
        k,
        n,
        share: round4(k / n),
        byError: pair.byError,
        byEmpty: pair.byEmpty,
        low: round4(interval?.low ?? 0),
        high: round4(interval?.high ?? 1),
      },
      evidence: evidenceOf(pair.evidence.values(), k),
    },
  ];
}

export function emptyResults(stats: OtelStats, floors: Floors): DetectedSignal[] {
  return sortedValues(stats.tools).flatMap((tool) => emptyResult(tool, floors));
}

function emptyResult(tool: OtelToolStats, floors: Floors): DetectedSignal[] {
  const f = floors.empty_result;
  const n = tool.captured;
  const k = tool.empty;
  const low = wilsonLow(k, n);
  if (n < f.minCaptured || k / n < f.minShare || low < f.minLow) return [];
  const interval = wilson(k, n);
  return [
    {
      kind: "empty_result",
      subjectKind: "tool",
      subjectKey: tool.id,
      subjectIds: [tool.id],
      entryKind: "tool",
      lane: laneOf(tool.mix),
      severity: round4(low),
      impact: k,
      n,
      route: "rewrite_description",
      metrics: {
        k,
        n,
        calls: tool.calls,
        share: round4(k / n),
        low: round4(interval?.low ?? 0),
        high: round4(interval?.high ?? 1),
      },
      evidence: evidenceOf(tool.emptyEvidence.values(), tool.emptyEvidence.total),
    },
  ];
}
