import type { TaskColorSlot } from "@ratel/design-system/task-colors";
import { flowTaskId, flowToolId } from "@/lib/readings/topics/types";

/** The names and task colors Flows draws by, keyed as the flows are: intent ids and `task:<id>`. */
export type FlowTopics = Record<string, { name: string; slot: TaskColorSlot | null }>;

/** A step's name: its intent or task, or the tool it called. */
export function startLabel(key: string, topics: FlowTopics): string {
  return (
    topics[key]?.name ?? flowToolId(key) ?? (flowTaskId(key) !== null ? "A task" : "An intent")
  );
}
