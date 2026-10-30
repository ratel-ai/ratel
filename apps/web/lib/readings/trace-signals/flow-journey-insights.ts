import type { FlowJourney } from "@/lib/readings/trace-signals/view";
import { FLOW_JOURNEY_OTHER } from "@/lib/readings/trace-signals/view";

/**
 * Two readings of the stored journey (`flow.journey`: each turn's first calls,
 * with turn counts), for the flow map's "Common chains" and "Needs first"
 * lists. Both are pure and read only what every stored run already has, so
 * they need no recompute and no new summary field. Any sequence that touches
 * a tool the run folded ("other") is skipped: it stands for many tools.
 *
 * - A chain is a run of consecutive calls (2 to 8) that repeats across turns.
 *   It counts once per turn, a call repeated back to back (A then A) breaks
 *   it (the Repeat shape covers those), and a chain is dropped when a longer
 *   chain containing it holds nearly all its turns, so the list shows the
 *   longest shape a habit takes rather than every piece of it.
 * - "Needs first" pairs a tool B with a tool A that ran before it (anywhere
 *   earlier in the turn) in almost all of B's turns, far more often than A
 *   runs in turns in general: a strong sign that B needs what A finds.
 */

/** A chain must be seen in at least this many turns... */
export const CHAIN_MIN_TURNS = 5;
/** ...and in at least this share of the journey's turns. */
export const CHAIN_MIN_SHARE = 0.01;
/** A chain gives way to a longer one containing it that holds at least this share of its turns. */
export const CHAIN_MAXIMAL_SHARE = 0.8;
/** Chains shown at most. */
export const CHAIN_LIMIT = 6;

/** A tool is only read for prerequisites once it ran in at least this many turns. */
export const PREREQ_MIN_TURNS = 20;
/** "Almost always": the earlier tool ran before it in at least this share of its turns. */
export const PREREQ_STRONG_CONFIDENCE = 0.8;
/** "Usually": the lighter tier, shown only when the strong tier is (nearly) empty. */
export const PREREQ_USUAL_CONFIDENCE = 0.6;
/** Either tier also needs the earlier tool to run this many times more often before it than in turns in general. */
export const PREREQ_MIN_LIFT = 2;
/** The "usually" tier joins in when fewer strong relations than this qualify. */
export const PREREQ_SPARSE_BELOW = 2;
/** Relations drawn at most. */
export const PREREQ_LIMIT = 8;

export interface JourneyChain {
  /** Tool ids, in call order. */
  tools: readonly string[];
  labels: readonly string[];
  /** Turns the chain appeared in (once each). */
  turns: number;
  /** Of the journey's turns. */
  share: number;
  /** turns × (calls − 1): how many repeated steps the chain accounts for. */
  score: number;
}

export interface JourneyPrerequisite {
  /** The tool that needs another first, and its label. */
  tool: string;
  toolLabel: string;
  /** The tool that ran first, and its label. */
  first: string;
  firstLabel: string;
  /** Turns the tool ran in. */
  turns: number;
  /** Of those, turns where the first tool ran before it. */
  together: number;
  /** together ÷ turns. */
  confidence: number;
  /** confidence ÷ the first tool's share of all turns. */
  lift: number;
  /** "strong" at {@link PREREQ_STRONG_CONFIDENCE} or more, "usual" below it. */
  tier: PrerequisiteTier;
  /**
   * Where the pair was counted. Absent: read off the journey's paths, per turn
   * (`turns` counts turns). Otherwise the run counted calls (`turns` counts
   * uses of the tool): "window" when the first tool ran within
   * `windowMinutes` before it in the same session, "turn" when only inside
   * the same turn qualified.
   */
  scope?: PrerequisiteScope;
  /** The window, for "window" pairs. */
  windowMinutes?: number;
  /**
   * The pair mostly crosses turns: most of its "before" calls were in an
   * earlier turn, so the journey cannot draw it along a turn's calls and the
   * map links the two tools directly.
   */
  crossTurn?: boolean;
}

export type PrerequisiteTier = "strong" | "usual";
export type PrerequisiteScope = "window" | "turn";

/** A pair crosses turns when fewer than this share of its "before" calls were in the same turn. */
export const PREREQ_CROSS_TURN_BELOW = 0.5;

/** What the prerequisites card shows, and what it can say when it shows nothing. */
export interface PrerequisiteReading {
  /** Relations to draw: every strong one, plus the usual ones when strong ones are sparse. */
  relations: JourneyPrerequisite[];
  /** Every strong relation (before the limit). */
  strong: number;
  /** Every usual relation (before the limit), drawn or not. */
  usual: number;
  /** The strongest pair that did not qualify (B in enough turns, lift reached), for the empty state. */
  closest: JourneyPrerequisite | null;
  /** Of all turns, those that made one call or none: nothing to order. */
  singleCallShare: number;
  /** Turns each tool in a drawn relation ran in. */
  toolTurns: Readonly<Record<string, number>>;
}

