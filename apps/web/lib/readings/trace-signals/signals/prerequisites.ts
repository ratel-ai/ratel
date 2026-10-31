import { envNumber } from "@/lib/platform/env-number";
import {
  PREREQ_MIN_LIFT,
  PREREQ_MIN_TURNS,
  PREREQ_USUAL_CONFIDENCE,
} from "@/lib/readings/trace-signals/flow-journey-insights";
import { isInvoke } from "@/lib/readings/trace-signals/signals/turn-facts";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * "What each tool needs first", counted call by call across a session, not
 * only inside one turn. Turn boundaries are often inferred from gaps in the
 * traffic, and an agent can pause longer than that gap between looking
 * something up and using it, so the two calls land in different turns. Here a
 * call of B counts as "preceded by A" when A was called earlier in the same
 * session, by the same end user (when one is set), within
 * {@link PREREQ_WINDOW_MS}. The same is counted inside each turn too, so the
 * map can tell a pair it can draw along a turn's calls from one that crosses
 * turns.
 *
 * Confidence is the share of B's calls preceded by A. Lift compares that with
 * how often A precedes any call at all: the share of all other tools' calls
 * that had A in the same window before them. That is the chance A turns up in
 * a window of that length before a random call, so a tool the agent calls
 * all the time (a session sync, say) precedes everything and has a lift near
 * 1, however high its confidence.
 *
 * Memory is bounded by the catalog and by the sessions active within the
 * window: each open session keeps, per tool, the time it was last called;
 * sessions quiet for longer than the window (plus the longest turn) are
 * dropped as the job walks turns oldest first. Counts are per pair of called
 * tools. Stored additively in the run summary (`flow.prerequisites`): a
 * summary without it falls back to pairs read off the journey's paths.
 */

/** How far back a call looks for what ran before it. Env `PREREQ_WINDOW_MS`, default 10 minutes. */
export const PREREQ_WINDOW_MS = envNumber("PREREQ_WINDOW_MS", 10 * 60_000);
/** Pairs stored at most, strongest first. */
export const PREREQ_STORED_MAX = 60;
/** A session is dropped once its last call is this much older than the window before the turn being read. */
const SESSION_SLACK_MS = 60 * 60_000;
/** How often (in turns) quiet sessions are swept. */
const SWEEP_EVERY = 256;
const SEP = "\u0001";

/** One stored pair; short keys, because a summary holds dozens. */
export interface StoredPrerequisite {
  /** The tool that ran first, as a node id. */
  a: string;
  /** The tool that needed it, as a node id. */
  b: string;
  /** Calls of `b`. */
  n: number;
  /** Of those, calls with `a` earlier in the same session within the window. */
  w: number;
  /** Of those, calls with `a` earlier in the same turn. */
  t: number;
  /** Lift of `w`: its share over the chance `a` precedes any call within the window. */
  lw: number;
  /** Lift of `t`, the same inside a turn. */
  lt: number;
}

export interface StoredPrerequisites {
  windowMs: number;
  /** Calls counted. */
  calls: number;
  /** Strongest first (by the better of the two shares, times `n`). */
  pairs: StoredPrerequisite[];
}

interface Scope {
  /** Pair `a␁b` to calls of b preceded by a. */
  preceded: Map<string, number>;
  /** Tool to calls of any other tool it preceded. */
  precedes: Map<string, number>;
}

interface Trail {
  /** Tool to when it was last called, in ms. */
  seen: Map<string, number>;
  last: number;
}

export interface PrerequisiteStats {
  windowMs: number;
  calls: Map<string, number>;
  total: number;
  window: Scope;
  turn: Scope;
  sessions: Map<string, Trail>;
  turnsRead: number;
}

