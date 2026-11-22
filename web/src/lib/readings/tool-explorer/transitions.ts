import type {
  ExplorerEdge,
  ExplorerEdgeKind,
  ExplorerScope,
  ExplorerSubject,
  ExplorerUnit,
} from "@/lib/readings/tool-explorer/types";
import { Reservoir, wilson } from "@/lib/readings/trace-signals/signals/severity";

/**
 * Directed edges between the ids a unit calls.
 *
 * - `next`: for every adjacent pair of calls (a, b) in a unit, with repeats of
 *   a already collapsed. `nA` is the calls of a that had a successor, so `p`
 *   is the chance the agent's next call after a is b: a row of the transition
 *   matrix sums to one.
 * - `before`: a's first call preceded b's first call in the unit, counted once
 *   per unit, which is what Agent health's `pairs.ts` counts for its chains.
 *   `nA` is the units that called a, so `p` is how often a is followed, at
 *   some point in the unit, by b.
 *
 * `lift` compares `p` with b's base rate (units calling b over all units):
 * a tool the agent calls in every unit follows everything and has a lift
 * near 1, however high its `p`.
 *
 * The accumulator is the one mutable structure here; `finish` returns plain
 * edges and keeps nothing.
 */

export const EXAMPLE_SESSIONS = 10;
const SEP = "\u0001";

interface EdgeCount {
  n: number;
  examples: Reservoir<string>;
}

export function edgeKey(a: string, b: string): string {
  return `${a}${SEP}${b}`;
}

export function splitEdgeKey(key: string): [string, string] {
  const at = key.indexOf(SEP);
  return [key.slice(0, at), key.slice(at + 1)];
}

/** Ids in the order each was first called. */
export function firstCallOrder(calls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of calls) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export interface TransitionStats {
  scope: ExplorerScope;
  subject: ExplorerSubject;
  /** Units with at least one call. */
  units: number;
  /** Units that called each id. */
  unitsOf: Map<string, number>;
  /** Calls of each id that had a successor. */
  successorsOf: Map<string, number>;
  next: Map<string, EdgeCount>;
  before: Map<string, EdgeCount>;
}

export function createTransitionStats(
  scope: ExplorerScope,
  subject: ExplorerSubject,
): TransitionStats {
  return {
    scope,
    subject,
    units: 0,
    unitsOf: new Map(),
    successorsOf: new Map(),
    next: new Map(),
    before: new Map(),
  };
}

function bump(map: Map<string, EdgeCount>, key: string, sessionId: string): void {
  let count = map.get(key);
  if (!count) {
    count = { n: 0, examples: new Reservoir<string>(EXAMPLE_SESSIONS, key) };
    map.set(key, count);
  }
  count.n += 1;
  count.examples.add(sessionId);
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function countTransitions(stats: TransitionStats, unit: ExplorerUnit): void {
  if (unit.calls.length === 0) return;
  stats.units += 1;
  for (const id of unit.items) increment(stats.unitsOf, id);
  for (let i = 0; i + 1 < unit.calls.length; i++) {
    const a = unit.calls[i]!;
    increment(stats.successorsOf, a);
    bump(stats.next, edgeKey(a, unit.calls[i + 1]!), unit.sessionId);
  }
  const order = firstCallOrder(unit.calls);
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++)
      bump(stats.before, edgeKey(order[i]!, order[j]!), unit.sessionId);
  }
}

function edgesOf(
  stats: TransitionStats,
  kind: ExplorerEdgeKind,
  counts: Map<string, EdgeCount>,
  denominator: (a: string) => number,
): ExplorerEdge[] {
  const out: ExplorerEdge[] = [];
  for (const [key, count] of counts) {
    const [a, b] = splitEdgeKey(key);
    const nA = denominator(a);
    if (nA === 0) continue;
    const p = count.n / nA;
    const interval = wilson(count.n, nA);
    const baseRate = (stats.unitsOf.get(b) ?? 0) / Math.max(1, stats.units);
    out.push({
      scope: stats.scope,
      kind,
      subject: stats.subject,
      a,
      b,
      n: count.n,
      nA,
      p,
      pLow: interval?.low ?? 0,
      pHigh: interval?.high ?? 1,
      lift: baseRate > 0 ? p / baseRate : 0,
      reverseN: counts.get(edgeKey(b, a))?.n ?? 0,
      exampleSessions: [...new Set(count.examples.values())].sort(),
    });
  }
  return out.sort((x, y) => y.n - x.n || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));
}

/** Every edge seen, most counted first. */
export function finishTransitions(stats: TransitionStats): ExplorerEdge[] {
  return [
    ...edgesOf(stats, "next", stats.next, (a) => stats.successorsOf.get(a) ?? 0),
    ...edgesOf(stats, "before", stats.before, (a) => stats.unitsOf.get(a) ?? 0),
  ];
}
