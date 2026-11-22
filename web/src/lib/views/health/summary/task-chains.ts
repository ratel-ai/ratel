import type { TaskColorSlot } from "@ratel/design-system/task-colors";
import type { JourneyChain } from "@/lib/readings/trace-signals/flow-journey-insights";
import { taskHref } from "@/lib/views/tasks/paths";

/**
 * Common chains named by their task (round 3, B10): a chain of calls that
 * repeats is shown only when it is a task, its steps run one after another,
 * and never as a raw list of tools. A chain is a task when it calls exactly
 * the task's tools, each once: in the task's own order first, else in any
 * order (the same task, run the other way round). One row per task, the
 * chain with the most turns, most turns first. Pure.
 */

/** Rows shown at most. */
export const TASK_CHAINS_SHOWN = 8;

export interface ChainTaskInput {
  id: string;
  name: string;
  color: TaskColorSlot | null;
  /** Its steps: the tools it runs, in their usual order. */
  tools: readonly string[];
}

export interface TaskChain {
  chain: JourneyChain;
  task: { id: string; name: string; color: TaskColorSlot | null; href: string };
  /** The chain runs the steps in the task's own order. */
  inOrder: boolean;
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  if (a.length !== b.length || new Set(a).size !== a.length) return false;
  const set = new Set(b);
  return a.every((tool) => set.has(tool));
};

const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((tool, index) => tool === b[index]);

export function chainsAsTasks(
  chains: readonly JourneyChain[],
  tasks: readonly ChainTaskInput[],
  projectId: string,
  limit: number = TASK_CHAINS_SHOWN,
): TaskChain[] {
  const rows: TaskChain[] = [];
  for (const task of tasks) {
    if (task.tools.length < 2) continue;
    const matching = chains.filter((chain) => sameSet(chain.tools, task.tools));
    const best =
      matching.find((chain) => sameOrder(chain.tools, task.tools)) ??
      [...matching].sort((a, b) => b.turns - a.turns)[0];
    if (!best) continue;
    rows.push({
      chain: best,
      task: { id: task.id, name: task.name, color: task.color, href: taskHref(projectId, task.id) },
      inOrder: sameOrder(best.tools, task.tools),
    });
  }
  return rows
    .sort((a, b) => b.chain.turns - a.chain.turns || (a.task.id < b.task.id ? -1 : 1))
    .slice(0, limit);
}
