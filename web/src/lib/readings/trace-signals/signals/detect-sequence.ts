import type { ProjectStats } from "@/lib/readings/trace-signals/signals/accumulators";
import {
  entrySubject,
  evidenceOf,
  laneOf,
  round4,
  sortedEntries,
} from "@/lib/readings/trace-signals/signals/build";
import { DEFAULT_FLOORS, type Floors } from "@/lib/readings/trace-signals/signals/catalog";
import type { PairStats } from "@/lib/readings/trace-signals/signals/pairs";
import { wilson, wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import type { DetectedSignal, DetectionResult } from "@/lib/readings/trace-signals/signals/types";

/**
 * Sequence signals: what the agent does after running a tool.
 *
 * - `sequence_chain` (pairs, pass two): `a` then `b` in the same turn far more
 *   often than chance. Fires on the point estimates the plan names (lift and
 *   P(b|a)); severity is the Wilson lower bound of P(b|a). `dependency` when
 *   the pair nearly always runs in this order, else `co_occurrence`.
 *   `viaSearch` is the share of those turns that needed a fresh search to reach
 *   `b`: a high one is what a workflow skill saves.
 * - `no_follow_through`: an ok call followed at once by a search for the same
 *   thing as the search that led to it (`same-ask.ts`): the agent kept
 *   looking, so the call likely did not deliver. A search for a new need
 *   after a call is a next step and is not counted.
 * - `repeat_invoke`: a tool called `minCalls` or more times (ok) in one turn.
 *
 * `no_follow_through` and `repeat_invoke` also carry a Wilson share floor
 * (`minLow`), an addition to the plan's count floors, so a busy tool with a
 * handful of such turns out of thousands does not open a signal.
 *
 * Only `sequence_chain` reads pass two; the other two are pass-one counters.
 * With `pairPassRan` false (the run skipped pass two), `sequence_chain` is not
 * measured, so its open signals are kept instead of counted as missed.
 */

export function detectSequence(
  stats: ProjectStats,
  pairs: PairStats,
  floors: Floors = DEFAULT_FLOORS,
  pairPassRan = true,
): DetectionResult {
  const entries = sortedEntries(stats.entries);
  return {
    signals: [
      ...(pairPassRan ? sequenceChains(stats, pairs, floors) : []),
      ...entries.flatMap((entry) => noFollowThrough(entry, floors)),
      ...entries.flatMap((entry) => repeatInvoke(entry, floors)),
    ],
    measured: new Set([
      ...(pairPassRan ? (["sequence_chain"] as const) : []),
      "no_follow_through",
      "repeat_invoke",
    ]),
  };
}

type Entry = ReturnType<typeof sortedEntries>[number];

function sequenceChains(stats: ProjectStats, pairs: PairStats, floors: Floors): DetectedSignal[] {
  const f = floors.sequence_chain;
  const found: DetectedSignal[] = [];
  for (const [key, pair] of [...pairs.ordered].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [a, b] = key.split(">") as [string, string];
    const turnsA = stats.entries.get(`tool:${a}`)?.invokeTurns ?? 0;
    const turnsB = stats.entries.get(`tool:${b}`)?.invokeTurns ?? 0;
    if (pair.n < f.minPairs || turnsA === 0 || turnsB === 0 || stats.turnsWithInvoke === 0)
      continue;
    const conditional = pair.n / turnsA;
    const lift = conditional / (turnsB / stats.turnsWithInvoke);
    if (lift < f.minLift || conditional < f.minConditional) continue;
    const reverse = pairs.ordered.get(`${b}>${a}`)?.n ?? 0;
    const dependency = pair.n / (pair.n + reverse) >= f.dependencyShare;
    const viaShare = pair.viaSearch / pair.n;
    const ofB = wilson(pair.n, turnsB);
    found.push({
      kind: "sequence_chain",
      subjectKind: "tool_pair",
      subjectKey: key,
      subjectIds: [a, b],
      entryKind: "tool",
      lane: laneOf(stats.mix),
      severity: round4(wilsonLow(pair.n, turnsA)),
      impact: Math.round(pair.n * (1 + viaShare)),
      n: pair.n,
      route: viaShare >= f.workflowViaSearch ? "workflow_skill" : "none",
      metrics: {
        n: pair.n,
        reverse,
        turnsA,
        turnsB,
        conditional: round4(conditional),
        lift: round4(lift),
        relation: dependency ? "dependency" : "co_occurrence",
        viaSearch: pair.viaSearch,
        viaShare: round4(viaShare),
        shareOfB: round4(pair.n / turnsB),
        low: round4(ofB?.low ?? 0),
        high: round4(ofB?.high ?? 1),
      },
      evidence: evidenceOf(pair.evidence.values(), pair.n),
    });
  }
  return found;
}

function noFollowThrough(entry: Entry, floors: Floors): DetectedSignal[] {
  const f = floors.no_follow_through;
  const n = entry.noFollowN;
  const k = entry.noFollowK;
  const low = wilsonLow(k, n);
  if (n < f.minN || k < f.minK || low < f.minLow) return [];
  const interval = wilson(k, n);
  return [
    {
      kind: "no_follow_through",
      ...entrySubject(entry),
      lane: laneOf(entry.mix),
      severity: round4(low),
      impact: k,
      n,
      route: "rewrite_description",
      metrics: {
        k,
        n,
        share: round4(k / n),
        low: round4(interval?.low ?? 0),
        high: round4(interval?.high ?? 1),
        withinMs: f.withinMs,
      },
      evidence: evidenceOf(entry.evidence.noFollow.values(), k),
    },
  ];
}

function repeatInvoke(entry: Entry, floors: Floors): DetectedSignal[] {
  const f = floors.repeat_invoke;
  const n = entry.invokeTurns;
  const k = entry.repeatTurns;
  const low = wilsonLow(k, n);
  if (n < f.minN || k < f.minK || low < f.minLow) return [];
  const interval = wilson(k, n);
  return [
    {
      kind: "repeat_invoke",
      ...entrySubject(entry),
      lane: laneOf(entry.mix),
      severity: round4(low),
      impact: entry.repeatExtra,
      n,
      route: "show_turns",
      metrics: {
        k,
        n,
        share: round4(k / n),
        low: round4(interval?.low ?? 0),
        high: round4(interval?.high ?? 1),
        extraCalls: entry.repeatExtra,
        minCalls: f.minCalls,
      },
      evidence: evidenceOf(entry.evidence.repeat.values(), k),
    },
  ];
}
