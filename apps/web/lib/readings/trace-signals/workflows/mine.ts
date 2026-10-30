import { type Bitset, bitsetOf } from "@/lib/readings/trace-signals/workflows/bitset";
import { type DeriveContext, deriveWorkflow } from "@/lib/readings/trace-signals/workflows/derive";
import { mineItemsets } from "@/lib/readings/trace-signals/workflows/itemsets";
import {
  greedySeeds,
  type SeedPick,
  seedCandidates,
} from "@/lib/readings/trace-signals/workflows/select";
import {
  DEFAULT_WORKFLOW_CONFIG,
  type TurnUnit,
  type Workflow,
  type WorkflowConfig,
  type WorkflowMiningResult,
  type WorkflowTurn,
} from "@/lib/readings/trace-signals/workflows/types";
import { turnUnit } from "@/lib/readings/trace-signals/workflows/units";

/**
 * Workflow mining (Phase W1): recurring groups of tools, found from telemetry
 * alone. Pure and deterministic: the same turns give the same workflows, in
 * the same order, with the same ids.
 *
 * - Unit: one turn, as its distinct tools and its first-call path. A turn
 *   with fewer than two distinct tools is a single step, never a workflow.
 * - IDF: a tool's weight is ln(1 + N / df) over the N multi-tool turns (the
 *   smoothed form, so a tool in every turn still weighs ln 2 rather than 0
 *   and a project with one dominant workflow can still score it); a tool in
 *   1% of turns weighs about 4.6, one in half of them about 1.1.
 * - Candidates: frequent itemsets of `minSize`..`maxSize` tools with support
 *   at least max(`minSupport`, `minShare` x N) (`itemsets.ts`), filtered to
 *   admissible, closed ones (`select.ts`).
 * - Selection: greedy by unassigned support x summed IDF (`select.ts`).
 * - Fields: core, optional and helper tools, entry tool, typical order and
 *   order stability per workflow (`derive.ts`).
 *
 * Cost: bitsets of N / 32 words per tool and per kept itemset; at most
 * `maxCandidates` itemsets, so memory is bounded by maxCandidates x N / 8 bytes.
 */

interface Vocabulary {
  toolIds: string[];
  df: number[];
  bits: Bitset[];
}

function vocabulary(multi: readonly TurnUnit[]): Vocabulary {
  const toolIds = [...new Set(multi.flatMap((unit) => unit.tools))].sort();
  const indexOf = new Map(toolIds.map((tool, index) => [tool, index]));
  const turnsOf: number[][] = toolIds.map(() => []);
  multi.forEach((unit, turn) => {
    for (const tool of unit.tools) turnsOf[indexOf.get(tool)!]!.push(turn);
  });
  return {
    toolIds,
    df: turnsOf.map((turns) => turns.length),
    bits: turnsOf.map((turns) => bitsetOf(multi.length, turns)),
  };
}

function idfOf(vocab: Vocabulary, n: number): Record<string, number> {
  return Object.fromEntries(
    vocab.toolIds.map((tool, index) => [tool, Math.log(1 + n / vocab.df[index]!)]),
  );
}

/** Derives each pick; two picks that land on one core are merged into the first. */
function workflowsOf(
  picks: readonly SeedPick[],
  multi: readonly TurnUnit[],
  ctx: DeriveContext,
): Workflow[] {
  const byId = new Map<string, { pick: SeedPick; members: number[] }>();
  for (const pick of picks) {
    const id = deriveWorkflow(
      pick.seed,
      pick.members.map((i) => multi[i]!),
      ctx,
    ).id;
    const existing = byId.get(id);
    byId.set(
      id,
      existing
        ? { ...existing, members: [...existing.members, ...pick.members] }
        : { pick, members: [...pick.members] },
    );
  }
  return [...byId.values()]
    .map(({ pick, members }) =>
      deriveWorkflow(
        pick.seed,
        [...members].sort((a, b) => a - b).map((i) => multi[i]!),
        ctx,
      ),
    )
    .sort((a, b) => b.runs - a.runs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function emptyResult(
  turnsWithTools: number,
  singleStepTurns: number,
  floor: number,
): WorkflowMiningResult {
  return {
    workflows: [],
    turnsWithTools,
    multiToolTurns: 0,
    singleStepTurns,
    assignedTurns: 0,
    supportFloor: floor,
    idf: {},
    ubiquitousTools: [],
    candidateCount: 0,
    truncated: false,
  };
}

export function mineWorkflows(
  turns: readonly Pick<WorkflowTurn, "id" | "steps">[],
  opts: Partial<WorkflowConfig> = {},
): WorkflowMiningResult {
  const config: WorkflowConfig = { ...DEFAULT_WORKFLOW_CONFIG, ...opts };
  const withTools = turns.map(turnUnit).filter((unit) => unit.tools.length > 0);
  const multi = withTools.filter((unit) => unit.tools.length >= 2);
  const n = multi.length;
  const floor = Math.max(config.minSupport, Math.ceil(config.minShare * n));
  const singleStepTurns = withTools.length - n;
  if (n === 0) return emptyResult(withTools.length, singleStepTurns, floor);

  const vocab = vocabulary(multi);
  const idf = idfOf(vocab, n);
  const baseRate = vocab.df.map((df) => df / n);
  const ubiquitous = new Set(
    baseRate.flatMap((rate, index) => (rate >= config.ubiquitousShare ? [index] : [])),
  );
  const lattice = mineItemsets(vocab.bits, {
    floor,
    maxSize: config.maxSize,
    maxCandidates: config.maxCandidates,
  });
  const ctx = {
    unitSets: multi.map((unit) => new Set(unit.tools)),
    toolIds: vocab.toolIds,
    idf,
    baseRate,
    ubiquitous,
    lattice,
    floor,
    config,
  };
  const picks = greedySeeds(seedCandidates(ctx), ctx);
  const ubiquitousTools = [...ubiquitous].map((index) => vocab.toolIds[index]!);
  const helperRates = new Map(
    [...ubiquitous].map((index) => [vocab.toolIds[index]!, baseRate[index]!]),
  );
  const workflows = workflowsOf(picks, multi, {
    ubiquitous: helperRates,
    turnsWithTools: withTools.length,
    config,
  });
  return {
    workflows,
    turnsWithTools: withTools.length,
    multiToolTurns: n,
    singleStepTurns,
    assignedTurns: workflows.reduce((sum, workflow) => sum + workflow.runs, 0),
    supportFloor: floor,
    idf,
    ubiquitousTools: ubiquitousTools.sort(),
    candidateCount: lattice.count,
    truncated: lattice.truncated,
  };
}
