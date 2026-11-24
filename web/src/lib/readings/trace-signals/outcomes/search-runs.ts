import { getConfig } from "@/config";
import type { StepDraft } from "@/lib/ledger/types";
import { nodeIdOf } from "@/lib/readings/tool-explorer/units";

/**
 * Search runs of one turn: consecutive searches with no call between them.
 * Pure.
 *
 * A run with a call after it found something to run. A run that ends the turn
 * had nothing run for it there (`not_run`), which is not a missing tool by
 * itself: `search-fit.ts` says when it is. A run longer than
 * {@link SEARCH_RUN_MAX_SEARCHES} is the agent listing the catalog, query
 * after query, not one need: it is a `catalog_listing` whether or not a call
 * follows, and is never read as a need.
 */

/**
 * The longest search run that is still one need. Env
 * `TRACE_OUTCOMES_SEARCH_RUN_MAX`, default 5: on a real project's replay every run
 * but two is 1 to 5 searches, and those two are 21 and 22.
 */
export const SEARCH_RUN_MAX_SEARCHES = getConfig().traceOutcomes.searchRunMax;

export type SearchRunKind = "answered" | "not_run" | "catalog_listing";

export interface SearchRun {
  /** 1-based ordinal, in the turn, of the run's first search. */
  ordinal: number;
  searches: number;
  kind: SearchRunKind;
}

/** What a run is read from in a step. */
export type RunStep = Pick<StepDraft, "ordinal" | "kind" | "targetType" | "targetId">;

/** The search runs of one turn, from its steps in ordinal order. */
export function searchRuns(
  steps: readonly RunStep[],
  maxSearches: number = SEARCH_RUN_MAX_SEARCHES,
): SearchRun[] {
  const runs: SearchRun[] = [];
  const kindOf = (searches: number, callAfter: boolean): SearchRunKind =>
    searches > maxSearches ? "catalog_listing" : callAfter ? "answered" : "not_run";
  // The run being read: its first search's ordinal and its length so far; zero when none is open.
  let ordinal = 0;
  let searches = 0;
  for (const step of steps) {
    if (step.kind === "search") {
      if (searches === 0) ordinal = step.ordinal;
      searches += 1;
    } else if (nodeIdOf(step) !== null && searches > 0) {
      runs.push({ ordinal, searches, kind: kindOf(searches, true) });
      searches = 0;
    }
  }
  if (searches > 0) runs.push({ ordinal, searches, kind: kindOf(searches, false) });
  return runs;
}
