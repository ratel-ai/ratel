import { and, asc, eq, inArray } from "drizzle-orm";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import type { ActionClass } from "@/lib/readings/trace-signals/hallucinations/action-class";
import { loadLastCalls } from "@/lib/readings/trace-signals/outcomes/run-queries";
import { type UnmetSearch, unmetSearches } from "@/lib/readings/trace-signals/outcomes/search-fit";
import { loadSearchQueries } from "@/lib/readings/trace-signals/outcomes/text-queries";
import type { SentimentPageModel } from "@/lib/views/traces/sentiment/page-model";

/**
 * What happened in a turn no tool fitted: what the agent searched for, what it
 * was offered and what was missing from that, read on demand for the examples
 * of Root cause analysis. Nothing here is stored.
 */
export interface UnmetSearchView {
  /** The agent's words; null when the project does not send them. */
  query: string | null;
  /** The tools it was offered, best first, at most {@link MAX_OFFERED}. */
  offered: string[];
  /** How many more it was offered. */
  more: number;
  /** What none of them does, as a sentence part. */
  missing: string;
}

const MAX_OFFERED = 5;

type UnmetDb = Pick<ReturnType<typeof getDb>, "select">;

const NONE: Record<ActionClass, string> = {
  read: "none of them looks anything up",
  create: "none of them creates anything",
  change: "none of them changes anything",
  remove: "none of them deletes anything",
};
const ONE: Record<ActionClass, string> = {
  read: "it does not look anything up",
  create: "it does not create anything",
  change: "it does not change anything",
  remove: "it does not delete anything",
};

export function unmetSearchView(search: UnmetSearch): UnmetSearchView {
  const { offered, wanted } = search;
  return {
    query: search.query,
    offered: offered.slice(0, MAX_OFFERED),
    more: Math.max(0, offered.length - MAX_OFFERED),
    missing:
      wanted === null
        ? "the search returned no tool"
        : offered.length === 1
          ? ONE[wanted]
          : NONE[wanted],
  };
}

/** The last search no listed tool fits of each of these turns, by turn id. */
export async function loadUnmetSearches(
  projectId: string,
  turnIds: readonly string[],
  db: UnmetDb = getDb(),
): Promise<Map<string, UnmetSearchView>> {
  if (turnIds.length === 0) return new Map();
  const rows = await db
    .select({
      turnId: traceTurnSteps.turnId,
      sessionId: traceTurns.sessionId,
      ordinal: traceTurnSteps.ordinal,
      kind: traceTurnSteps.kind,
      targetType: traceTurnSteps.targetType,
      targetId: traceTurnSteps.targetId,
      traceEventId: traceTurnSteps.traceEventId,
      occurredAt: traceTurnSteps.occurredAt,
      hitCount: traceTurnSteps.hitCount,
      hitIds: traceTurnSteps.hitIds,
    })
    .from(traceTurnSteps)
    .innerJoin(traceTurns, eq(traceTurns.id, traceTurnSteps.turnId))
    .where(
      and(eq(traceTurnSteps.projectId, projectId), inArray(traceTurnSteps.turnId, [...turnIds])),
    )
    .orderBy(asc(traceTurnSteps.ordinal));
  const searches = rows.filter((row) => row.kind === "search").map((row) => row.traceEventId);
  const [queries, calls] = await Promise.all([
    loadSearchQueries(projectId, searches, db),
    loadLastCalls(projectId, [...new Set(rows.map((row) => row.sessionId))], db),
  ]);
  const out = new Map<string, UnmetSearchView>();
  for (const turnId of new Set(turnIds)) {
    const steps = rows.filter((row) => row.turnId === turnId);
    const session = steps[0]?.sessionId;
    if (session === undefined) continue;
    const search = unmetSearches(steps as Parameters<typeof unmetSearches>[0], {
      queries,
      lastCalls: calls.get(session) ?? new Map(),
    }).at(-1);
    if (search) out.set(turnId, unmetSearchView(search));
  }
  return out;
}

/** The page with what was searched on the examples of "No fitting tool"; without it when it cannot be read. */
export async function withUnmetSearches(
  model: SentimentPageModel,
  load: (turnIds: string[]) => Promise<ReadonlyMap<string, UnmetSearchView>>,
): Promise<SentimentPageModel> {
  const turnIds = model.overview.groups.flatMap((group) =>
    group.rows.flatMap((row) =>
      row.cause === "missing_capability" ? row.examples.map((example) => example.turnId) : [],
    ),
  );
  if (turnIds.length === 0) return model;
  const searches = await load([...new Set(turnIds)]);
  return {
    ...model,
    overview: {
      ...model.overview,
      groups: model.overview.groups.map((group) => ({
        ...group,
        rows: group.rows.map((row) =>
          row.cause !== "missing_capability"
            ? row
            : {
                ...row,
                examples: row.examples.map((example) => ({
                  ...example,
                  search: searches.get(example.turnId) ?? null,
                })),
              },
        ),
      })),
    },
  };
}
