/**
 * Every tool's home on the Tools lens, one each, so nothing floats:
 *
 * - its **task** (what the agent does for an ask), the task whose runs called
 *   it most, in that task's color (`lib/tasks/palette.ts`; tasks past the
 *   three colored ones are neutral);
 * - **Shared**, when the steps of `SHARED_FROM_TASKS` tasks or more hold it: a
 *   hub, which belongs to no one task, sits in the middle;
 * - **Other** ("No task"), when no task runs it: a ring around the rest.
 *
 * Without task readings (a graph from Adaptive ranking) the tools that run
 * together are the homes instead, the hubs Shared. Pure and deterministic:
 * ids and counts only.
 */
import type { IntentMapModel, MapTint } from "@/lib/views/intents/map/map-model";
import type { ToolNetworkModel } from "@/lib/views/intents/map/tool-network";

/** A tool in the steps of this many tasks or more is shared: it sits in the middle, in no one task. */
export const SHARED_FROM_TASKS = 3;

export const SHARED_HOME = "shared";
export const OTHER_HOME = "other";

export type HomeKind = "task" | "group" | "shared" | "other";

export interface ToolHome {
  /** `task:<id>`, `group:<id>`, `shared` or `other`. Ids only. */
  id: string;
  kind: HomeKind;
  /** The task, for a task's home. */
  task: string | null;
  /** Text only: a task's name is model-written. */
  name: string;
  /** A task's color; null stays neutral. */
  slot: MapTint | null;
  /** In the order they sit: a task's steps first, in order, then the busiest first. */
  members: string[];
}

export interface ToolHomes {
  /** Shared first, then the homes with the most tools, then Other; only homes that hold a tool. */
  homes: ToolHome[];
  /** Each tool's home id: every tool has exactly one. */
  homeOf: Map<string, string>;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const taskHomeId = (taskId: string) => `task:${taskId}`;

type Capability = IntentMapModel["capabilities"][number];

/** Every tool's home from its tasks, or, with no task known at all, from the tools it runs with. */
export function toolHomes(
  model: Pick<IntentMapModel, "capabilities" | "tasks">,
  network?: Pick<ToolNetworkModel, "nodes" | "groups">,
): ToolHomes {
  const knowsTasks =
    (model.tasks?.length ?? 0) > 0 || model.capabilities.some((capability) => capability.task);
  if (!knowsTasks && network) return groupHomes(model.capabilities, network);
  const tasks = [...(model.tasks ?? [])].sort((a, b) => b.runs - a.runs || byId(a.id, b.id));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const stepOf = new Map<string, string[]>();
  for (const task of tasks) {
    for (const tool of new Set(task.steps))
      stepOf.set(tool, [...(stepOf.get(tool) ?? []), task.id]);
  }
  const homeOf = new Map<string, string>();
  for (const capability of model.capabilities) {
    const steps = stepOf.get(capability.id) ?? [];
    const task = steps.length >= SHARED_FROM_TASKS ? null : (capability.task ?? steps[0] ?? null);
    homeOf.set(
      capability.id,
      steps.length >= SHARED_FROM_TASKS ? SHARED_HOME : task ? taskHomeId(task) : OTHER_HOME,
    );
  }
  const calls = new Map(model.capabilities.map((capability) => [capability.id, capability.calls]));
  const busiest = (a: string, b: string) => (calls.get(b) ?? 0) - (calls.get(a) ?? 0) || byId(a, b);
  const membersOf = (home: string, steps: readonly string[] = []) => {
    const own = model.capabilities
      .map((capability) => capability.id)
      .filter((id) => homeOf.get(id) === home);
    const inSteps = steps.filter((id) => own.includes(id));
    return [...inSteps, ...own.filter((id) => !inSteps.includes(id)).sort(busiest)];
  };
  const taskHomes = [...new Set([...homeOf.values()].filter((home) => home.startsWith("task:")))]
    .map((home): ToolHome => {
      const id = home.slice("task:".length);
      const task = taskById.get(id);
      return {
        id: home,
        kind: "task",
        task: id,
        name: task?.name ?? "Unnamed task",
        slot: task?.slot ?? null,
        members: membersOf(home, task?.steps),
      };
    })
    .sort(
      (a, b) =>
        b.members.length - a.members.length ||
        (taskById.get(b.task!)?.runs ?? 0) - (taskById.get(a.task!)?.runs ?? 0) ||
        byId(a.id, b.id),
    );
  return { homes: withEnds(taskHomes, membersOf(SHARED_HOME), membersOf(OTHER_HOME)), homeOf };
}

/** Shared first and Other last, each only when it holds a tool. */
function withEnds(middle: ToolHome[], shared: string[], other: string[]): ToolHome[] {
  return [
    ...(shared.length > 0
      ? [
          {
            id: SHARED_HOME,
            kind: "shared" as const,
            task: null,
            name: "Shared",
            slot: null,
            members: shared,
          },
        ]
      : []),
    ...middle,
    ...(other.length > 0
      ? [
          {
            id: OTHER_HOME,
            kind: "other" as const,
            task: null,
            name: "No task",
            slot: null,
            members: other,
          },
        ]
      : []),
  ];
}

/** With no tasks known: the groups of tools that run together are the homes, the hubs Shared, the rest Other. */
function groupHomes(
  capabilities: readonly Capability[],
  network: Pick<ToolNetworkModel, "nodes" | "groups">,
): ToolHomes {
  const known = new Set(capabilities.map((capability) => capability.id));
  const homeOf = new Map<string, string>();
  const groups = network.groups.map((group): ToolHome => {
    const members = group.members.filter((id) => known.has(id));
    for (const id of members) homeOf.set(id, `group:${group.id}`);
    return {
      id: `group:${group.id}`,
      kind: "group",
      task: null,
      name: "Run together",
      slot: group.color,
      members,
    };
  });
  const nodes = network.nodes.filter((node) => known.has(node.id) && !homeOf.has(node.id));
  for (const node of nodes) homeOf.set(node.id, node.hub ? SHARED_HOME : OTHER_HOME);
  for (const capability of capabilities)
    if (!homeOf.has(capability.id)) homeOf.set(capability.id, OTHER_HOME);
  const calls = new Map(capabilities.map((capability) => [capability.id, capability.calls]));
  const of = (home: string) =>
    capabilities
      .map((capability) => capability.id)
      .filter((id) => homeOf.get(id) === home)
      .sort((a, b) => (calls.get(b) ?? 0) - (calls.get(a) ?? 0) || byId(a, b));
  return {
    homes: withEnds(
      groups.filter((group) => group.members.length > 0),
      of(SHARED_HOME),
      of(OTHER_HOME),
    ),
    homeOf,
  };
}
