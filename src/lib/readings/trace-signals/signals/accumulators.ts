import { retryReaching, searchedAgainForSame } from "@/lib/ledger/same-ask";
import type { StepDraft, TargetType, TurnSource } from "@/lib/ledger/types";
import { detectAfterErrors } from "@/lib/readings/trace-signals/self-corrections/detect";
import {
  DEFAULT_FLOORS,
  EVIDENCE_TURNS_STORED,
  type Floors,
  LATENCY_RESERVOIR_SIZE,
  MAX_QUERY_HASHES,
} from "@/lib/readings/trace-signals/signals/catalog";
import { Reservoir } from "@/lib/readings/trace-signals/signals/severity";
import {
  entryKey,
  type InvokeStep,
  isInvoke,
  isListingSearch,
  junkOfSearch,
  listedType,
} from "@/lib/readings/trace-signals/signals/turn-facts";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import type { TurnSourceMix } from "@/lib/readings/trace-signals/view";

/**
 * Pass one of a signal run: one streaming walk over the window's closed turns
 * that builds every per-entry and project counter the detectors read. Memory is
 * bounded by the catalog (one {@link EntryStats} per listed or run entry) plus
 * fixed-size reservoirs, never by the number of turns. The per-query-hash
 * counters `unstable_intent` needs grow with distinct first-search queries, so
 * they are capped at `maxQueries`: past it the lowest-count hashes are evicted
 * (see {@link evictLowQueries}). Pairs are pass two (`pairs.ts`).
 *
 * The counters are mutated in place while the stream runs, which is the point
 * of an accumulator; they are handed to the detectors only once the pass ends,
 * and detectors never write to them.
 */

/** One sampled supporting turn: its id and the `trace_events` id of the offending step. */
export interface EvidenceSample {
  turnId: string;
  eventId: string | null;
  /** Epoch ms of the turn's end, for newest-first ordering. */
  at: number;
  source: TurnSource;
}

export type EvidenceKind =
  | "firstTry"
  | "buried"
  | "magnet"
  | "errorLoop"
  | "noFollow"
  | "repeat"
  | "latency";

export interface EntryStats {
  key: string;
  targetType: TargetType;
  id: string;
  invokeTurns: number;
  invocations: number;
  okInvocations: number;
  errors: number;
  mix: TurnSourceMix;
  /** Turns whose first call of the entry had been offered by a search in the turn. */
  offeredTurns: number;
  /** ...by a search that retried the same ask, the search before it not listing the entry. */
  laterSearchTurns: number;
  /** Same-ask searches spent before the one that listed the entry. */
  extraSearches: number;
  /** Retry turns where an older search for the same ask had listed the entry, just too low. */
  inFirstSearchLow: number;
  /** Offered turns whose first call's offered rank was at least the buried floor. */
  buriedTurns: number;
  buriedRanks: Reservoir<number>;
  /** Offered ranks in bands #1-3, #4-6, #7-10, #11+. */
  rankBands: [number, number, number, number];
  impressions: number;
  impressionsTop3: number;
  /** Searches whose listing of the entry led to a call of it. */
  picks: number;
  listedTurns: number;
  errorTurns: number;
  loopTurns: number;
  /** Retries after an error (`retry_after_error`): failed calls of this entry the agent ran again. */
  retries: number;
  repeatTurns: number;
  repeatExtra: number;
  noFollowN: number;
  noFollowK: number;
  latency: Reservoir<number>;
  evidence: Record<EvidenceKind, Reservoir<EvidenceSample>>;
  /** Slow calls (at or above the latency floor), with their duration. */
  slowCalls: Reservoir<EvidenceSample & { tookMs: number }>;
}

export interface QueryStats {
  n: number;
  firstEntries: Map<string, number>;
  evidence: EvidenceSample[];
}

export interface ProjectStats {
  turns: number;
  mix: TurnSourceMix;
  turnsWithSearch: number;
  /** Turns with at least one targeted invocation: the base rate of chains. */
  turnsWithInvoke: number;
  /** Searched turns whose outcome is measurable (runtime lane). */
  measurableWithSearch: number;
  abandoned: number;
  invocations: number;
  listingSearches: Record<TargetType, number>;
  topKs: Reservoir<number>;
  pickRanks: Reservoir<number>;
  picks: number;
  picksBelowCutoff: number;
  scoredHits: number;
  junkHits: number;
  latency: Reservoir<number>;
  abandonedEvidence: Reservoir<EvidenceSample>;
  paddingEvidence: Reservoir<EvidenceSample>;
  queries: Map<string, QueryStats>;
  /** Cap on `queries` entries. */
  maxQueries: number;
  /** Query hashes evicted to stay under the cap; above zero means truncated. */
  queriesEvicted: number;
  /** Turns each entry was listed or run in: pair eligibility. */
  entryTurns: Map<string, number>;
  entries: Map<string, EntryStats>;
  /** Tool ids listed or run in the window, for the dead-tool check. */
  seenTools: Set<string>;
}

