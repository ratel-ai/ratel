import {
  orderStability,
  typicalOrder,
  workflowFingerprint,
} from "@/lib/readings/trace-signals/workflows/order";
import type {
  TurnUnit,
  Workflow,
  WorkflowConfig,
} from "@/lib/readings/trace-signals/workflows/types";

/**
 * A workflow's fields, read off the turns placed in it.
 *
 * - Core: the seed itemset, plus every tool in at least `coreShare` of member
 *   turns. A ubiquitous tool (base rate p) must clear the miner's helper rule
 *   as well: at least p + (1 - p) x `ubiquitousHeadroom` of member turns. A
 *   helper that runs in most turns of every kind sits near p inside any
 *   workflow, so it never defines one; a tool in literally every turn does.
 * - Optional: other non-ubiquitous tools in at least `optionalShare`.
 * - Helpers: ubiquitous tools outside the core in at least `optionalShare`.
 */

export interface DeriveContext {
  /** Base rate (share of multi-tool turns) of each ubiquitous tool. */
  ubiquitous: ReadonlyMap<string, number>;
  turnsWithTools: number;
  config: Pick<WorkflowConfig, "coreShare" | "optionalShare" | "ubiquitousHeadroom">;
}

export interface WorkflowSeed {
  tools: readonly string[];
  support: number;
}

function presence(members: readonly TurnUnit[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const unit of members)
    for (const tool of unit.tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  return counts;
}

function mostCommonFirst(members: readonly TurnUnit[]): string {
  const counts = new Map<string, number>();
  for (const unit of members) {
    const first = unit.path[0];
    if (first !== undefined) counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  const ranked = [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
  return ranked[0]?.[0] ?? "";
}

function splitTools(seed: WorkflowSeed, members: readonly TurnUnit[], ctx: DeriveContext) {
  const seedSet = new Set(seed.tools);
  const share = (n: number) => (members.length > 0 ? n / members.length : 0);
  const coreFloor = (tool: string) => {
    const p = ctx.ubiquitous.get(tool);
    return p === undefined
      ? ctx.config.coreShare
      : Math.max(ctx.config.coreShare, p + (1 - p) * ctx.config.ubiquitousHeadroom);
  };
  const rows = [...presence(members)].map(([tool, n]) => ({
    tool,
    share: share(n),
    helper: ctx.ubiquitous.has(tool),
  }));
  const isCore = (row: (typeof rows)[number]) =>
    seedSet.has(row.tool) || row.share >= coreFloor(row.tool);
  const rest = rows.filter((row) => !isCore(row) && row.share >= ctx.config.optionalShare);
  return {
    core: [...new Set([...seed.tools, ...rows.filter(isCore).map((row) => row.tool)])].sort(),
    optional: rest
      .filter((row) => !row.helper)
      .map((row) => row.tool)
      .sort(),
    helpers: rest
      .filter((row) => row.helper)
      .map((row) => row.tool)
      .sort(),
  };
}

export function deriveWorkflow(
  seed: WorkflowSeed,
  members: readonly TurnUnit[],
  ctx: DeriveContext,
): Workflow {
  const { core, optional, helpers } = splitTools(seed, members, ctx);
  const paths = members.map((unit) => unit.path);
  const order = typicalOrder(core, paths);
  const stability = orderStability(order, paths);
  return {
    id: workflowFingerprint(core),
    coreTools: core,
    optionalTools: optional,
    helperTools: helpers,
    entryTool: mostCommonFirst(members),
    typicalOrder: order,
    orderStability: stability.share,
    orderRuns: stability.runs,
    orderStableRuns: stability.stable,
    memberTurnIds: members.map((unit) => unit.turnId),
    runs: members.length,
    share: ctx.turnsWithTools > 0 ? members.length / ctx.turnsWithTools : 0,
    seedTools: [...seed.tools].sort(),
    seedSupport: seed.support,
  };
}
