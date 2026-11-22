import {
  type Bitset,
  bitsetOf,
  emptyBitset,
  indicesAndNot,
  popcountAndNot,
  union,
} from "@/lib/readings/trace-signals/workflows/bitset";
import type { WorkflowSeed } from "@/lib/readings/trace-signals/workflows/derive";
import {
  type Itemset,
  itemsetKey,
  type Lattice,
} from "@/lib/readings/trace-signals/workflows/itemsets";
import type { WorkflowConfig } from "@/lib/readings/trace-signals/workflows/types";

/**
 * From frequent itemsets to a short, non-redundant list of workflow seeds.
 *
 * 1. Admissible: an itemset may hold a ubiquitous tool (base rate p) only when
 *    the rest of the itemset predicts it: support(X) / support(X minus t) >=
 *    p + (1 - p) * headroom. A helper that runs in most turns of every kind
 *    sits near its base rate inside any group and is kept out; a tool that
 *    really belongs to a group runs in nearly all of its turns and stays in.
 * 2. Closed: an itemset is absorbed by an admissible superset one tool larger
 *    whose support is at least `closedRatio` of its own, so A,B never wins
 *    over A,B,C when C nearly always comes along.
 * 3. Greedy: an itemset takes every unassigned turn that contains it, plus
 *    every one within the weighted Jaccard floor of it (a run that skipped a
 *    step or stopped early). Its score is support x (sum of its tools' IDF),
 *    where a near turn counts the weight it ran minus the weight it skipped
 *    (see `coverage`). Rare, specific tools weigh more than common ones;
 *    ties go to the larger itemset, then by key. Only the `rerankTop` best
 *    by contained support are scored in full each round, which bounds the
 *    Jaccard scans. Repeat until no itemset still contains the support floor
 *    of unassigned turns, or `maxWorkflows` are picked.
 */

export interface SelectionContext {
  /** Tool sets of the multi-tool turns, by turn index. */
  unitSets: readonly ReadonlySet<string>[];
  /** Tool id by index (index order is id order). */
  toolIds: readonly string[];
  idf: Readonly<Record<string, number>>;
  /** Share of multi-tool turns each tool ran in, by index. */
  baseRate: readonly number[];
  ubiquitous: ReadonlySet<number>;
  lattice: Lattice;
  floor: number;
  config: WorkflowConfig;
}

export interface SeedPick {
  seed: WorkflowSeed;
  /** Turn indices, ascending. */
  members: readonly number[];
}

function admissible(set: Itemset, ctx: SelectionContext): boolean {
  for (const item of set.items) {
    if (!ctx.ubiquitous.has(item)) continue;
    const parent = ctx.lattice.byKey.get(itemsetKey(set.items.filter((other) => other !== item)));
    if (!parent) return false;
    const p = ctx.baseRate[item] ?? 0;
    if (set.support / parent.support < p + (1 - p) * ctx.config.ubiquitousHeadroom) return false;
  }
  return true;
}

function absorbedKeys(admitted: readonly Itemset[], ctx: SelectionContext): Set<string> {
  const absorbed = new Set<string>();
  for (const superset of admitted) {
    if (superset.items.length <= ctx.config.minSize) continue;
    for (const drop of superset.items) {
      const key = itemsetKey(superset.items.filter((item) => item !== drop));
      const subset = ctx.lattice.byKey.get(key);
      if (subset && superset.support / subset.support >= ctx.config.closedRatio) absorbed.add(key);
    }
  }
  return absorbed;
}

/** Admissible, closed itemsets of the configured sizes. */
export function seedCandidates(ctx: SelectionContext): Itemset[] {
  const sized = ctx.lattice.levels.slice(ctx.config.minSize, ctx.config.maxSize + 1).flat();
  const admitted = sized.filter((set) => admissible(set, ctx));
  const absorbed = absorbedKeys(admitted, ctx);
  return admitted.filter((set) => !absorbed.has(set.key));
}

interface Ranked {
  set: Itemset;
  weight: number;
  /** Unassigned turns containing the itemset. */
  contained: number;
}

interface Scored extends Ranked {
  /** Contained turns plus near ones (weighted Jaccard at the floor or more). */
  members: number[];
  score: number;
}

function weightOf(set: Itemset, ctx: SelectionContext): number {
  return set.items.reduce((sum, item) => sum + (ctx.idf[ctx.toolIds[item]!] ?? 0), 0);
}

