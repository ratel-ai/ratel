/**
 * A workflow's display name: the one place the page and the signal copy ask
 * for it. A model-written name (the `label_workflows` job, stored in
 * `trace_workflow_labels`) wins when the caller passes one; otherwise it is
 * made from its tools in typical order ("find_task > assign_task > notify").
 */

export const WORKFLOW_NAME_SEPARATOR = " > ";

/** Tool display names by catalog id, as a map or a lookup function. */
export type ToolNames = ReadonlyMap<string, string> | ((id: string) => string);

function nameOf(id: string, names: ToolNames | undefined): string {
  if (!names) return id;
  const named = typeof names === "function" ? names(id) : names.get(id);
  return named && named.length > 0 ? named : id;
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
