import { isInvoke } from "@/lib/readings/trace-signals/signals/turn-facts";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * The flow map's journey: how turns unfold call by call. Every turn becomes
 * one path, `start → 1st call → 2nd call → ... → ended | went on`, and the
 * run stores how many turns took each path. The map draws it as a
 * step-by-step Sankey (positions in a turn, not categories), so a tool shows
 * up in every column it was called in, and a repeat is a step from a tool to
 * itself.
 *
 * Memory is bounded by the catalog, never by the number of turns:
 *
 * - pass one (`countJourneyPositions`) counts which tool ran at each of the
 *   first {@link JOURNEY_STEPS} positions;
 * - pass two (`countJourneyPath`) keeps the {@link JOURNEY_TOOLS_PER_STEP}
 *   busiest tools of each position by id and folds the rest into
 *   {@link JOURNEY_OTHER_ID}, so a path key has at most 10 values a position;
 * - `finishJourney` sorts the paths and, past {@link JOURNEY_MAX_PATHS},
 *   folds the rarest paths' tools into "other", deepest position first, until
 *   they fit (the folded tail merges into at most a few dozen paths, so the
 *   list stays near the cap and every turn is still counted).
 *
 * Stored additively in the run summary (`flow.journey`): a summary without it
 * still renders, with the older map.
 */

/** Call positions a path records; later calls only mark the path as "went on". */
export const JOURNEY_STEPS = 8;
/** Tools kept by id at each position; the rest fold into "other". */
export const JOURNEY_TOOLS_PER_STEP = 16;
/** Distinct paths stored at most. */
export const JOURNEY_MAX_PATHS = 800;
/** The folded "other tools" at a position. Not a valid catalog id. */
export const JOURNEY_OTHER_ID = "~other";

/** `agent`: an OpenTelemetry turn, which has no search step to miss (never `none`). */
export type JourneyStart = "search" | "none" | "agent";
export type JourneyEnd = "end" | "more";

/** One stored path; short keys, because a summary holds hundreds of them. */
export interface StoredJourneyPath {
  /** Whether a search came before the first call. */
  s: JourneyStart;
  /** Node ids of the first calls, in order (a tool id, `skill:<id>` or {@link JOURNEY_OTHER_ID}). */
  t: string[];
  /** `end`: the turn made no more calls; `more`: it went on past the last step. */
  e: JourneyEnd;
  /** Turns that took this path. */
  n: number;
}

export interface StoredJourney {
  /** Positions each path records. */
  steps: number;
  /** Turns counted: every closed turn in the window that searched or called something. */
  turns: number;
  /** Most turns first, then by key. */
  paths: StoredJourneyPath[];
  /** Per position (index 0 is the 1st call): distinct tools folded into "other". */
  other: number[];
}

/** What a turn contributes, before folding. */
export interface TurnJourney {
  start: JourneyStart;
  /** Node ids of the first {@link JOURNEY_STEPS} calls. */
  ids: string[];
  more: boolean;
}

export interface JourneyStats {
  /** Pass one: per position, node id to turns. */
  positions: Map<string, number>[];
  /** Kept ids per position, fixed when pass two starts. */
  kept: Set<string>[] | null;
  /** Pass two: path key to turns. */
  paths: Map<string, number>;
  /** Per position: ids folded into "other". */
  folded: Set<string>[];
}

export function createJourneyStats(): JourneyStats {
  return {
    positions: Array.from({ length: JOURNEY_STEPS }, () => new Map<string, number>()),
    kept: null,
    paths: new Map(),
    folded: Array.from({ length: JOURNEY_STEPS }, () => new Set<string>()),
  };
}

/** A call's node id, the flow map's: the bare tool id, or `skill:<id>`. */
function nodeIdOf(targetType: string, targetId: string): string {
  return targetType === "skill" ? `skill:${targetId}` : targetId;
}

/**
 * A turn's journey: whether it searched before its first call, and its first
 * calls. Null for a turn that neither searched nor called anything. An
 * OTLP-lane turn that did not search starts at the agent: OpenTelemetry has
 * no Ratel search step, so "no search" would read as a miss.
 */
export function turnJourney(
  turn: Pick<SignalTurn, "steps"> & Partial<Pick<SignalTurn, "lane">>,
): TurnJourney | null {
  const first = turn.steps.findIndex(isInvoke);
  const calls = turn.steps.filter(isInvoke);
  const before = first === -1 ? turn.steps : turn.steps.slice(0, first);
  const searched = before.some((step) => step.kind === "search");
  if (calls.length === 0 && !searched) return null;
  return {
    start: searched ? "search" : turn.lane === "otlp" ? "agent" : "none",
    ids: calls.slice(0, JOURNEY_STEPS).map((call) => nodeIdOf(call.targetType, call.targetId)),
    more: calls.length > JOURNEY_STEPS,
  };
}