export function emptyMix(): TurnSourceMix {
  return { declared: 0, inferred: 0, otlp: 0 };
}

export function createProjectStats(maxQueries: number = MAX_QUERY_HASHES): ProjectStats {
  return {
    turns: 0,
    mix: emptyMix(),
    turnsWithSearch: 0,
    turnsWithInvoke: 0,
    measurableWithSearch: 0,
    abandoned: 0,
    invocations: 0,
    listingSearches: { tool: 0, skill: 0 },
    topKs: new Reservoir(LATENCY_RESERVOIR_SIZE, "top_k"),
    pickRanks: new Reservoir(LATENCY_RESERVOIR_SIZE, "pick_rank"),
    picks: 0,
    picksBelowCutoff: 0,
    scoredHits: 0,
    junkHits: 0,
    latency: new Reservoir(LATENCY_RESERVOIR_SIZE, "project_latency"),
    abandonedEvidence: new Reservoir(EVIDENCE_TURNS_STORED, "abandoned"),
    paddingEvidence: new Reservoir(EVIDENCE_TURNS_STORED, "padding"),
    queries: new Map(),
    maxQueries,
    queriesEvicted: 0,
    entryTurns: new Map(),
    entries: new Map(),
    seenTools: new Set(),
  };
}

const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "firstTry",
  "buried",
  "magnet",
  "errorLoop",
  "noFollow",
  "repeat",
  "latency",
];

function createEntry(key: string, targetType: TargetType, id: string): EntryStats {
  const evidence = Object.fromEntries(
    EVIDENCE_KINDS.map((kind) => [
      kind,
      new Reservoir<EvidenceSample>(EVIDENCE_TURNS_STORED, `${key}:${kind}`),
    ]),
  ) as Record<EvidenceKind, Reservoir<EvidenceSample>>;
  return {
    key,
    targetType,
    id,
    invokeTurns: 0,
    invocations: 0,
    okInvocations: 0,
    errors: 0,
    mix: emptyMix(),
    offeredTurns: 0,
    laterSearchTurns: 0,
    extraSearches: 0,
    inFirstSearchLow: 0,
    buriedTurns: 0,
    buriedRanks: new Reservoir(LATENCY_RESERVOIR_SIZE, `${key}:buried_rank`),
    rankBands: [0, 0, 0, 0],
    impressions: 0,
    impressionsTop3: 0,
    picks: 0,
    listedTurns: 0,
    errorTurns: 0,
    loopTurns: 0,
    retries: 0,
    repeatTurns: 0,
    repeatExtra: 0,
    noFollowN: 0,
    noFollowK: 0,
    latency: new Reservoir(LATENCY_RESERVOIR_SIZE, `${key}:latency`),
    evidence,
    slowCalls: new Reservoir(EVIDENCE_TURNS_STORED * 3, `${key}:slow`),
  };
}

function entryOf(stats: ProjectStats, targetType: TargetType, id: string): EntryStats {
  const key = entryKey(targetType, id);
  const existing = stats.entries.get(key);
  if (existing) return existing;
  const created = createEntry(key, targetType, id);
  stats.entries.set(key, created);
  return created;
}

function rankBand(rank: number): 0 | 1 | 2 | 3 {
  if (rank <= 3) return 0;
  if (rank <= 6) return 1;
  if (rank <= 10) return 2;
  return 3;
}

function sample(turn: SignalTurn, eventId: string | null): EvidenceSample {
  return { turnId: turn.id, eventId, at: turn.endedAt.getTime(), source: turn.turnSource };
}

