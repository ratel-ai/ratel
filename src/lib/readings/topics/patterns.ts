import type { TopicTurn } from "@/lib/readings/topics/asks";
import type { PlacedTurn } from "@/lib/readings/topics/stats";
import {
  type ComesBeforeStep,
  isModelOnlyTurn,
  type PatternTool,
  type StoredTopicPattern,
  type TopicInsights,
} from "@/lib/readings/topics/types";
import {
  PREREQ_MIN_LIFT,
  PREREQ_STRONG_CONFIDENCE,
  PREREQ_USUAL_CONFIDENCE,
} from "@/lib/readings/trace-signals/flow-journey-insights";

/**
 * How each intent gets done, read by the `assign_topics` job from the calls
 * of the turns it placed (ported from #267's per-ask patterns, keyed on our
 * Intents instead of Tool Explorer's asks). Pure.
 *
 * - The pattern: the tools in at least half the intent's turns (helpers
 *   aside), at most six, ordered by their average position among the turns
 *   that ran them all. The shares are over all of the intent's turns, so an
 *   intent that is mostly unanswered has no pattern: that is the truth.
 * - Also: the tools in at least a fifth of its turns, under the pattern.
 * - Helpers: Agent health's ubiquitous tools (`StoredWorkflows.ubiquitousTools`,
 *   read, never derived here) are set aside from everything above and named
 *   apart when the intent runs them in most of its turns.
 * - First calls: what each turn starts with, helpers skipped.
 * - What comes before: Agent health's rule (`flow-journey-insights.ts`)
 *   inside one intent. Of the intent's turns that ran a tool, the share
 *   where another ran first; drawn from the usual confidence, strong from
 *   the strong one, and only when that share is the minimum lift over the
 *   earlier tool's share of the project's turns, so a tool that runs
 *   everywhere is never read as what another tool needs.
 *
 * A turn is read as its distinct calls in first-call order; the first
 * `PATTERN_PATH_TOOLS` of them are read for order, which bounds the work at
 * a few hundred pairs per turn.
 */

/** An intent's pattern is read once it has this many turns. */
export const PATTERN_MIN_TURNS = 5;
/** A tool in at least this share of an intent's turns is part of how it is done... */
export const PATTERN_TOOL_SHARE = 0.5;
/** ...at most this many, busiest first, then put in their usual order. */
export const PATTERN_MAX_TOOLS = 6;
/** A tool in at least this share of its turns (and in two of them), under the pattern, is one it also runs. */
export const PATTERN_ALSO_SHARE = 0.2;
export const PATTERN_MAX_ALSO = 6;
/** Helpers named apart at most. */
export const PATTERN_MAX_HELPERS = 6;
/** First calls kept: the pattern's own, then others seen at least twice. */
export const PATTERN_MAX_FIRSTS = 8;
/** Distinct calls per turn read for their order. */
export const PATTERN_PATH_TOOLS = 12;

/**
 * "What comes before" inside one intent, with Agent health's own bars.
 * Agent health reads a tool once it ran in `PREREQ_MIN_TURNS` turns of the
 * whole project; inside one intent, the intent's own floor applies instead.
 */
export const COMES_BEFORE_MIN_TURNS = PATTERN_MIN_TURNS;
/** Drawn from this share ("usually")... */
export const COMES_BEFORE_DRAWN = PREREQ_USUAL_CONFIDENCE;
/** ...and drawn heavy from this one ("almost always"). */
export const COMES_BEFORE_STRONG = PREREQ_STRONG_CONFIDENCE;
/** The share must be this many times the earlier tool's share of the project's turns. */
export const COMES_BEFORE_MIN_LIFT = PREREQ_MIN_LIFT;
/** Steps kept per intent, heaviest first. */
export const COMES_BEFORE_MAX_STEPS = 16;

const SKILL_PREFIX = "skill:";
const SEP = "\u0001";

export interface PatternInput {
  placed: readonly PlacedTurn[];
  /** The project's helper tools, from the latest signal run; empty when it named none. */
  helpers: ReadonlySet<string>;
}

type Counts = Map<string, number>;

function bump(map: Counts, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Busiest first, then by id, so the answer never depends on input order. */
function ranked(map: ReadonlyMap<string, number>): [string, number][] {
  return [...map].sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]));
}

const toTools = (entries: readonly [string, number][]): PatternTool[] =>
  entries.map(([id, turns]) => ({ id, turns }));

/** A turn's distinct calls, in the order each was first called. */
export function firstCalls(turn: Pick<TopicTurn, "calls">): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const call of turn.calls) {
    if (seen.has(call.tool)) continue;
    seen.add(call.tool);
    out.push(call.tool);
  }
  return out;
}

