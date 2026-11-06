import type {
  IntentMapModel,
  MapAsk,
  MapCapability,
  MapLink,
  MapTask,
  MapTint,
} from "@/lib/views/intents/map/map-model";
import { explorerCapabilityKey } from "@/lib/views/intents/map/tool-network";
import type { TopicsView } from "@/lib/views/intents/topics-view";

/**
 * Intents (stored as topics) as the intent map's model
 * (`lib/intent-graph/v2/map-model.ts`), so the Map, Flow and Tools lenses draw
 * intents: each intent is a group, its tools are the capabilities its asks
 * called, and a link is how often an intent's asks called a tool. An intent's
 * blob takes its main task's color as a tint and a tool takes the color of the
 * task whose runs called it most; intents that mostly went unanswered wear the
 * warning mark. The tasks come along with their steps, so the Tools lens can
 * give every tool a home. Pure; ids and counts, with names as visible labels
 * only.
 */

export interface MapToolInput {
  /** A catalog tool id, or `skill:<id>`. */
  id: string;
  calls: number;
  failures: number;
  /** The task whose runs called it most. */
  task: string | null;
}

/** A task and the tools in its steps (catalog ids, or `skill:<id>`), from the latest task reading. */
export interface MapTaskInput {
  id: string;
  runs: number;
  steps: readonly string[];
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function topicMapModel(
  view: Pick<TopicsView, "topics" | "taskSlots"> & Partial<Pick<TopicsView, "taskNames">>,
  tools: readonly MapToolInput[],
  /** The tasks with their steps; without them, a tool's main task is all that is known. */
  tasks?: readonly MapTaskInput[],
): IntentMapModel {
  const toolTask = new Map(tools.map((tool) => [tool.id, tool.task]));
  const tint = (taskId: string | null | undefined): MapTint | null =>
    taskId ? (view.taskSlots[taskId] ?? null) : null;
  const capabilities = new Map<string, MapCapability>();
  const links: MapLink[] = [];
  const asks: MapAsk[] = view.topics.map((topic) => {
    const total = topic.tools.reduce((sum, tool) => sum + tool.calls, 0);
    for (const tool of topic.tools) {
      if (!(tool.calls > 0)) continue;
      const key = explorerCapabilityKey(tool.id);
      const skill = tool.id.startsWith("skill:");
      const task = toolTask.get(tool.id) ?? null;
      const capability = capabilities.get(key) ?? {
        id: key,
        kind: skill ? ("skill" as const) : ("tool" as const),
        name: skill ? tool.id.slice("skill:".length) : tool.id,
        calls: 0,
        asks: 0,
        missing: false,
        tint: tint(task),
        task,
      };
      capability.calls += tool.calls;
      capability.asks += 1;
      capabilities.set(key, capability);
      links.push({
        ask: topic.id,
        capability: key,
        weight: tool.calls,
        share: total > 0 ? tool.calls / total : 0,
      });
    }
    return {
      id: topic.id,
      label: topic.name,
      volume: topic.turns,
      phrasings: topic.asks,
      firstTry: null,
      rankedByGraph: 0,
      problem: topic.mostlyUnanswered
        ? { kind: "unanswered" as const, rate: 1 - topic.answeredShare }
        : null,
      tint: topic.slot,
    };
  });
  return {
    asks,
    capabilities: [...capabilities.values()].sort(
      (a, b) => b.calls - a.calls || a.id.localeCompare(b.id),
    ),
    links,
    hidden: null,
    tasks: mapTasks(view, [...capabilities.values()], tasks),
  };
}

/**
 * The tasks the drawn tools belong to, busiest first: every task in the
 * reading whose steps hold a drawn tool, and every drawn tool's main task. A
 * task is named and colored as on every other page (`taskNames`, `taskSlots`).
 */
function mapTasks(
  view: Pick<TopicsView, "taskSlots"> & Partial<Pick<TopicsView, "taskNames">>,
  drawn: readonly MapCapability[],
  tasks: readonly MapTaskInput[] | undefined,
): MapTask[] {
  const keys = new Set(drawn.map((capability) => capability.id));
  const known = new Map((tasks ?? []).map((task) => [task.id, task]));
  const ids = new Set<string>();
  for (const task of tasks ?? []) {
    if (task.steps.some((tool) => keys.has(explorerCapabilityKey(tool)))) ids.add(task.id);
  }
  for (const capability of drawn) if (capability.task) ids.add(capability.task);
  return [...ids]
    .map((id): MapTask => {
      const task = known.get(id);
      return {
        id,
        name: view.taskNames?.[id] ?? "Unnamed task",
        slot: view.taskSlots[id] ?? null,
        runs: task?.runs ?? 0,
        steps: (task?.steps ?? []).map(explorerCapabilityKey),
      };
    })
    .sort((a, b) => b.runs - a.runs || byId(a.id, b.id));
}