export function createPrerequisiteStats(windowMs: number = PREREQ_WINDOW_MS): PrerequisiteStats {
  return {
    windowMs,
    calls: new Map(),
    total: 0,
    window: { preceded: new Map(), precedes: new Map() },
    turn: { preceded: new Map(), precedes: new Map() },
    sessions: new Map(),
    turnsRead: 0,
  };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** A call's node id, the flow map's: the bare tool id, or `skill:<id>`. */
function nodeIdOf(targetType: string, targetId: string): string {
  return targetType === "skill" ? `skill:${targetId}` : targetId;
}

function count(scope: Scope, before: Iterable<string>, id: string): void {
  for (const first of before) {
    if (first === id) continue;
    bump(scope.preceded, `${first}${SEP}${id}`);
    bump(scope.precedes, first);
  }
}

/** Drops sessions that can no longer reach back into the window of any turn still to come. */
function sweep(stats: PrerequisiteStats, now: number): void {
  const horizon = now - stats.windowMs - SESSION_SLACK_MS;
  for (const [key, trail] of stats.sessions) if (trail.last < horizon) stats.sessions.delete(key);
}

/** Counts one closed turn's calls. Turns must come oldest first (by end), as the compute job pages them. */
export function countPrerequisites(
  stats: PrerequisiteStats,
  turn: Pick<SignalTurn, "sessionId" | "endUserKey" | "endedAt" | "steps">,
): void {
  stats.turnsRead += 1;
  if (stats.turnsRead % SWEEP_EVERY === 0) sweep(stats, turn.endedAt.getTime());
  const calls = turn.steps.filter(isInvoke);
  if (calls.length === 0) return;
  const key = `${turn.sessionId}${SEP}${turn.endUserKey ?? ""}`;
  const trail = stats.sessions.get(key) ?? { seen: new Map<string, number>(), last: 0 };
  stats.sessions.set(key, trail);
  const inTurn = new Set<string>();
  for (const call of calls) {
    const id = nodeIdOf(call.targetType, call.targetId);
    const at = call.occurredAt.getTime();
    for (const [tool, when] of trail.seen) if (when < at - stats.windowMs) trail.seen.delete(tool);
    count(
      stats.window,
      [...trail.seen.keys()].filter((tool) => (trail.seen.get(tool) ?? 0) <= at),
      id,
    );
    count(stats.turn, inTurn, id);
    bump(stats.calls, id);
    stats.total += 1;
    inTurn.add(id);
    trail.seen.set(id, Math.max(trail.seen.get(id) ?? 0, at));
    trail.last = Math.max(trail.last, at);
  }
}

/** Confidence and lift of one pair in one scope. */
function measure(
  stats: PrerequisiteStats,
  scope: Scope,
  a: string,
  b: string,
): { share: number; lift: number; count: number } {
  const n = stats.calls.get(b) ?? 0;
  const count = scope.preceded.get(`${a}${SEP}${b}`) ?? 0;
  const share = n > 0 ? count / n : 0;
  const others = stats.total - (stats.calls.get(a) ?? 0);
  const chance = others > 0 ? (scope.precedes.get(a) ?? 0) / others : 0;
  return { share, lift: chance > 0 ? share / chance : 0, count };
}

function qualifies(m: { share: number; lift: number }): boolean {
  return m.share >= PREREQ_USUAL_CONFIDENCE && m.lift >= PREREQ_MIN_LIFT;
}

const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * The stored pairs: every pair where B was called at least
 * {@link PREREQ_MIN_TURNS} times and A preceded it in at least the "usually"
 * share with the minimum lift, within the window or inside the turn. The
 * view picks tiers and what to draw. Undefined when nothing was called.
 */
export function finishPrerequisites(stats: PrerequisiteStats): StoredPrerequisites | undefined {
  if (stats.total === 0) return undefined;
  const keys = new Set([...stats.window.preceded.keys(), ...stats.turn.preceded.keys()]);
  const pairs: StoredPrerequisite[] = [];
  for (const key of keys) {
    const [a, b] = key.split(SEP);
    const n = stats.calls.get(b) ?? 0;
    if (n < PREREQ_MIN_TURNS) continue;
    const window = measure(stats, stats.window, a, b);
    const turn = measure(stats, stats.turn, a, b);
    if (!qualifies(window) && !qualifies(turn)) continue;
    pairs.push({
      a,
      b,
      n,
      w: window.count,
      t: turn.count,
      lw: round(window.lift),
      lt: round(turn.lift),
    });
  }
  const weight = (p: StoredPrerequisite) => Math.max(p.w, p.t);
  pairs.sort(
    (x, y) =>
      weight(y) - weight(x) ||
      (x.b < y.b ? -1 : x.b > y.b ? 1 : 0) ||
      (x.a < y.a ? -1 : x.a > y.a ? 1 : 0),
  );
  return { windowMs: stats.windowMs, calls: stats.total, pairs: pairs.slice(0, PREREQ_STORED_MAX) };
}
