import {
  buildFixtureTurns,
  type TurnFixture,
  type TurnFixtureOptions,
  turn,
} from "@/lib/ledger/test-support";
import {
  accumulateTurn,
  createProjectStats,
  type ProjectStats,
} from "@/lib/readings/trace-signals/signals/accumulators";
import { DEFAULT_FLOORS, type Floors } from "@/lib/readings/trace-signals/signals/catalog";
import {
  accumulatePairs,
  createPairStats,
  eligibleTools,
  type PairStats,
} from "@/lib/readings/trace-signals/signals/pairs";
import type { AnalysisContext, SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * Test helpers for the detectors, on top of the turn-ledger fixture builder
 * (`../test-support.ts`): build closed turns, give them ids, and run pass one
 * and pass two over them.
 *
 *   const turns = signalTurns(times(10, () => turn().search(["a", "b"]).invoke("b")));
 */

/** `n` values of `make(i)`. */
export function times<T>(n: number, make: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

/** A fresh fixture turn (a new session each, so each is its own turn). */
export function fresh(opts: TurnFixtureOptions = {}): TurnFixture {
  return turn(opts);
}

let turnCounter = 0;

/** Closed turns with ids, as the detectors read them. */
export function signalTurns(fixtures: readonly TurnFixture[]): SignalTurn[] {
  return buildFixtureTurns(fixtures).map((draft) => {
    turnCounter += 1;
    return { ...draft, id: `turn-${turnCounter.toString().padStart(6, "0")}` };
  });
}

/** Pass one over every turn. */
export function statsOf(
  turns: readonly SignalTurn[],
  floors: Floors = DEFAULT_FLOORS,
): ProjectStats {
  const stats = createProjectStats();
  for (const t of turns) accumulateTurn(stats, t, floors);
  return stats;
}

/** Pass two over every turn, with a pair eligibility floor tests can lower. */
export function pairsOf(
  stats: ProjectStats,
  turns: readonly SignalTurn[],
  minTurns = 20,
): PairStats {
  const pairs = createPairStats(eligibleTools(stats, minTurns));
  for (const t of turns) accumulatePairs(pairs, t);
  return pairs;
}

/** A context whose window covers every turn given. */
export function contextFor(
  turns: readonly SignalTurn[],
  overrides: Partial<AnalysisContext> = {},
): AnalysisContext {
  const ends = turns.map((t) => t.endedAt.getTime());
  const last = ends.length > 0 ? Math.max(...ends) : Date.parse("2026-09-01T00:00:00Z");
  const first = ends.length > 0 ? Math.min(...ends) : last;
  return {
    windowStart: new Date(first - 60_000),
    windowEnd: new Date(last + 60_000),
    ledgerStartedAt: new Date(first),
    catalog: [],
    usage: [],
    clusters: null,
    ...overrides,
  };
}

/** Floors with some values replaced, for at-the-floor tests. */
export function withFloors<K extends keyof Floors>(kind: K, values: Partial<Floors[K]>): Floors {
  return { ...DEFAULT_FLOORS, [kind]: { ...DEFAULT_FLOORS[kind], ...values } };
}