/** Feed one closed turn inside the window into pass one. */
export function accumulateTurn(
  stats: ProjectStats,
  turn: SignalTurn,
  floors: Floors = DEFAULT_FLOORS,
): void {
  stats.turns += 1;
  stats.mix[turn.turnSource] += 1;
  const searches = turn.steps.filter((step) => step.kind === "search");
  const invokes = turn.steps.filter(isInvoke);
  if (searches.length > 0) stats.turnsWithSearch += 1;
  if (invokes.length > 0) stats.turnsWithInvoke += 1;
  if (turn.abandoned !== null && searches.length > 0) {
    stats.measurableWithSearch += 1;
    if (turn.abandoned) {
      stats.abandoned += 1;
      stats.abandonedEvidence.add(sample(turn, searches.at(-1)?.traceEventId ?? null));
    }
  }
  stats.invocations += invokes.length;

  const listed = accumulateSearches(stats, turn, searches);
  const invoked = accumulateInvocations(stats, turn, invokes, floors);
  for (const key of listed) {
    if (!invoked.has(key)) {
      const search = searches.find((step) =>
        step.hitIds?.includes(key.slice(key.indexOf(":") + 1)),
      );
      stats.entries.get(key)?.evidence.magnet.add(sample(turn, search?.traceEventId ?? null));
    }
  }
  for (const key of new Set([...listed, ...invoked])) {
    stats.entryTurns.set(key, (stats.entryTurns.get(key) ?? 0) + 1);
  }
  accumulateQuery(stats, turn, searches, invokes);
}

function accumulateSearches(
  stats: ProjectStats,
  turn: SignalTurn,
  searches: readonly StepDraft[],
): Set<string> {
  const listed = new Set<string>();
  let padded = false;
  for (const search of searches) {
    if (!isListingSearch(search)) continue;
    stats.listingSearches[listedType(search)] += 1;
    if (search.topK !== null) stats.topKs.add(search.topK);
    const junk = junkOfSearch(search);
    if (junk) {
      stats.scoredHits += junk.scored;
      stats.junkHits += junk.junk;
      if (junk.junk > 0) padded = true;
    }
    const type = listedType(search);
    (search.hitIds ?? []).forEach((id, index) => {
      const entry = entryOf(stats, type, id);
      entry.impressions += 1;
      if (index < 3) entry.impressionsTop3 += 1;
      if (type === "tool") stats.seenTools.add(id);
      listed.add(entry.key);
    });
  }
  for (const key of listed) {
    const entry = stats.entries.get(key);
    if (entry) entry.listedTurns += 1;
  }
  if (padded) stats.paddingEvidence.add(sample(turn, searches[0]?.traceEventId ?? null));
  return listed;
}

function accumulateInvocations(
  stats: ProjectStats,
  turn: SignalTurn,
  invokes: readonly InvokeStep[],
  floors: Floors,
): Set<string> {
  const byEntry = new Map<string, InvokeStep[]>();
  const picked = new Set<string>();
  // Retries after an error are the self-corrections module's: one per failed call the agent ran again, on its tool.
  const retried = new Set(
    detectAfterErrors(turn.steps).flatMap((event) =>
      event.kind === "retry_after_error" && event.toolOrdinal !== null ? [event.toolOrdinal] : [],
    ),
  );
  for (const step of invokes) {
    const entry = entryOf(stats, step.targetType, step.targetId);
    if (step.targetType === "tool") stats.seenTools.add(step.targetId);
    entry.invocations += 1;
    if (step.outcome === "ok") entry.okInvocations += 1;
    if (step.outcome === "error") entry.errors += 1;
    if (retried.has(step.ordinal)) entry.retries += 1;
    byEntry.set(entry.key, [...(byEntry.get(entry.key) ?? []), step]);
    if (step.outcome === "ok") {
      entry.noFollowN += 1;
      const index = turn.steps.indexOf(step);
      if (searchedAgainForSame(turn.steps, index, floors.no_follow_through.withinMs)) {
        entry.noFollowK += 1;
        entry.evidence.noFollow.add(sample(turn, step.traceEventId));
      }
    }
    if (step.tookMs !== null) {
      entry.latency.add(step.tookMs);
      stats.latency.add(step.tookMs);
      if (step.tookMs >= floors.latency_outlier.minP95Ms) {
        entry.slowCalls.add({ ...sample(turn, step.traceEventId), tookMs: step.tookMs });
      }
    }
    if (step.offeredRank !== null) {
      stats.picks += 1;
      stats.pickRanks.add(step.offeredRank);
      if (step.offeredRank > floors.padding_share.pickCutoff) stats.picksBelowCutoff += 1;
    }
    if (step.offeredByOrdinal !== null) {
      const pick = `${step.offeredByOrdinal}:${entry.key}`;
      if (!picked.has(pick)) {
        picked.add(pick);
        entry.picks += 1;
      }
    }
  }
  for (const [key, calls] of byEntry)
    accumulateEntryTurn(stats.entries.get(key)!, turn, calls, floors);
  return new Set(byEntry.keys());
}

