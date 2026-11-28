import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import type { MetricFeatures } from "@/lib/synthesis/metrics/catalog";
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
import { loadFormProperties } from "./property-data";

/**
 * What the widget fields offer: the filter values of the range (with the project's tasks by name,
 * RTL-397, while custom monitoring is on), the scorer picker (null while scorers are off), and the
 * trace properties with their values.
 */
export async function loadWidgetForm(
  projectId: string,
  range: { since: Date; until?: Date },
  features: MetricFeatures,
) {
  const distinctId = `project:${projectId}`;
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
    features.customMonitoring
      ? loadOrFallback<ScorerPickerData>({
          operation: "dashboard_scorers",
          distinctId,
          // A failed read says so, not scorers off and not an empty project.
          fallback: UNREAD_SCORERS,
          load: () => loadScorerPicker(projectId),
        })
      : null,
    loadFormProperties(projectId, range, features.customMonitoring),
    features.customMonitoring
      ? loadOrFallback({
          operation: "dashboard_tasks",
          distinctId,
          fallback: [],
          load: () => loadTaskOptions(projectId),
        })
      : [],
  ]);
  const task = tasks.map(({ id, name }) => ({ value: id, label: name, count: 0 }));
  return {
    facets: task.length > 0 ? { ...facets, task } : facets,
    scorers,
    properties,
    taskNames: Object.fromEntries(tasks.map(({ id, name }) => [id, name])),
  };
}