/**
 * Each tool's share of the project's turns: the base rate a "What comes
 * before" step is read against. Model-only traces are left out, as Agent
 * health's journey counts the turns that searched or called something.
 */
export function projectShares(placed: readonly PlacedTurn[]): (id: string) => number {
  const turnsOf: Counts = new Map();
  let turns = 0;
  for (const row of placed) {
    if (isModelOnlyTurn(row.turn.id)) continue;
    turns += 1;
    for (const id of new Set(row.turn.calls.map((call) => call.tool))) bump(turnsOf, id);
  }
  return (id) => (turns > 0 ? (turnsOf.get(id) ?? 0) / turns : 0);
}

/** Every intent's pattern, by topic id, for the intents with at least `PATTERN_MIN_TURNS` turns. */
export function topicPatterns(input: PatternInput): Map<string, StoredTopicPattern> {
  const byTopic = new Map<string, TopicTurn[]>();
  for (const row of input.placed) {
    if (row.verdict !== "topic" || !row.topicId) continue;
    const list = byTopic.get(row.topicId);
    if (list) list.push(row.turn);
    else byTopic.set(row.topicId, [row.turn]);
  }
  const share = projectShares(input.placed);
  const out = new Map<string, StoredTopicPattern>();
  for (const [topicId, turns] of byTopic) {
    if (turns.length < PATTERN_MIN_TURNS) continue;
    out.set(topicId, readPattern(turns, input.helpers, share));
  }
  return out;
}

/** The reading with each intent's pattern on its row (new objects; the rows without one are kept as they are). */
export function withTopicPatterns(
  insights: TopicInsights,
  patterns: ReadonlyMap<string, StoredTopicPattern>,
): TopicInsights {
  if (patterns.size === 0) return insights;
  return {
    ...insights,
    topics: insights.topics.map((stats) => {
      const pattern = patterns.get(stats.id);
      return pattern ? { ...stats, pattern } : stats;
    }),
  };
}

/** One intent's pattern from its turns. */
export function readPattern(
  turns: readonly TopicTurn[],
  helpers: ReadonlySet<string>,
  baseShare: (id: string) => number,
): StoredTopicPattern {
  const n = turns.length;
  const turnsOf: Counts = new Map();
  const positions: Counts = new Map();
  const firsts: Counts = new Map();
  const ranIn: Counts = new Map();
  const before: Counts = new Map();
  const orders: string[][] = [];
  let withCalls = 0;
  let invoked = 0;
  let offered = 0;
  for (const turn of turns) {
    const distinct = firstCalls(turn);
    if (distinct.length > 0) withCalls += 1;
    if (distinct.some((id) => id.startsWith(SKILL_PREFIX))) invoked += 1;
    if (turn.skillOffered) offered += 1;
    for (const id of distinct) bump(turnsOf, id);
    const order = distinct.filter((id) => !helpers.has(id));
    orders.push(order);
    order.forEach((id, index) => bump(positions, id, index));
    if (order[0] !== undefined) bump(firsts, order[0]);
    const path = order.slice(0, PATTERN_PATH_TOOLS);
    for (let j = 0; j < path.length; j += 1) {
      bump(ranIn, path[j]!);
      for (let i = 0; i < j; i += 1) bump(before, `${path[i]}${SEP}${path[j]}`);
    }
  }

  const byCount = ranked(turnsOf);
  const own = byCount.filter(([id]) => !helpers.has(id));
  const chosen = own
    .filter(([, k]) => k / n >= PATTERN_TOOL_SHARE)
    .slice(0, PATTERN_MAX_TOOLS)
    .map(([id]) => id);
  const { tools, runs, inOrder } = usualOrder(chosen, orders, positions, turnsOf);
  const inPattern = new Set(tools);

  const rankedFirsts = ranked(firsts);
  const patternFirsts = rankedFirsts.filter(([id]) => inPattern.has(id));
  const otherFirsts = rankedFirsts
    .filter(([id, k]) => !inPattern.has(id) && k >= 2)
    .slice(0, Math.max(0, PATTERN_MAX_FIRSTS - patternFirsts.length));

  return {
    withCalls,
    tools: tools.map((id) => ({ id, turns: turnsOf.get(id) ?? 0 })),
    runs,
    inOrder,
    also: toTools(
      own
        .filter(([id, k]) => !inPattern.has(id) && k >= 2 && k / n >= PATTERN_ALSO_SHARE)
        .slice(0, PATTERN_MAX_ALSO),
    ),
    helpers: toTools(
      byCount
        .filter(([id, k]) => helpers.has(id) && k / n >= PATTERN_TOOL_SHARE)
        .slice(0, PATTERN_MAX_HELPERS),
    ),
    firsts: toTools(ranked(new Map([...patternFirsts, ...otherFirsts]))),
    comesBefore: comesBeforeSteps(before, ranIn, baseShare),
    skills: { invoked, offered },
  };
}

