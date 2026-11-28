import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  EMPTY_TRACE_FILTER_FACETS,
  getTraceFilterFacets,
} from "@/lib/synthesis/traces/trace-filters";
import {
  loadScorerPicker,
  type ScorerPickerData,
  UNREAD_SCORERS,
} from "@/lib/views/scorers/picker";
import { loadTaskOptions } from "../scorers/tasks";
import { loadFormCompletionUsage, loadFormProperties } from "./property-data";

/**
 * What the widget fields offer: the filter values of the range (with the project's tasks by name,
 * RTL-397), the scorer picker, and the trace properties with their values, and what the RQL field
 * orders its list by.
 */
export async function loadWidgetForm(projectId: string, range: { since: Date; until?: Date }) {
  const distinctId = `project:${projectId}`;
  // Not awaited: the page streams it to the RQL field, which keeps its start order until then.
  const usage = loadFormCompletionUsage(projectId);
  const [facets, scorers, properties, tasks] = await Promise.all([
    loadOrFallback({
      operation: "dashboard_facets",
      distinctId,
      fallback: EMPTY_TRACE_FILTER_FACETS,
      load: () =>
        withStatementTimeout(
          (db) => getTraceFilterFacets(projectId, range, db, undefined, { entities: true }),
          { operation: "dashboard_facets", timeoutMs: supplementaryReadTimeoutMs() },
        ),
    }),
    loadOrFallback<ScorerPickerData>({
      operation: "dashboard_scorers",
      distinctId,
      // A failed read says so, not an empty project.
      fallback: UNREAD_SCORERS,
      load: () => loadScorerPicker(projectId),
    }),
    loadFormProperties(projectId, range),
    loadOrFallback({
      operation: "dashboard_tasks",
      distinctId,
      fallback: [],
      load: () => loadTaskOptions(projectId),
    }),
  ]);
  const task = tasks.map(({ id, name }) => ({ value: id, label: name, count: 0 }));
  return {
    facets: task.length > 0 ? { ...facets, task } : facets,
    scorers,
    properties,
    usage,
    taskNames: Object.fromEntries(tasks.map(({ id, name }) => [id, name])),
  };
}