const SEP = "\u0001";

function labelsOf(journey: FlowJourney): (id: string) => string {
  const labels = new Map(journey.tools.map((tool) => [tool.id, tool.label]));
  return (id) => labels.get(id) ?? id;
}

/** Every chain in one turn's calls, once each: runs of 2 or more with no folded tool and no back-to-back repeat. */
function chainsIn(tools: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let start = 0; start < tools.length; start += 1) {
    if (tools[start] === FLOW_JOURNEY_OTHER) continue;
    for (let end = start + 1; end < tools.length; end += 1) {
      if (tools[end] === FLOW_JOURNEY_OTHER || tools[end] === tools[end - 1]) break;
      out.add(tools.slice(start, end + 1).join(SEP));
    }
  }
  return out;
}

/** Whether `inner` runs consecutively inside `outer`. */
function contains(outer: readonly string[], inner: readonly string[]): boolean {
  if (inner.length >= outer.length) return false;
  for (let i = 0; i + inner.length <= outer.length; i += 1) {
    if (inner.every((id, k) => outer[i + k] === id)) return true;
  }
  return false;
}

/**
 * The chains of calls that repeat most, longest shape first: supported by
 * {@link CHAIN_MIN_TURNS} turns and {@link CHAIN_MIN_SHARE} of all turns,
 * maximal (see {@link CHAIN_MAXIMAL_SHARE}), ranked by turns × (calls − 1).
 */