/** Per-turn facts of one entry: its first call's attribution, loops and repeats. */
function accumulateEntryTurn(
  entry: EntryStats,
  turn: SignalTurn,
  calls: readonly InvokeStep[],
  floors: Floors,
): void {
  entry.invokeTurns += 1;
  entry.mix[turn.turnSource] += 1;
  const first = calls[0]!;
  if (first.offeredRank !== null) {
    entry.offeredTurns += 1;
    entry.rankBands[rankBand(first.offeredRank)] += 1;
    // Only a retry for the same ask counts: a later search for a new need is
    // a next step, not a miss (`same-ask.ts`).
    const retry = retryReaching(turn.steps, first);
    if (retry) {
      entry.laterSearchTurns += 1;
      entry.extraSearches += retry.extraSearches;
      if (retry.listedEarlier) entry.inFirstSearchLow += 1;
      entry.evidence.firstTry.add(sample(turn, retry.previous.traceEventId));
    }
    if (first.offeredRank >= floors.buried_tool.minRank) {
      entry.buriedTurns += 1;
      entry.buriedRanks.add(first.offeredRank);
      entry.evidence.buried.add(sample(turn, first.traceEventId));
    }
  }
  const errors = calls.filter((call) => call.outcome === "error");
  if (errors.length > 0) {
    entry.errorTurns += 1;
    entry.evidence.errorLoop.add(sample(turn, errors[0]!.traceEventId));
  }
  if (errors.length >= 2) entry.loopTurns += 1;
  const ok = calls.filter((call) => call.outcome === "ok").length;
  if (ok >= floors.repeat_invoke.minCalls) {
    entry.repeatTurns += 1;
    entry.repeatExtra += calls.length - 1;
    entry.evidence.repeat.add(sample(turn, calls[1]!.traceEventId));
  }
}

/** `unstable_intent`: which entry a turn whose first search had this query ran first. */
function accumulateQuery(
  stats: ProjectStats,
  turn: SignalTurn,
  searches: readonly StepDraft[],
  invokes: readonly InvokeStep[],
): void {
  const hash = searches[0]?.queryHash;
  const first = invokes[0];
  if (!hash || !first) return;
  const query: QueryStats = stats.queries.get(hash) ?? {
    n: 0,
    firstEntries: new Map(),
    evidence: [],
  };
  const key = entryKey(first.targetType, first.targetId);
  query.n += 1;
  query.firstEntries.set(key, (query.firstEntries.get(key) ?? 0) + 1);
  if (query.evidence.length < EVIDENCE_TURNS_STORED)
    query.evidence.push(sample(turn, first.traceEventId));
  stats.queries.set(hash, query);
  if (stats.queries.size > stats.maxQueries) evictLowQueries(stats);
}

/** Share of the cap an eviction leaves filled, so evictions come in batches
 * rather than one sort per new hash. */
const QUERY_EVICTION_KEEP = 0.9;

/**
 * Drop the lowest-count query hashes (ties by hash, so the result depends only
 * on the turns fed, not on map order) until the map is back to 90% of its cap.
 * A hash that already reached `unstable_intent`'s `min_n` outranks the
 * singletons that make up the long tail, so a flood of one-off asks cannot
 * push out the ones the detector can use.
 */
export function evictLowQueries(stats: ProjectStats): void {
  const keep = Math.floor(stats.maxQueries * QUERY_EVICTION_KEEP);
  const excess = stats.queries.size - keep;
  if (excess <= 0) return;
  const lowest = [...stats.queries]
    .sort(([hashA, a], [hashB, b]) => a.n - b.n || (hashA < hashB ? -1 : hashA > hashB ? 1 : 0))
    .slice(0, excess);
  for (const [hash] of lowest) stats.queries.delete(hash);
  stats.queriesEvicted += lowest.length;
}

/** Evidence samples newest first, capped. */
export function newestFirst(
  samples: readonly EvidenceSample[],
  limit = EVIDENCE_TURNS_STORED,
): EvidenceSample[] {
  return [...samples].sort((a, b) => b.at - a.at || (a.turnId < b.turnId ? -1 : 1)).slice(0, limit);
}

/** The turn-source mix of a set of samples. */
export function mixOf(samples: readonly EvidenceSample[]): TurnSourceMix {
  return samples.reduce((mix, s) => ({ ...mix, [s.source]: mix[s.source] + 1 }), emptyMix());
}
