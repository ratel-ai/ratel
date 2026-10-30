import type {
  EvidenceSample,
  ProjectStats,
} from "@/lib/readings/trace-signals/signals/accumulators";
import {
  EVIDENCE_TURNS_STORED,
  PAIR_TOOL_MIN_TURNS,
} from "@/lib/readings/trace-signals/signals/catalog";
import { Reservoir } from "@/lib/readings/trace-signals/signals/severity";
import {
  type InvokeStep,
  isInvoke,
  isListingSearch,
  listedType,
} from "@/lib/readings/trace-signals/signals/turn-facts";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * Pass two of a signal run: tool pairs. Only tools listed or run in at least
 * `PAIR_TOOL_MIN_TURNS` turns take part (pass one counted that), which bounds
 * the pair maps by the busy part of the catalog rather than by its tail.
 *
 * - Ordered pairs `a>b` (sequence chains): a turn counts once for the first
 *   time `a` ran before `b` ran. `viaSearch` when the call of `b` that followed
 *   was offered by a search made after `a` ran (the agent had to look again).
 * - Unordered pairs `a|b` (siblings, ids in string order): `coListed` counts
 *   searches listing both; a "decision turn" is one where either was run from a
 *   search that listed both, and the credit goes to whichever ran first;
 *   `swaps` are decision turns that ran both.
 *
 * Skills are left out of pairs in Phase 1: a chain or a sibling pair is a
 * statement about two tools the agent chose between.
 */

export interface OrderedPairStats {
  n: number;
  viaSearch: number;
  evidence: Reservoir<EvidenceSample>;
}

export interface SiblingPairStats {
  coListed: number;
  decisionTurns: number;
  /** Decision turns where the lower id ran first. */
  firstA: number;
  /** ...where the higher id ran first. */
  firstB: number;
  swaps: number;
  evidence: Reservoir<EvidenceSample>;
}

export interface PairStats {
  eligible: ReadonlySet<string>;
  ordered: Map<string, OrderedPairStats>;
  siblings: Map<string, SiblingPairStats>;
}

/** The tool ids eligible for pairs, from pass one. */
export function eligibleTools(
  stats: ProjectStats,
  minTurns: number = PAIR_TOOL_MIN_TURNS,
): Set<string> {
  const out = new Set<string>();
  for (const [key, turns] of stats.entryTurns) {
    if (turns >= minTurns && key.startsWith("tool:")) out.add(key.slice("tool:".length));
  }
  return out;
}

export function createPairStats(eligible: ReadonlySet<string>): PairStats {
  return { eligible, ordered: new Map(), siblings: new Map() };
}

function sample(turn: SignalTurn, eventId: string | null): EvidenceSample {
  return { turnId: turn.id, eventId, at: turn.endedAt.getTime(), source: turn.turnSource };
}

export function siblingKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Feed one closed turn inside the window into pass two. */
export function accumulatePairs(pairs: PairStats, turn: SignalTurn): void {
  const invokes = turn.steps.filter(
    (step): step is InvokeStep =>
      isInvoke(step) && step.targetType === "tool" && pairs.eligible.has(step.targetId),
  );
  accumulateOrdered(pairs, turn, invokes);
  accumulateSiblings(pairs, turn, invokes);
}

function accumulateOrdered(
  pairs: PairStats,
  turn: SignalTurn,
  invokes: readonly InvokeStep[],
): void {
  const firstCall = new Map<string, InvokeStep>();
  for (const step of invokes) if (!firstCall.has(step.targetId)) firstCall.set(step.targetId, step);
  const order = [...firstCall.values()];
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i]!;
      const b = order[j]!;
      const key = `${a.targetId}>${b.targetId}`;
      const stats = pairs.ordered.get(key) ?? {
        n: 0,
        viaSearch: 0,
        evidence: new Reservoir<EvidenceSample>(EVIDENCE_TURNS_STORED, key),
      };
      stats.n += 1;
      if ((b.offeredByOrdinal ?? 0) > a.ordinal) stats.viaSearch += 1;
      stats.evidence.add(sample(turn, b.traceEventId));
      pairs.ordered.set(key, stats);
    }
  }
}

function siblingStats(pairs: PairStats, key: string): SiblingPairStats {
  const existing = pairs.siblings.get(key);
  if (existing) return existing;
  const created: SiblingPairStats = {
    coListed: 0,
    decisionTurns: 0,
    firstA: 0,
    firstB: 0,
    swaps: 0,
    evidence: new Reservoir<EvidenceSample>(EVIDENCE_TURNS_STORED, key),
  };
  pairs.siblings.set(key, created);
  return created;
}

function accumulateSiblings(
  pairs: PairStats,
  turn: SignalTurn,
  invokes: readonly InvokeStep[],
): void {
  const listedBySearch = new Map<number, string[]>();
  for (const step of turn.steps) {
    if (!isListingSearch(step) || listedType(step) !== "tool") continue;
    const listed = [...new Set((step.hitIds ?? []).filter((id) => pairs.eligible.has(id)))].sort();
    listedBySearch.set(step.ordinal, listed);
    for (let i = 0; i < listed.length; i++) {
      for (let j = i + 1; j < listed.length; j++) {
        siblingStats(pairs, `${listed[i]}|${listed[j]}`).coListed += 1;
      }
    }
  }
  const ran = new Set(invokes.map((step) => step.targetId));
  const decided = new Set<string>();
  for (const step of invokes) {
    const listed =
      step.offeredByOrdinal === null ? undefined : listedBySearch.get(step.offeredByOrdinal);
    for (const other of listed ?? []) {
      if (other === step.targetId) continue;
      const key = siblingKey(step.targetId, other);
      if (decided.has(key)) continue;
      decided.add(key);
      const stats = siblingStats(pairs, key);
      stats.decisionTurns += 1;
      if (key.startsWith(`${step.targetId}|`)) stats.firstA += 1;
      else stats.firstB += 1;
      if (ran.has(other)) {
        stats.swaps += 1;
        stats.evidence.add(sample(turn, step.traceEventId));
      }
    }
  }
}