/**
 * The pattern's tools in their usual order: by their average position among
 * the turns that ran them all (or, when none did, among the turns each ran
 * in), and how many of those turns first called them in that order.
 */
function usualOrder(
  chosen: readonly string[],
  orders: readonly string[][],
  positions: Counts,
  turnsOf: Counts,
): { tools: string[]; runs: number; inOrder: number } {
  if (chosen.length === 0) return { tools: [], runs: 0, inOrder: 0 };
  const together: string[][] = orders.filter((order) => chosen.every((id) => order.includes(id)));
  const sum: Counts = new Map();
  for (const order of together) for (const id of chosen) bump(sum, id, order.indexOf(id));
  const mean = (id: string) =>
    together.length > 0
      ? (sum.get(id) ?? 0) / together.length
      : (positions.get(id) ?? 0) / Math.max(1, turnsOf.get(id) ?? 0);
  const tools = [...chosen].sort((a, b) => mean(a) - mean(b) || compareIds(a, b));
  const inOrder = together.filter((order) =>
    tools.every((id, i) => i === 0 || order.indexOf(id) > order.indexOf(tools[i - 1]!)),
  ).length;
  return { tools, runs: together.length, inOrder };
}

/** The pairs that clear "What comes before" inside the intent, heaviest first (the share times the tool's turns, as Agent health ranks them). */
function comesBeforeSteps(
  before: Counts,
  ranIn: Counts,
  baseShare: (id: string) => number,
): ComesBeforeStep[] {
  const steps: ComesBeforeStep[] = [];
  for (const [key, together] of before) {
    const [first, tool] = key.split(SEP) as [string, string];
    const turns = ranIn.get(tool) ?? 0;
    if (first === tool || turns < COMES_BEFORE_MIN_TURNS) continue;
    const confidence = together / turns;
    if (confidence < COMES_BEFORE_DRAWN) continue;
    const base = baseShare(first);
    // No base rate to read against (it cannot be zero for a tool that ran): the share alone decides.
    if (base > 0 && confidence / base < COMES_BEFORE_MIN_LIFT) continue;
    steps.push({ first, tool, turns, together });
  }
  return steps
    .sort(
      (a, b) =>
        b.together - a.together ||
        b.together / b.turns - a.together / a.turns ||
        compareIds(a.tool, b.tool) ||
        compareIds(a.first, b.first),
    )
    .slice(0, COMES_BEFORE_MAX_STEPS);
}

/* - Reading a stored pattern back ------------------------------------------- */

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A list of tools, each once; anything else does not parse. */
function parseTools(raw: unknown): PatternTool[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PatternTool[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const record = item as Partial<PatternTool> | null;
    if (!record || typeof record.id !== "string" || !isCount(record.turns) || seen.has(record.id))
      return null;
    seen.add(record.id);
    out.push({ id: record.id, turns: record.turns });
  }
  return out;
}

/** A list of steps, each pair once; anything else does not parse. */
function parseSteps(raw: unknown): ComesBeforeStep[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ComesBeforeStep[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const record = item as Partial<ComesBeforeStep> | null;
    if (
      !record ||
      typeof record.first !== "string" ||
      typeof record.tool !== "string" ||
      !isCount(record.turns) ||
      !isCount(record.together)
    )
      return null;
    const key = `${record.first}${SEP}${record.tool}`;
    if (seen.has(key)) return null;
    seen.add(key);
    out.push({
      first: record.first,
      tool: record.tool,
      turns: record.turns,
      together: record.together,
    });
  }
  return out;
}

/** A stored pattern, or null when it is missing or does not parse (stored JSON is untrusted). */
export function parseStoredPattern(raw: unknown): StoredTopicPattern | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const tools = parseTools(record.tools);
  const also = parseTools(record.also);
  const helpers = parseTools(record.helpers);
  const firsts = parseTools(record.firsts);
  const comesBefore = parseSteps(record.comesBefore);
  const skills = record.skills as { invoked?: unknown; offered?: unknown } | null | undefined;
  if (
    !tools ||
    !also ||
    !helpers ||
    !firsts ||
    !comesBefore ||
    !skills ||
    !isCount(skills.invoked) ||
    !isCount(skills.offered)
  )
    return null;
  if (!isCount(record.withCalls) || !isCount(record.runs) || !isCount(record.inOrder)) return null;
  return {
    withCalls: record.withCalls,
    tools,
    runs: record.runs,
    inOrder: record.inOrder,
    also,
    helpers,
    firsts,
    comesBefore,
    skills: { invoked: skills.invoked, offered: skills.offered },
  };
}
