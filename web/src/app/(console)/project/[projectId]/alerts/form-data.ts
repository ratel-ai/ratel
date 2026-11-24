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
import { hasVerdict } from "@/lib/views/scorers/format";
import { listScorers } from "@/lib/views/scorers/store";
import { metricFeatures } from "../dashboards/context";
import type { FeaturePage } from "../feature-page";

const WEEK_MS = 7 * 86_400_000;

/** What the alert form offers: filter values, scorers (null while they are off) and destinations. */
export async function loadAlertForm(page: FeaturePage) {
  const { projectId } = page;
  const features = await metricFeatures(page);
  const [facets, scorers, destinations] = await Promise.all([
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
    features.scorers ? listScorers(projectId) : null,
    listDestinations(projectId),
  ]);
  return {
    features,
    form: {
      facets,
      destinations,
      scorers:
        scorers?.map((scorer) => ({
          id: scorer.id,
          name: scorer.name,
          verdict: hasVerdict(scorer),
        })) ?? null,
    },
  };
}
