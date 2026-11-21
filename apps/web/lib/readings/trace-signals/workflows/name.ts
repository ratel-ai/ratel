import { agentTaskName } from "@/lib/readings/trace-signals/workflows/agent-tasks";

/**
 * A workflow's display name: the one place the page and the signal copy ask
 * for it. A model-written name (the `label_workflows` job, stored in
 * `trace_workflow_labels`) wins when the caller passes one; otherwise it is
 * made from its tools in typical order ("find_task > assign_task > notify").
 * An agent task's one step (`agent:<name>`, RC-747) reads as its agent's
 * name, made readable ("Draft fix").
 */

export const WORKFLOW_NAME_SEPARATOR = " > ";

/** Tool display names by catalog id, as a map or a lookup function. */
export type ToolNames = ReadonlyMap<string, string> | ((id: string) => string);

function nameOf(id: string, names: ToolNames | undefined): string {
  const named = !names ? undefined : typeof names === "function" ? names(id) : names.get(id);
  return named && named.length > 0 && named !== id ? named : stepFallbackName(id);
}

/** A step's name when no display name is known: an agent's, made readable, else its id. */
export function stepFallbackName(id: string): string {
  return agentTaskName(id) ?? id;
}

/** Model-written names by workflow id. */
export type WorkflowLabels = ReadonlyMap<
  string,
  { readonly name: string; readonly description?: string; readonly icon?: string | null }
>;

export function workflowDisplayName(
  stored: { readonly id?: string; readonly typicalOrder: readonly string[] },
  names?: ToolNames,
  labels?: WorkflowLabels,
): string {
  const labelled = stored.id ? labels?.get(stored.id)?.name : undefined;
  if (labelled) return labelled;
  return stored.typicalOrder.map((id) => nameOf(id, names)).join(WORKFLOW_NAME_SEPARATOR);
}

/** The model-written one-line description, when there is one. */
export function workflowDescription(
  stored: { readonly id?: string },
  labels?: WorkflowLabels,
): string | null {
  const description = stored.id ? labels?.get(stored.id)?.description : undefined;
  return description ? description : null;
}
