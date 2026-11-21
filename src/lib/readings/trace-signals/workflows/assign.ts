import {
  DEFAULT_WORKFLOW_CONFIG,
  type WorkflowCore,
} from "@/lib/readings/trace-signals/workflows/types";

/**
 * Placing a turn in a workflow, and carrying workflow identity across runs.
 * Shared by the miner (which grows each workflow from its seed) and, later,
 * by the signals job (which places new turns in last run's workflows).
 */

/** Tool weights (the miner's IDF); a tool without one weighs `defaultWeight`. */
export interface AssignOptions {
  weights?: Readonly<Record<string, number>>;
  defaultWeight?: number;
  minJaccard?: number;
}

export interface CoreMatch {
  /** The turn ran every core tool. */
  contained: boolean;
  /** 1 when contained, else the weighted Jaccard of the turn's tools and the core. */
  score: number;
  /** Summed weight of the core, so a more specific core wins a tie. */
  coreWeight: number;
}

export interface Assignment {
  workflowId: string;
  score: number;
}

function weightOf(tool: string, options: AssignOptions): number {
  return options.weights?.[tool] ?? options.defaultWeight ?? 1;
}

/**
 * How a turn's distinct tools match a core: contained, or close enough by
 * weighted Jaccard (sum of weights shared over sum of weights in either).
 * Null when neither, so a turn that stopped after one step of four is not
 * claimed by a workflow it barely touched.
 */
export function matchScore(
  toolSet: ReadonlySet<string>,
  core: readonly string[],
  options: AssignOptions = {},
): CoreMatch | null {
  let shared = 0;
  let coreWeight = 0;
  let missing = false;
  for (const tool of core) {
    const weight = weightOf(tool, options);
    coreWeight += weight;
    if (toolSet.has(tool)) shared += weight;
    else missing = true;
  }
  if (!missing && core.length > 0) return { contained: true, score: 1, coreWeight };
  const coreSet = new Set(core);
  let extra = 0;
  for (const tool of toolSet) if (!coreSet.has(tool)) extra += weightOf(tool, options);
  const union = coreWeight + extra;
  const jaccard = union > 0 ? shared / union : 0;
  const floor = options.minJaccard ?? DEFAULT_WORKFLOW_CONFIG.assignJaccard;
  return jaccard >= floor ? { contained: false, score: jaccard, coreWeight } : null;
}

function better(a: CoreMatch, b: CoreMatch): boolean {
  if (a.contained !== b.contained) return a.contained;
  if (a.score !== b.score) return a.score > b.score;
  return a.coreWeight > b.coreWeight;
}

/**
 * The workflow a turn belongs to: a core it contains beats a Jaccard match;
 * among contained cores the heaviest (most specific) wins; ties keep the
 * earlier workflow. Null when no core matches.
 */
export function assignTurn(
  toolSet: Iterable<string>,
  workflows: readonly WorkflowCore[],
  options: AssignOptions = {},
): Assignment | null {
  const tools = new Set(toolSet);
  let best: { id: string; match: CoreMatch } | null = null;
  for (const workflow of workflows) {
    const match = matchScore(tools, workflow.coreTools, options);
    if (match && (!best || better(match, best.match))) best = { id: workflow.id, match };
  }
  return best ? { workflowId: best.id, score: best.match.score } : null;
}

/** Plain Jaccard of two tool lists (as sets). 0 when both are empty. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const tool of left) if (right.has(tool)) shared += 1;
  const union = left.size + right.size - shared;
  return union > 0 ? shared / union : 0;
}

/** Default floor for {@link matchPrevious}: a 4-tool core survives one tool added or dropped. */
export const MATCH_PREVIOUS_JACCARD = 0.7;

/**
 * Maps this run's workflow fingerprints to last run's workflow ids, so a
 * workflow keeps its id (and its name) when its core drifts by a tool.
 * Previous ids need not be fingerprints: a stored workflow keeps the id it
 * was first given. Pairs are matched one to one, highest core Jaccard first
 * (so an identical core always wins; ties by id), at `minJaccard` or more. A
 * workflow with no counterpart is absent from the map: it is new.
 */
export function matchPrevious(
  current: readonly WorkflowCore[],
  previous: readonly WorkflowCore[],
  minJaccard: number = MATCH_PREVIOUS_JACCARD,
): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const pairs = current
    .flatMap((c) =>
      previous.map((p) => ({ c: c.id, p: p.id, j: jaccard(c.coreTools, p.coreTools) })),
    )
    .filter((pair) => pair.j >= minJaccard)
    .sort(
      (x, y) =>
        y.j - x.j || (x.c < y.c ? -1 : x.c > y.c ? 1 : 0) || (x.p < y.p ? -1 : x.p > y.p ? 1 : 0),
    );
  for (const pair of pairs) {
    if (out.has(pair.c) || used.has(pair.p)) continue;
    out.set(pair.c, pair.p);
    used.add(pair.p);
  }
  return out;
}
