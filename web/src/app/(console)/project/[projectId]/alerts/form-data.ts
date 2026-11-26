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
import type { FeaturePage } from "../feature-page";

const WEEK_MS = 7 * 86_400_000;

/** What the alert form offers: filter values, the scorer picker (null while scorers are off), destinations and whether Slack is lost. */
export async function loadAlertForm(page: FeaturePage) {
  const { projectId } = page;
  const features = await metricFeatures(page);
  const [facets, scorers, destinations, slack] = await Promise.all([
    loadOrFallback({
      operation: "alert_facets",
      distinctId: `project:${projectId}`,
      fallback: EMPTY_TRACE_FILTER_FACETS,
      load: () =>
        withStatementTimeout(
          (db) =>
            getTraceFilterFacets(
              projectId,
              { since: new Date(Date.now() - WEEK_MS) },
              db,
              undefined,
              { entities: true },
            ),
          { operation: "alert_facets", timeoutMs: supplementaryReadTimeoutMs() },
        ),
    }),
    features.customMonitoring ? loadScorerPicker(projectId) : null,
    listDestinations(projectId),
    getSlackConnection(page.organizationId),
  ]);
  return {
    features,
    scorers,
    form: {
      facets,
      rql: features.rql === true,
      destinations,
      slackLost:
        (slack === null || slack.lost) && destinations.some(({ kind }) => kind === "slack_channel"),
    },
  };
}
