import { evidenceOf, laneOf, round4 } from "@/lib/readings/trace-signals/signals/build";
import type { Floors } from "@/lib/readings/trace-signals/signals/catalog";
import {
  type ModelCallBucket,
  modelMixOf,
  type OtelStats,
} from "@/lib/readings/trace-signals/signals/otel-accumulators";
import { wilson, wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import type { DetectedSignal } from "@/lib/readings/trace-signals/signals/types";

/**
 * `long_turn` (subject: the project): turns that take far more model round
 * trips than the project's typical turn, read from the model-call spans of
 * each OTel trace.
 *
 * A turn is long at `max(minCalls, medianMultiple x median)` model calls or
 * more, the median taken over the window's OTel turns with at least one model
 * call. Fires when at least `minTurns` turns are long and they are at least
 * `minShare` of those turns; severity is the Wilson lower bound of that share.
 * The claim names the tools most over-represented in long turns (at least
 * `minToolTurns` long turns, and `minToolRatio` times their share of turns
 * overall), at most {@link LONG_TURN_TOOLS_NAMED}. Measured whenever some
 * OTel turn had a model call.
 */

export const LONG_TURN_TOOLS_NAMED = 3;

/** The median of the per-turn model-call counts, by nearest rank (as `severity.median`). */
export function bucketMedian(buckets: ReadonlyMap<number, ModelCallBucket>, total: number): number {
  const rank = Math.max(0, Math.ceil(0.5 * total) - 1);
  let seen = 0;
  for (const [calls, bucket] of [...buckets].sort(([a], [b]) => a - b)) {
    seen += bucket.turns;
    if (seen > rank) return calls;
  }
  return 0;
}

interface ToolLean {
  id: string;
  longTurns: number;
  ratio: number;
}

function toolTurnsOf(buckets: readonly ModelCallBucket[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const bucket of buckets) {
    for (const [id, n] of bucket.toolTurns) out.set(id, (out.get(id) ?? 0) + n);
  }
  return out;
}

function overRepresented(
  stats: OtelStats,
  long: readonly ModelCallBucket[],
  longTurns: number,
  floors: Floors,
): ToolLean[] {
  const f = floors.long_turn;
  const overall = toolTurnsOf([...stats.buckets.values()]);
  return [...toolTurnsOf(long)]
    .map(([id, inLong]) => ({
      id,
      longTurns: inLong,
      ratio: inLong / longTurns / ((overall.get(id) ?? inLong) / stats.modelTurns),
    }))
    .filter((tool) => tool.longTurns >= f.minToolTurns && tool.ratio >= f.minToolRatio)
    .sort((a, b) => b.ratio - a.ratio || b.longTurns - a.longTurns || (a.id < b.id ? -1 : 1))
    .slice(0, LONG_TURN_TOOLS_NAMED);
}

export function longTurns(stats: OtelStats, floors: Floors): DetectedSignal[] {
  const f = floors.long_turn;
  const n = stats.modelTurns;
  if (n === 0) return [];
  const medianCalls = bucketMedian(stats.buckets, n);
  const threshold = Math.max(f.minCalls, Math.ceil(f.medianMultiple * medianCalls));
  const long = [...stats.buckets]
    .filter(([calls]) => calls >= threshold)
    .map(([, bucket]) => bucket);
  const k = long.reduce((sum, bucket) => sum + bucket.turns, 0);
  if (k < f.minTurns || k / n < f.minShare) return [];
  const tools = overRepresented(stats, long, k, floors);
  const interval = wilson(k, n);
  const inputTokens = [...stats.buckets.values()].reduce(
    (sum, bucket) => sum + bucket.inputTokens,
    0,
  );
  return [
    {
      kind: "long_turn",
      subjectKind: "project",
      subjectKey: "project",
      subjectIds: tools.map((tool) => tool.id),
      entryKind: "tool",
      lane: laneOf(modelMixOf(stats)),
      severity: round4(wilsonLow(k, n)),
      impact: k,
      n,
      route: "show_turns",
      metrics: {
        k,
        n,
        share: round4(k / n),
        medianCalls,
        threshold,
        inputTokens,
        longInputTokens: long.reduce((sum, bucket) => sum + bucket.inputTokens, 0),
        tools: tools.map((tool) => tool.id),
        toolLongTurns: tools.map((tool) => tool.longTurns),
        toolRatios: tools.map((tool) => round4(tool.ratio)),
        low: round4(interval?.low ?? 0),
        high: round4(interval?.high ?? 1),
      },
      evidence: evidenceOf(
        long.flatMap((bucket) => [...bucket.evidence.values()]),
        k,
      ),
    },
  ];
}
