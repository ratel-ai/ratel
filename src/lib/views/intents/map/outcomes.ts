import type { ClusterOf } from "@/lib/views/intents/map/classify";
import type { AskOutcome } from "@/lib/views/intents/map/map-model";

/** One search from the window: what it served first, and what its agent ran next. */
export interface OutcomeSearch {
  query: string;
  /** The tool the agent ran after this search. */
  invokedToolId: string;
  /** The first tool this search served; null when it served none. */
  firstToolId: string | null;
  /** A Cloud graph was ranking this search's list: the agent picked from our own ordering. */
  shaped: boolean;
}

export interface ScoredOutcomes {
  outcomes: AskOutcome[];
  /** Searches attributed before the time budget ran out; all of them unless it did. */
  classified: number;
}

/**
 * Per ask group, scored per search: was the first result a search served the
 * tool its own agent ran next? Never "the group's top tool", so a group that
 * two tools answer evenly reads 100% when each search put its own tool first.
 *
 * A search whose list a Cloud graph ranked is counted apart (`shaped`) and not
 * scored: an agent choosing from our own ordering says little about the
 * ordering (the Quality page's tier rule). A search that served nothing has no
 * first result and is skipped. Every search in `searches` is attributed with
 * `clusterOf`, so a group's count is all of its searches, not only those
 * worded like its stored phrasings. Only groups in `keep` are returned.
 */
export function scoreAskOutcomes(
  searches: readonly OutcomeSearch[],
  clusterOf: ClusterOf,
  options: { keep?: ReadonlySet<string>; deadline?: number; clock?: () => number } = {},
): ScoredOutcomes {
  const clock = options.clock ?? (() => performance.now());
  const byCluster = new Map<string, AskOutcome>();
  let classified = 0;
  for (const search of searches) {
    if (options.deadline !== undefined && classified % 64 === 0 && clock() > options.deadline)
      break;
    classified += 1;
    const clusterId = clusterOf(search.query);
    if (clusterId === null || (options.keep && !options.keep.has(clusterId))) continue;
    const outcome = byCluster.get(clusterId) ?? { clusterId, ranked: 0, firstTry: 0, shaped: 0 };
    if (search.shaped) outcome.shaped += 1;
    else if (search.firstToolId !== null) {
      outcome.ranked += 1;
      if (search.firstToolId === search.invokedToolId) outcome.firstTry += 1;
    }
    byCluster.set(clusterId, outcome);
  }
  return {
    outcomes: [...byCluster.values()].sort((a, b) =>
      a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0,
    ),
    classified,
  };
}