function outranks(a: Scored, b: Scored): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.set.items.length !== b.set.items.length) return a.set.items.length > b.set.items.length;
  return a.set.key < b.set.key;
}

/** Candidates still covering the floor, best contained score first, at most `limit`. */
function shortlist(
  candidates: readonly Ranked[],
  assigned: Bitset,
  floor: number,
  limit: number,
): Ranked[] {
  return candidates
    .map((c) => ({ ...c, contained: popcountAndNot(c.set.bits, assigned) }))
    .filter((c) => c.contained >= floor)
    .sort(
      (a, b) =>
        b.contained * b.weight - a.contained * a.weight ||
        b.set.items.length - a.set.items.length ||
        (a.set.key < b.set.key ? -1 : 1),
    )
    .slice(0, limit);
}

interface Coverage {
  members: number[];
  /** Summed over members: core weight the turn ran minus core weight it skipped. */
  score: number;
}

/**
 * The unassigned turns an itemset would take: those containing it, and those
 * at the weighted Jaccard floor (the formula of `matchScore`, inlined over
 * precomputed turn weights because it runs over many turns per pick). Only
 * turns sharing a tool with the itemset are read.
 *
 * The score credits each member with the core weight it ran and debits the
 * core weight it skipped. For contained turns that is support x weight; a
 * near turn adds less, so a superset with a rare optional tool cannot win by
 * claiming the turns that never ran it, while a workflow whose failing runs
 * stop one step early still beats its own prefix.
 */
function coverage(
  set: Itemset,
  weight: number,
  assigned: Bitset,
  ctx: SelectionContext,
  turnWeights: readonly number[],
): Coverage {
  const tools = set.items.map((item) => ({
    id: ctx.toolIds[item]!,
    w: ctx.idf[ctx.toolIds[item]!] ?? 0,
  }));
  const touched = set.items
    .map((item) => ctx.lattice.byKey.get(itemsetKey([item]))!.bits)
    .reduce((acc, bits) => union(acc, bits));
  const members: number[] = [];
  let score = 0;
  for (const index of indicesAndNot(touched, assigned)) {
    const unit = ctx.unitSets[index]!;
    const shared = tools.reduce((sum, tool) => sum + (unit.has(tool.id) ? tool.w : 0), 0);
    const contained = tools.every((tool) => unit.has(tool.id));
    const unionWeight = weight + turnWeights[index]! - shared;
    if (!contained && !(unionWeight > 0 && shared / unionWeight >= ctx.config.assignJaccard))
      continue;
    members.push(index);
    score += shared - (weight - shared);
  }
  return { members, score };
}

/**
 * The next pick: the shortlist by contained support x weight, re-scored by
 * the turns each would really take (see {@link coverage}).
 */
function bestCandidate(
  candidates: readonly Ranked[],
  assigned: Bitset,
  ctx: SelectionContext,
  turnWeights: readonly number[],
): Scored | null {
  let best: Scored | null = null;
  for (const ranked of shortlist(candidates, assigned, ctx.floor, ctx.config.rerankTop)) {
    const scored: Scored = {
      ...ranked,
      ...coverage(ranked.set, ranked.weight, assigned, ctx, turnWeights),
    };
    if (!best || outranks(scored, best)) best = scored;
  }
  return best;
}

/** The greedy pass: seeds in pick order, each with the turns it took. */
export function greedySeeds(candidates: readonly Itemset[], ctx: SelectionContext): SeedPick[] {
  const size = ctx.unitSets.length;
  const ranked = candidates.map((set) => ({
    set,
    weight: weightOf(set, ctx),
    contained: set.support,
  }));
  const turnWeights = ctx.unitSets.map((unit) =>
    [...unit].reduce((sum, tool) => sum + (ctx.idf[tool] ?? 0), 0),
  );
  const picks: SeedPick[] = [];
  let assigned = emptyBitset(size);
  while (picks.length < ctx.config.maxWorkflows) {
    const best = bestCandidate(ranked, assigned, ctx, turnWeights);
    if (!best) break;
    assigned = union(assigned, bitsetOf(size, best.members));
    const tools = best.set.items.map((item) => ctx.toolIds[item]!);
    picks.push({ seed: { tools, support: best.contained }, members: best.members });
  }
  return picks;
}