export function commonChains(
  journey: FlowJourney | undefined,
  limit: number = CHAIN_LIMIT,
): JourneyChain[] {
  if (!journey || journey.turns <= 0) return [];
  const counts = new Map<string, number>();
  for (const path of journey.paths) {
    if (path.turns <= 0) continue;
    for (const key of chainsIn(path.tools)) counts.set(key, (counts.get(key) ?? 0) + path.turns);
  }
  const floor = Math.max(CHAIN_MIN_TURNS, CHAIN_MIN_SHARE * journey.turns);
  const supported = [...counts]
    .filter(([, turns]) => turns >= floor)
    .map(([key, turns]) => ({ tools: key.split(SEP), turns }));
  const maximal = supported.filter(
    (chain) =>
      !supported.some(
        (longer) =>
          longer.turns >= CHAIN_MAXIMAL_SHARE * chain.turns && contains(longer.tools, chain.tools),
      ),
  );
  const label = labelsOf(journey);
  return maximal
    .map((chain) => ({
      tools: chain.tools,
      labels: chain.tools.map(label),
      turns: chain.turns,
      share: chain.turns / journey.turns,
      score: chain.turns * (chain.tools.length - 1),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.tools.length - a.tools.length ||
        (a.tools.join(SEP) < b.tools.join(SEP) ? -1 : 1),
    )
    .slice(0, limit);
}

/**
 * Tools that almost always come after another. For every pair (A, B) where
 * B ran in {@link PREREQ_MIN_TURNS} turns: confidence is the share of B's
 * turns where A ran earlier (anywhere earlier), lift is that over A's share
 * of all turns. A pair is "strong" at {@link PREREQ_STRONG_CONFIDENCE}, and
 * "usual" at {@link PREREQ_USUAL_CONFIDENCE}; both need
 * {@link PREREQ_MIN_LIFT}. A tool can need more than one tool first. The
 * usual tier is drawn only when fewer than {@link PREREQ_SPARSE_BELOW}
 * strong pairs exist, so an obvious prerequisite is never crowded out.
 * Sorted by tier, then confidence × B's turns.
 */
export function readPrerequisites(
  journey: FlowJourney | undefined,
  limit: number = PREREQ_LIMIT,
): PrerequisiteReading {
  const empty: PrerequisiteReading = {
    relations: [],
    strong: 0,
    usual: 0,
    closest: null,
    singleCallShare: 0,
    toolTurns: {},
  };
  if (!journey || journey.turns <= 0) return empty;
  const toolTurns = new Map<string, number>();
  const before = new Map<string, number>();
  let singleCall = 0;
  for (const path of journey.paths) {
    if (path.turns <= 0) continue;
    if (path.tools.length <= 1) singleCall += path.turns;
    const firstAt = new Map<string, number>();
    path.tools.forEach((id, i) => {
      if (id !== FLOW_JOURNEY_OTHER && !firstAt.has(id)) firstAt.set(id, i);
    });
    for (const id of firstAt.keys()) toolTurns.set(id, (toolTurns.get(id) ?? 0) + path.turns);
    // A ran before B: A's first call comes before B's first call.
    for (const [b, bAt] of firstAt) {
      for (const [a, aAt] of firstAt) {
        if (a === b || aAt >= bAt) continue;
        const key = `${a}${SEP}${b}`;
        before.set(key, (before.get(key) ?? 0) + path.turns);
      }
    }
  }
  const label = labelsOf(journey);
  const qualified: JourneyPrerequisite[] = [];
  let closest: JourneyPrerequisite | null = null;
  for (const [key, together] of before) {
    const [first, tool] = key.split(SEP);
    const turns = toolTurns.get(tool) ?? 0;
    if (turns < PREREQ_MIN_TURNS) continue;
    const confidence = together / turns;
    const lift = confidence / ((toolTurns.get(first) ?? 0) / journey.turns);
    if (lift < PREREQ_MIN_LIFT) continue;
    const tier: PrerequisiteTier = confidence >= PREREQ_STRONG_CONFIDENCE ? "strong" : "usual";
    const row = {
      tool,
      toolLabel: label(tool),
      first,
      firstLabel: label(first),
      turns,
      together,
      confidence,
      lift,
      tier,
    };
    if (confidence >= PREREQ_USUAL_CONFIDENCE) qualified.push(row);
    else if (!closest || byWeight(row, closest) < 0) closest = row;
  }
  const strong = qualified.filter((row) => row.tier === "strong").sort(byWeight);
  const usual = qualified.filter((row) => row.tier === "usual").sort(byWeight);
  const relations = (strong.length < PREREQ_SPARSE_BELOW ? [...strong, ...usual] : strong).slice(
    0,
    limit,
  );
  const involved = new Set(relations.flatMap((row) => [row.first, row.tool]));
  return {
    relations,
    strong: strong.length,
    usual: usual.length,
    closest,
    singleCallShare: singleCall / journey.turns,
    toolTurns: Object.fromEntries([...involved].sort().map((id) => [id, toolTurns.get(id) ?? 0])),
  };
}

/**
 * The pairs a run stored (`journey.prerequisites`, counted call by call across
 * sessions), as relations, with the same tiers and limit as
 * {@link readPrerequisites}. A pair that qualifies within the window is read
 * as such; one that only qualifies inside a turn is read that way. Null when
 * the run stored none (runs from before it): the caller falls back to the
 * paths. The path reading still gives the "why" of an empty view.
 */
export function readStoredPrerequisites(
  journey: FlowJourney | undefined,
  limit: number = PREREQ_LIMIT,
): Pick<PrerequisiteReading, "relations" | "strong" | "usual"> | null {
  const stored = journey?.prerequisites;
  if (!journey || !stored) return null;
  const label = labelsOf(journey);
  const minutes = Math.round(stored.windowMs / 60_000);
  const qualified: JourneyPrerequisite[] = [];
  for (const pair of stored.pairs) {
    if (pair.uses < PREREQ_MIN_TURNS || pair.first === pair.tool) continue;
    if (pair.first === FLOW_JOURNEY_OTHER || pair.tool === FLOW_JOURNEY_OTHER) continue;
    const inWindow = pair.window / pair.uses;
    const inTurn = pair.turn / pair.uses;
    const windowOk = inWindow >= PREREQ_USUAL_CONFIDENCE && pair.windowLift >= PREREQ_MIN_LIFT;
    const turnOk = inTurn >= PREREQ_USUAL_CONFIDENCE && pair.turnLift >= PREREQ_MIN_LIFT;
    if (!windowOk && !turnOk) continue;
    const scope: PrerequisiteScope = windowOk ? "window" : "turn";
    const confidence = windowOk ? inWindow : inTurn;
    qualified.push({
      tool: pair.tool,
      toolLabel: label(pair.tool),
      first: pair.first,
      firstLabel: label(pair.first),
      turns: pair.uses,
      together: windowOk ? pair.window : pair.turn,
      confidence,
      lift: windowOk ? pair.windowLift : pair.turnLift,
      tier: confidence >= PREREQ_STRONG_CONFIDENCE ? "strong" : "usual",
      scope,
      ...(windowOk ? { windowMinutes: minutes } : {}),
      crossTurn: windowOk && pair.turn < PREREQ_CROSS_TURN_BELOW * pair.window,
    });
  }
  const strong = qualified.filter((row) => row.tier === "strong").sort(byWeight);
  const usual = qualified.filter((row) => row.tier === "usual").sort(byWeight);
  const relations = (strong.length < PREREQ_SPARSE_BELOW ? [...strong, ...usual] : strong).slice(
    0,
    limit,
  );
  return { relations, strong: strong.length, usual: usual.length };
}

/** Heavier first: confidence × the tool's turns, then the names, so the order never depends on input order. */
function byWeight(a: JourneyPrerequisite, b: JourneyPrerequisite): number {
  return (
    b.confidence * b.turns - a.confidence * a.turns ||
    (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0) ||
    (a.first < b.first ? -1 : a.first > b.first ? 1 : 0)
  );
}
