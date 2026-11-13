import { edgeKey } from "@/lib/readings/tool-explorer/transitions";
import type { EdgeTiming, ExplorerScope } from "@/lib/readings/tool-explorer/types";
import { nodeIdOf } from "@/lib/readings/tool-explorer/units";
import { median, Reservoir } from "@/lib/readings/trace-signals/signals/severity";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * What the calls cost in time, read off the steps: per tool, `took_ms` summed
 * and its median; per consecutive pair of calls (a then b), the hand-off
 * between a's end and b's start and how many searches sat in it. The hand-off
 * is the agent's time, not the tools': a model turn, a search, a decision. It
 * is exactly what merging a and b into one call would remove, so the Crafter
 * can say "about N minutes over this window" instead of "faster".
 *
 * Turn scope counts hand-offs inside a turn; session scope also counts the one
 * across a turn boundary, when the session's previous call was a and the next
 * turn's first call is b. Medians come from a bounded reservoir per key.
 */

const SAMPLE_SIZE = 200;
/** A hand-off longer than this is the user walking away, not the agent thinking; it is left out of the sums. */
export const MAX_HANDOFF_MS = 10 * 60_000;

interface NodeTiming {
  totalMs: number;
  timedCalls: number;
  errorCalls: number;
  samples: Reservoir<number>;
}

interface PairTiming {
  pairs: number;
  betweenMsTotal: number;
  searchesBetween: number;
  samples: Reservoir<number>;
}

interface LastCall {
  id: string;
  endMs: number | null;
  /** Searches seen since this call. */
  searchesSince: number;
}

export interface TimingStats {
  nodes: Map<string, NodeTiming>;
  pairs: Record<ExplorerScope, Map<string, PairTiming>>;
  /** Per session, the last call of the previous turn, for the cross-turn hand-off. */
  sessionLast: Map<string, LastCall>;
}

export function createTimingStats(): TimingStats {
  return {
    nodes: new Map(),
    pairs: { turn: new Map(), session: new Map() },
    sessionLast: new Map(),
  };
}

function endOf(step: SignalTurn["steps"][number]): number | null {
  if (step.endOccurredAt) return step.endOccurredAt.getTime();
  if (step.tookMs !== null) return step.occurredAt.getTime() + step.tookMs;
  return null;
}

function recordPair(
  map: Map<string, PairTiming>,
  key: string,
  betweenMs: number,
  searches: number,
): void {
  let pair = map.get(key);
  if (!pair) {
    pair = {
      pairs: 0,
      betweenMsTotal: 0,
      searchesBetween: 0,
      samples: new Reservoir<number>(SAMPLE_SIZE, key),
    };
    map.set(key, pair);
  }
  pair.pairs += 1;
  pair.betweenMsTotal += betweenMs;
  pair.searchesBetween += searches;
  pair.samples.add(betweenMs);
}

function handoff(
  last: LastCall | undefined,
  id: string,
  startMs: number,
): { betweenMs: number; searches: number } | null {
  if (!last || last.id === id || last.endMs === null) return null;
  const betweenMs = startMs - last.endMs;
  if (betweenMs < 0 || betweenMs > MAX_HANDOFF_MS) return null;
  return { betweenMs, searches: last.searchesSince };
}

export function countTurnTiming(
  stats: TimingStats,
  turn: Pick<SignalTurn, "sessionId" | "steps">,
): void {
  let inTurn: LastCall | undefined;
  let session = stats.sessionLast.get(turn.sessionId);
  for (const step of turn.steps) {
    if (step.kind === "search") {
      if (inTurn) inTurn.searchesSince += 1;
      if (session) session.searchesSince += 1;
      continue;
    }
    const id = nodeIdOf(step);
    if (id === null) continue;
    let node = stats.nodes.get(id);
    if (!node) {
      node = {
        totalMs: 0,
        timedCalls: 0,
        errorCalls: 0,
        samples: new Reservoir<number>(SAMPLE_SIZE, id),
      };
      stats.nodes.set(id, node);
    }
    if (step.tookMs !== null) {
      node.totalMs += step.tookMs;
      node.timedCalls += 1;
      node.samples.add(step.tookMs);
    }
    if (step.outcome === "error") node.errorCalls += 1;

    const startMs = step.occurredAt.getTime();
    const within = handoff(inTurn, id, startMs);
    if (within && inTurn)
      recordPair(stats.pairs.turn, edgeKey(inTurn.id, id), within.betweenMs, within.searches);
    const across = handoff(session, id, startMs);
    if (across && session)
      recordPair(stats.pairs.session, edgeKey(session.id, id), across.betweenMs, across.searches);

    const last: LastCall = { id, endMs: endOf(step), searchesSince: 0 };
    inTurn = last;
    session = { ...last };
    stats.sessionLast.set(turn.sessionId, session);
  }
}

export interface NodeTimingOut {
  totalMs: number;
  medianMs: number | null;
  timedCalls: number;
  errorCalls: number;
}

export function finishTiming(stats: TimingStats): {
  nodes: Map<string, NodeTimingOut>;
  pairs: Record<ExplorerScope, Map<string, EdgeTiming>>;
} {
  const nodes = new Map<string, NodeTimingOut>();
  for (const [id, node] of stats.nodes) {
    nodes.set(id, {
      totalMs: node.totalMs,
      medianMs: median(node.samples.values()),
      timedCalls: node.timedCalls,
      errorCalls: node.errorCalls,
    });
  }
  const out: Record<ExplorerScope, Map<string, EdgeTiming>> = {
    turn: new Map(),
    session: new Map(),
  };
  for (const scope of ["turn", "session"] as const) {
    for (const [key, pair] of stats.pairs[scope]) {
      out[scope].set(key, {
        pairs: pair.pairs,
        betweenMsTotal: pair.betweenMsTotal,
        betweenMsMedian: median(pair.samples.values()),
        searchesBetween: pair.searchesBetween,
      });
    }
  }
  return { nodes, pairs: out };
}