/** Pass one: which tool ran at each position. */
export function countJourneyPositions(
  stats: JourneyStats,
  turn: Pick<SignalTurn, "steps"> & Partial<Pick<SignalTurn, "lane">>,
): void {
  const journey = turnJourney(turn);
  if (journey) countJourneyPositionsOf(stats, journey);
}

/** Pass one for a journey already built (the Tool Explorer builds one per session). */
export function countJourneyPositionsOf(stats: JourneyStats, journey: TurnJourney): void {
  journey.ids.forEach((id, i) => stats.positions[i].set(id, (stats.positions[i].get(id) ?? 0) + 1));
}

function byCountThenKey([a, x]: [string, number], [b, y]: [string, number]): number {
  return y - x || (a < b ? -1 : a > b ? 1 : 0);
}

/** The busiest tools of each position; a position one over the limit keeps all, so "other" never holds one tool. */
function keptIds(positions: readonly Map<string, number>[]): Set<string>[] {
  return positions.map((counts) => {
    const ranked = [...counts].sort(byCountThenKey).map(([id]) => id);
    const limit =
      ranked.length <= JOURNEY_TOOLS_PER_STEP + 1 ? ranked.length : JOURNEY_TOOLS_PER_STEP;
    return new Set(ranked.slice(0, limit));
  });
}

function pathKey(start: JourneyStart, ids: readonly string[], end: JourneyEnd): string {
  return [start, end, ...ids].join("\u0001");
}

function parseKey(key: string, n: number): StoredJourneyPath {
  const [s, e, ...t] = key.split("\u0001");
  return { s: s as JourneyStart, e: e as JourneyEnd, t, n };
}

/** Pass two: the turn's path, with tools outside a position's busiest folded. */
export function countJourneyPath(
  stats: JourneyStats,
  turn: Pick<SignalTurn, "steps"> & Partial<Pick<SignalTurn, "lane">>,
): void {
  const journey = turnJourney(turn);
  if (journey) countJourneyPathOf(stats, journey);
}

/** Pass two for a journey already built. */
export function countJourneyPathOf(stats: JourneyStats, journey: TurnJourney): void {
  stats.kept ??= keptIds(stats.positions);
  const kept = stats.kept;
  const ids = journey.ids.map((id, i) => {
    if (kept[i].has(id)) return id;
    stats.folded[i].add(id);
    return JOURNEY_OTHER_ID;
  });
  const key = pathKey(journey.start, ids, journey.more ? "more" : "end");
  stats.paths.set(key, (stats.paths.get(key) ?? 0) + 1);
}

/**
 * Folds the tool at `position` of every path outside the `limit` busiest into
 * "other", merging paths that become equal. Returns the new map.
 */
function foldTail(
  paths: ReadonlyMap<string, number>,
  position: number,
  limit: number,
  folded: Set<string>[],
): Map<string, number> {
  const ranked = [...paths].sort(byCountThenKey);
  const out = new Map<string, number>();
  ranked.forEach(([key, n], rank) => {
    const path = parseKey(key, n);
    const id = path.t[position];
    const fold = rank >= limit && id !== undefined && id !== JOURNEY_OTHER_ID;
    if (fold) folded[position].add(id);
    const ids = fold
      ? path.t.map((value, i) => (i === position ? JOURNEY_OTHER_ID : value))
      : path.t;
    const next = pathKey(path.s, ids, path.e);
    out.set(next, (out.get(next) ?? 0) + n);
  });
  return out;
}

/** The stored journey, or undefined when no turn searched or called anything. */
export function finishJourney(stats: JourneyStats): StoredJourney | undefined {
  let paths: Map<string, number> = stats.paths;
  const folded = stats.folded.map((set) => new Set(set));
  for (
    let position = JOURNEY_STEPS - 1;
    position >= 0 && paths.size > JOURNEY_MAX_PATHS;
    position -= 1
  ) {
    paths = foldTail(paths, position, JOURNEY_MAX_PATHS, folded);
  }
  // Still over: the rarest paths keep only their shape (start, length, end).
  if (paths.size > JOURNEY_MAX_PATHS) {
    for (let position = 0; position < JOURNEY_STEPS; position += 1) {
      paths = foldTail(paths, position, JOURNEY_MAX_PATHS, folded);
    }
  }
  const list = [...paths].sort(byCountThenKey).map(([key, n]) => parseKey(key, n));
  const turns = list.reduce((sum, path) => sum + path.n, 0);
  if (turns === 0) return undefined;
  return {
    steps: JOURNEY_STEPS,
    turns,
    paths: list,
    other: folded.map((set) => set.size),
  };
}
