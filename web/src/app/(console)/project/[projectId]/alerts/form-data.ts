import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  EMPTY_TRACE_FILTER_FACETS,
  getTraceFilterFacets,
} from "@/lib/synthesis/traces/trace-filters";
import { listDestinations } from "@/lib/views/alerts/destinations";
import { loadScorerPicker } from "@/lib/views/scorers/picker";
import { getSlackConnection } from "@/lib/views/slack/store";
import { metricFeatures } from "../dashboards/context";
import { loadFormCompletionUsage, loadFormProperties } from "../dashboards/property-data";
import type { FeaturePage } from "../feature-page";

const WEEK_MS = 7 * 86_400_000;

/**
 * What the alert form offers: filter values, the scorer picker (null while scorers are off),
 * destinations, whether Slack is lost, and the trace properties with their values of the last week.
 */
export async function loadAlertForm(page: FeaturePage) {
  const { projectId } = page;
  const features = await metricFeatures(page);
  const since = new Date(Date.now() - WEEK_MS);
  // Not awaited: the page streams it to the RQL field, which keeps its start order until then.
  const usage = loadFormCompletionUsage(projectId, features.customMonitoring);
  const [facets, scorers, destinations, slack, properties] = await Promise.all([
    loadOrFallback({
      operation: "alert_facets",
      distinctId: `project:${projectId}`,
      fallback: EMPTY_TRACE_FILTER_FACETS,
      load: () =>
        withStatementTimeout(
          (db) => getTraceFilterFacets(projectId, { since }, db, undefined, { entities: true }),
          { operation: "alert_facets", timeoutMs: supplementaryReadTimeoutMs() },
        ),
    }),
    features.customMonitoring ? loadScorerPicker(projectId) : null,
    listDestinations(projectId),
    getSlackConnection(page.organizationId),
    loadFormProperties(projectId, { since }, features.customMonitoring),
  ]);
  return {
    features,
    scorers,
    properties,
    usage,
    form: {
      facets,
      destinations,
      slackLost:
        (slack === null || slack.lost) && destinations.some(({ kind }) => kind === "slack_channel"),
    },
  };
}
