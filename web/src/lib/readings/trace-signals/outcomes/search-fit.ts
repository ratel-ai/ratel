import type { StepDraft } from "@/lib/ledger/types";
import {
  type ActionClass,
  actionClassOf,
} from "@/lib/readings/trace-signals/hallucinations/action-class";
import {
  type RunStep,
  SEARCH_RUN_MAX_SEARCHES,
  searchRuns,
} from "@/lib/readings/trace-signals/outcomes/search-runs";

/**
 * Whether a search run that nothing was run after met no fitting tool. Pure.
 *
 * Running nothing is not a missing tool: agents list tools, then run one
 * later, in another turn, or not at all. A run is `unmet` only when the trace
 * shows that none of what it listed fits:
 *   - every search in it returned nothing; or
 *   - each search's words name a kind of action (read, create, change,
 *     remove), no listed tool does that kind, and none of the listed tools
 *     was called later in the session.
 * Anything that cannot be told (the words or the list were not sent, the list
 * was cut, no verb is known) is not unmet. Search scores are not read: a
 * list's scores rank it, they do not say that it fits.
 */

/** What a run's steps alone do not hold. */
export interface SearchContext {
  /** The words of a search, by its event id; absent when they were not sent or are gone. */
  queries: ReadonlyMap<string, string>;
  /** When each tool was last called in the turn's session; null when sessions cannot be told apart. */
  lastCalls: ReadonlyMap<string, Date> | null;
}

/** What the fit of a search is read from in a step. */
export type SearchStep = RunStep &
  Pick<StepDraft, "traceEventId" | "occurredAt" | "hitCount" | "hitIds">;

export const NO_SEARCH_CONTEXT: SearchContext = { queries: new Map(), lastCalls: null };

export interface UnmetSearch {
  /** 1-based ordinal, in the turn, of the run's first search. */
  ordinal: number;
  /** The searches of the run, in order. */
  eventIds: string[];
  /** The last search's words; null when they were not sent. */
  query: string | null;
  /** The kind of action no listed tool does; null when nothing was listed. */
  wanted: ActionClass | null;
  /** Every tool the run listed, each once, in order. */
  offered: string[];
}

/** The kind of action a search's words ask for: their first known verb. */
export const queryClass = (query: string): ActionClass | null =>
  actionClassOf(
    query
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_"),
  );

/**
 * What a search listed, best first; null when it cannot be told in full. An
 * empty list is a search that returned nothing only when its count says 0:
 * OpenTelemetry searches with no hit count arrive as an empty list too.
 */
function listed(step: SearchStep): string[] | null {
  const ids = step.hitIds ?? [];
  if (ids.length === 0) return step.hitCount === 0 ? [] : null;
  return (step.hitCount ?? ids.length) > ids.length ? null : ids;
}

/** The runs of one turn no listed tool fits, from its steps in ordinal order. */
export function unmetSearches(
  steps: readonly SearchStep[],
  context: SearchContext = NO_SEARCH_CONTEXT,
  maxSearches: number = SEARCH_RUN_MAX_SEARCHES,
): UnmetSearch[] {
  return searchRuns(steps, maxSearches)
    .filter((run) => run.kind === "not_run")
    .flatMap((run) => {
      const searches = steps
        .filter((step) => step.kind === "search" && step.ordinal >= run.ordinal)
        .slice(0, run.searches);
      const unmet = unmetRun(searches, context);
      return unmet ? [{ ordinal: run.ordinal, ...unmet }] : [];
    });
}

function unmetRun(
  searches: readonly SearchStep[],
  context: SearchContext,
): Omit<UnmetSearch, "ordinal"> | null {
  const last = searches.at(-1);
  if (!last) return null;
  const lists = searches.map(listed);
  if (lists.some((list) => list === null)) return null;
  const offered = [...new Set(lists.flatMap((list) => list ?? []))];
  const eventIds = searches.map((step) => step.traceEventId);
  const queryOf = (step: SearchStep) => context.queries.get(step.traceEventId)?.trim() || null;
  if (offered.length === 0) return { eventIds, query: queryOf(last), wanted: null, offered };

  const { lastCalls } = context;
  if (lastCalls === null) return null;
  const ranLater = offered.some(
    (tool) => (lastCalls.get(tool)?.getTime() ?? 0) > last.occurredAt.getTime(),
  );
  if (ranLater) return null;
  const does = new Set(offered.map(actionClassOf));
  // A catalog whose names carry no verb cannot be compared.
  if ([...does].every((kind) => kind === null)) return null;
  const wanted = searches.map((step) => {
    const query = queryOf(step);
    return query === null ? null : queryClass(query);
  });
  if (wanted.some((kind) => kind === null || does.has(kind))) return null;
  return { eventIds, query: queryOf(last), wanted: wanted.at(-1) ?? null, offered };
}
