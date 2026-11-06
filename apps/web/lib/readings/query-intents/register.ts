import type { Registration } from "@/lib/contracts/registry";
import { createBackgroundObservability } from "@/lib/jobs/observability";
import { getLogger } from "@/lib/platform/logger";
import { bm25ClustererFromEnv } from "./bm25-clusterer";
import { categorizeProjectQueries, type QueryIntentsDeps } from "./pipeline";
import {
  advanceQueryIntentsWatermark,
  enqueueDueQueryCategorizations,
  getQueryIntentsByNormalizedTexts,
  getQueryIntentsWatermark,
  listNewSearchQueryEvents,
  listQueryIntentsForMatching,
  QUERY_INTENT_MATCH_LIMIT_BM25,
  recordQueryIntentOccurrences,
} from "./queries";

const logger = getLogger("query-intents/register");

/**
 * The injected query-intents collaborators. Clustering is the symmetric-BM25 clusterer
 * over each cluster's accumulated member phrases: deterministic, offline, no model.
 */
function queryIntentsDeps(projectId: string): QueryIntentsDeps {
  const clustering: Pick<QueryIntentsDeps, "listExistingCanonicals" | "clusterer"> = {
    listExistingCanonicals: async (p) => {
      const rows = await listQueryIntentsForMatching(p, undefined, {
        limit: QUERY_INTENT_MATCH_LIMIT_BM25,
      });
      if (rows.length === QUERY_INTENT_MATCH_LIMIT_BM25) {
        logger.warn(
          { limit: QUERY_INTENT_MATCH_LIMIT_BM25, project_id: p },
          "clustering seeds truncated",
        );
      }
      return rows;
    },
    clusterer: bm25ClustererFromEnv({
      onSummary: (summary) => {
        logger.info(
          { project_id: projectId, clusterer: "bm25", ...summary },
          "query intents clustered",
        );
        void createBackgroundObservability().trackProjectEvent(
          "query_intents_clustered",
          projectId,
          {
            clusterer: "bm25",
            ...summary,
          },
        );
      },
    }),
  };
  return {
    getWatermark: getQueryIntentsWatermark,
    listNewSearchEvents: listNewSearchQueryEvents,
    lookupExactCanonicals: getQueryIntentsByNormalizedTexts,
    ...clustering,
    recordOccurrences: recordQueryIntentOccurrences,
    advanceWatermark: advanceQueryIntentsWatermark,
  };
}

/**
 * The recurring-asks ledger's registration: the `categorize_queries` job (a project's new
 * searches folded into `query_intents`) and the drain's count-based enqueue of it. The
 * step reports under upstream's heartbeat key.
 */
export const queryIntentsRegistration: Registration = {
  jobs: {
    categorize_queries: (job) =>
      categorizeProjectQueries(job.projectId, queryIntentsDeps(job.projectId)),
  },
  drainSteps: [
    {
      name: "query_categorizations_enqueue",
      phase: "before",
      run: async () => ({ enqueued: (await enqueueDueQueryCategorizations()).enqueued }),
    },
  ],
};
