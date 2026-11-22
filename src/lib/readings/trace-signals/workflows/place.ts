import { assignTurn } from "@/lib/readings/trace-signals/workflows/assign";
import { orderStability, typicalOrder } from "@/lib/readings/trace-signals/workflows/order";
import { minesRun, type WorkflowBasis } from "@/lib/readings/trace-signals/workflows/run-basis";
import {
  DEFAULT_WORKFLOW_CONFIG,
  type TurnUnit,
  type Workflow,
  type WorkflowCore,
  type WorkflowTurn,
} from "@/lib/readings/trace-signals/workflows/types";
import { turnUnit } from "@/lib/readings/trace-signals/workflows/units";

/**
 * Which task each run belongs to: the one placement rule (`assignTurn`) over
 * the run's distinct tools, against the tasks a signal run mined. The miner
 * finds the tasks; this places every run in the window in one of them, so a
 * task's numbers, its pages and `trace_turns.workflow_id` all count the same
 * runs.
 *
 * - A run needs {@link MIN_TASK_TOOLS} distinct tools: one tool is a single
 *   step, never a task (the miner's own population). Placing single tools by
 *   weight alone puts every lone call of a rare tool in the task that holds
 *   it (on one customer's replay, 22 runs of a two-step task became 193).
 * - Runs the run basis does not read (`run-basis.ts`: guessed runs once exact
 *   ones carry the reading, every run when runs look mixed) belong to none.
 *
 * A task's shape is then read again from the runs placed in it, with its core
 * unchanged: the order, how stable it is, the first tool, and the optional and
 * helper tools ({@link reshapeWorkflow}). Pure.
 */

export const MIN_TASK_TOOLS = 2;

export interface PlacementOptions {
  /** Tool weights (the miner's IDF); a tool without one weighs 1. */
  weights: Readonly<Record<string, number>>;
  basis: WorkflowBasis;
}

/** Each run's task id, or null; every run given has an entry, in input order. */
export function placeRuns(
  runs: readonly Pick<WorkflowTurn, "id" | "steps" | "turnSource">[],
  tasks: readonly WorkflowCore[],
  options: PlacementOptions,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const run of runs) {
    const tools = turnUnit(run).tools;
    const placed =
      tools.length >= MIN_TASK_TOOLS && minesRun(options.basis, run.turnSource)
        ? assignTurn(tools, tasks, { weights: options.weights })
        : null;
    out.set(run.id, placed?.workflowId ?? null);
  }
  return out;
}

/** The runs of each task, in placement order. */
export function membersByTask(
  placement: ReadonlyMap<string, string | null>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [runId, taskId] of placement) {
    if (taskId === null) continue;
    const members = out.get(taskId);
    if (members) members.push(runId);
    else out.set(taskId, [runId]);
  }
  return out;
}

export interface ReshapeContext {
  /** Tools in at least `ubiquitousShare` of the multi-tool runs (the miner's helpers). */
  ubiquitous: ReadonlySet<string>;
  /** Runs that called a tool: what `share` is of. */
  turnsWithTools: number;
  optionalShare?: number;
}

function mostCommonFirst(members: readonly TurnUnit[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const unit of members) {
    const first = unit.path[0];
    if (first !== undefined) counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  const ranked = [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
  return ranked[0]?.[0] ?? fallback;
}

/** Non-core tools in at least `optionalShare` of the members, split into optional and helpers, sorted. */
function aroundTheCore(
  workflow: Pick<Workflow, "coreTools">,
  members: readonly TurnUnit[],
  ctx: ReshapeContext,
) {
  const coreSet = new Set(workflow.coreTools);
  const floor = ctx.optionalShare ?? DEFAULT_WORKFLOW_CONFIG.optionalShare;
  const presence = new Map<string, number>();
  for (const unit of members)
    for (const tool of unit.tools) presence.set(tool, (presence.get(tool) ?? 0) + 1);
  const around = [...presence]
    .filter(([tool, n]) => !coreSet.has(tool) && members.length > 0 && n / members.length >= floor)
    .map(([tool]) => tool)
    .sort();
  return {
    optionalTools: around.filter((tool) => !ctx.ubiquitous.has(tool)),
    helperTools: around.filter((tool) => ctx.ubiquitous.has(tool)),
  };
}

/** The workflow as its placed runs show it: same id and core, everything else read from `members`. */
export function reshapeWorkflow(
  workflow: Workflow,
  members: readonly TurnUnit[],
  ctx: ReshapeContext,
): Workflow {
  const paths = members.map((unit) => unit.path);
  const order = typicalOrder(workflow.coreTools, paths);
  const stability = orderStability(order, paths);
  return {
    ...workflow,
    ...aroundTheCore(workflow, members, ctx),
    entryTool: mostCommonFirst(members, workflow.entryTool),
    typicalOrder: order,
    orderStability: stability.share,
    orderRuns: stability.runs,
    orderStableRuns: stability.stable,
    memberTurnIds: members.map((unit) => unit.turnId),
    runs: members.length,
    share: ctx.turnsWithTools > 0 ? members.length / ctx.turnsWithTools : 0,
  };
}
