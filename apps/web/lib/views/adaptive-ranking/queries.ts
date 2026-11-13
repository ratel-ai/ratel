import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { RUNTIME_EVENT_RETENTION_DAYS } from "@/lib/ingest/trace-events/maintenance";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import type { IntentGraphDb } from "@/lib/readings/intent-graph/queries";
import { intentGraphShadowTurns } from "@/lib/readings/intent-graph/schema";
import { cloudGraphSource } from "@/lib/readings/intent-types/wire";
import type { EvaluableSelection } from "@/lib/synthesis/quality/ground-truth";
import {
  loadEvaluableSelections,
  loadServedOnlySelections,
  MAX_SELECTIONS,
  type QualityQueriesDb,
  type QualitySelections,
} from "@/lib/synthesis/quality/queries";
import { boostExperimentName } from "./boost-view";

/**
 * The Boost reads Adaptive ranking compares a graph with: what a runtime reported, or the fold's
 * shadow turns, and the outcomes around the moment a graph went live. They read the quality
 * selections, so they sit above the graph's own queries. Owned (ADR-0030): cut from upstream's
 * `intent-graph/queries.ts`.
 */

/** `otel_logs` keeps 30 days, so that is the widest window a boost read can see. */
export const BOOST_WINDOW_DAYS = 30;

/** A shadow turn as a selection, saying whether the runtime or Cloud produced its two lists. */
export interface ShadowSelection extends EvaluableSelection {
  reported: boolean;
}

/**
 * Cloud's shadow turns as the two-arm selections the Boost panel scores:
 * `baseline` is the plain ranking, `adaptive` the one with the graph. The arm
 * that served is `adaptive` on turns folded while the graph was live, so the
 * online boundary falls where the graph went live. Only turns with an invoked
 * tool are returned: a search the agent did not act on has nothing to score.
 */
export async function loadShadowSelections(
  projectId: string,
  graphKey: string,
  since: Date,
  db: IntentGraphDb = getDb(),
  limit: number = MAX_SELECTIONS,
): Promise<ShadowSelection[]> {
  const rows = await db
    .select({
      searchEventId: intentGraphShadowTurns.searchEventId,
      occurredAt: intentGraphShadowTurns.occurredAt,
      plainIds: intentGraphShadowTurns.plainIds,
      boostedIds: intentGraphShadowTurns.boostedIds,
      live: intentGraphShadowTurns.live,
      reported: intentGraphShadowTurns.reported,
      invokedToolId: intentGraphShadowTurns.invokedToolId,
      // The search itself, for the examples beside a tool: gone once the event ages out.
      query: traceEvents.query,
    })
    .from(intentGraphShadowTurns)
    .leftJoin(traceEvents, eq(traceEvents.id, intentGraphShadowTurns.searchEventId))
    .where(
      and(
        eq(intentGraphShadowTurns.projectId, projectId),
        eq(intentGraphShadowTurns.graphKey, graphKey),
        gte(intentGraphShadowTurns.occurredAt, since),
        isNotNull(intentGraphShadowTurns.invokedToolId),
      ),
    )
    .orderBy(desc(intentGraphShadowTurns.occurredAt), desc(intentGraphShadowTurns.searchEventId))
    .limit(limit);
  return rows.reverse().map((row) => ({
    selectionId: row.searchEventId,
    occurredAt: row.occurredAt,
    query: row.query ?? null,
    arms: [
      {
        arm: "baseline",
        role: row.live ? ("shadow" as const) : ("serving" as const),
        resultIds: row.plainIds,
      },
      {
        arm: "adaptive",
        role: row.live ? ("serving" as const) : ("shadow" as const),
        resultIds: row.boostedIds,
      },
    ],
    invokedToolId: row.invokedToolId,
    invokedRank: null,
    reported: row.reported,
  }));
}

export interface BoostSelections extends QualitySelections {
  /** True when some selection is Cloud's own lexical replay rather than what a runtime reported. */
  estimated: boolean;
  /** How many selections carry the runtime's own two rankings (`base_hits` on the search). */
  reportedCount: number;
}

/**
 * The selections a graph's Boost panel scores, oldest first. What a runtime
 * reported for the experiment `adaptive-ranking:<graph key>` wins when there is
 * any: both arms' real rankings and the invoked tool. Otherwise the shadow
 * turns: the runtime's own two rankings where the search carried `base_hits`,
 * Cloud's replay elsewhere, the latter marked as an estimate.
 */
export async function loadBoostSelections(
  projectId: string,
  graphKey: string,
  now: Date = new Date(),
  db: QualityQueriesDb & IntentGraphDb = getDb(),
): Promise<BoostSelections> {
  const name = boostExperimentName(graphKey);
  const window = {
    since: new Date(now.getTime() - BOOST_WINDOW_DAYS * 24 * 60 * 60 * 1000),
    until: new Date(now.getTime() + 60 * 1000),
  };
  // Offline turns ran the reference arm alone, so they never produced a
  // comparison; they still count, scored on the reference, once merged in
  // stored order with the shadow-tested ones.
  const [compared, servedOnly] = await Promise.all([
    loadEvaluableSelections(projectId, name, window, db),
    loadServedOnlySelections(projectId, name, window, db),
  ]);
  if (compared.selections.length > 0 || servedOnly.length > 0) {
    if (servedOnly.length === 0)
      return { ...compared, estimated: false, reportedCount: compared.selections.length };
    const selections = [...compared.selections, ...servedOnly].sort(
      (a, b) =>
        a.occurredAt.getTime() - b.occurredAt.getTime() ||
        a.selectionId.localeCompare(b.selectionId),
    );
    return {
      selections,
      diagnostics: { ...compared.diagnostics, selectionCount: selections.length },
      estimated: false,
      reportedCount: compared.selections.length,
    };
  }
  const shadow = await loadShadowSelections(projectId, graphKey, window.since, db);
  const reportedCount = shadow.filter((turn) => turn.reported).length;
  return {
    selections: shadow,
    diagnostics: {
      ...compared.diagnostics,
      selectionCount: shadow.length,
      invocationCount: shadow.length,
      rankedSelectionCount: shadow.length,
    },
    estimated: shadow.length > reportedCount,
    reportedCount,
  };
}

/** One stretch of a runtime's traffic, read from what it served and what the agent then called. */
export interface RuntimeOutcomes {
  /** Turns with a search and a turn id. */
  turns: number;
  /**
   * Tool calls whose tool was in the first five results of the search before
   * it in the same turn; null without any.
   */
  recallAt5: number | null;
}

/**
 * The same runtime traffic before and after a graph went live: was the tool
 * the agent used in the list it was served. Read from the events the runtime
 * already sends. For a per-source graph only that source counts; for the
 * merged graph, every one. It is a before-and-after, not an experiment: other
 * things may have changed.
 */
export async function loadOutcomesAroundLive(
  projectId: string,
  graphKey: string,
  liveAt: Date,
  days: number = 14,
  db: IntentGraphDb = getDb(),
  now: Date = new Date(),
): Promise<{ before: RuntimeOutcomes; after: RuntimeOutcomes }> {
  const sourceId = cloudGraphSource(graphKey);
  const from = new Date(liveAt.getTime() - days * 86_400_000);
  const until = new Date(Math.min(now.getTime(), liveAt.getTime() + days * 86_400_000));
  const sourceFilter = sourceId === null ? sql`true` : sql`e.source_id = ${sourceId}`;
  const rows = await db.execute<{
    after: boolean;
    turns: number;
    confirmed: number;
    at5: number;
  }>(sql`
    with events as (
      select e.id, e.type, e.session_id, e.tool_id,
             coalesce(e.turn_id, e.payload ->> 'turn_id') as turn,
             coalesce(e.occurred_at, e.received_at) as at,
             coalesce(e.occurred_at, e.received_at) >= ${liveAt} as after
      from trace_events e
      where e.project_id = ${projectId}
        and e.ingest_source = 'runtime'
        and e.type in ('search', 'invoke_start')
        and e.received_at >= ${from} and e.received_at < ${until}
        and ${sourceFilter}
    ),
    turns as (
      select session_id, turn, bool_or(after) as after
      from events
      where turn is not null and type = 'search'
      group by session_id, turn
    ),
    -- Each row's search is the latest search at or before it in its turn.
    -- Searches are numbered within the turn in time order (searches first
    -- within one instant), every row carries the number of the latest search
    -- so far, and an invoke joins its search on that number: one sort and a
    -- hash join, linear in the window. A lateral self-join over the
    -- materialized CTE was invokes x events and took seconds at a few
    -- thousand turns.
    numbered as (
      select e.id, e.type, e.session_id, e.turn, e.tool_id, e.after,
             count(*) filter (where e.type = 'search')
               over (partition by e.session_id, e.turn
                     order by e.at, case when e.type = 'search' then 0 else 1 end, e.id
                     rows between unbounded preceding and current row) as search_no
      from events e
      where e.turn is not null
    ),
    confirmed as (
      select i.after,
             (select min(h.rank)
                from trace_event_hits h
               where h.trace_event_id = s.id and h.target_type = 'tool' and h.target_id = i.tool_id) as rank
      from numbered i
      join numbered s
        on s.session_id = i.session_id and s.turn = i.turn and s.search_no = i.search_no and s.type = 'search'
      where i.type = 'invoke_start' and i.tool_id is not null
        and exists (select 1 from trace_event_hits h where h.trace_event_id = s.id and h.target_type = 'tool')
    )
    select p.after,
           (select count(*) from turns t where t.after = p.after)::int as turns,
           (select count(*) from confirmed c where c.after = p.after)::int as confirmed,
           (select count(*) from confirmed c where c.after = p.after and c.rank < 5)::int as at5
    from (values (false), (true)) as p(after)
  `);
  const of = (after: boolean): RuntimeOutcomes => {
    const r = rows.rows.find((row) => row.after === after);
    const confirmed = Number(r?.confirmed ?? 0);
    return {
      turns: Number(r?.turns ?? 0),
      recallAt5: confirmed === 0 ? null : Number(r?.at5 ?? 0) / confirmed,
    };
  };
  return { before: of(false), after: of(true) };
}

/**
 * A boost is credited to the graph its source was ranking from at the time,
 * not to the source's current graph: `usage_boost` names no graph, so a boost
 * from before the source moved onto its current graph belonged to the graph
 * it was on then. The bound is the source's first status report naming the
 * current graph after its last report naming a different one, read from the
 * status events the source sent; null when it never named another graph.
 * Keeps a runtime that moved from graph A to B from moving B's online start
 * back before the switch.
 */
const boostEventTime = sql`coalesce(e.occurred_at, e.received_at)`;
const switchedToCurrentGraph = sql`
  select s.source_id, s.graph_key,
         (select min(coalesce(c.occurred_at, c.received_at))
            from trace_events c
           where c.project_id = s.project_id
             and c.source_id = s.source_id
             and c.type = 'usage_ranking_status'
             and c.payload ->> 'graph_key' = s.graph_key
             and coalesce(c.occurred_at, c.received_at) > o.last_other) as switched_at
    from intent_graph_runtime_status s
    cross join lateral (
      select max(coalesce(r.occurred_at, r.received_at)) as last_other
        from trace_events r
       where r.project_id = s.project_id
         and r.source_id = s.source_id
         and r.type = 'usage_ranking_status'
         and r.payload ->> 'graph_key' is not null
         and r.payload ->> 'graph_key' <> s.graph_key
    ) o`;

/**
 * Graph keys some runtime boosted from since `since`: a `usage_boost` from a
 * source while it was ranking from that key. What separates a live graph
 * nobody uses from one that is changing results. Bounded to `since` on the
 * (project, type, time) index.
 */
export async function listBoostingGraphKeysSince(
  projectId: string,
  since: Date,
  db: IntentGraphDb = getDb(),
): Promise<Set<string>> {
  const rows = await db.execute<{ graph_key: string }>(sql`
    with current as (${switchedToCurrentGraph} where s.project_id = ${projectId} and s.graph_key is not null)
    select distinct c.graph_key
    from trace_events e
    join current c on c.source_id = e.source_id
    where e.project_id = ${projectId}
      and e.type = 'usage_boost'
      and ${boostEventTime} >= ${since}
      and (c.switched_at is null or ${boostEventTime} >= c.switched_at)
      -- A boost event with no matched query group changed nothing: the runtime
      -- emits one per search even on an empty graph.
      and e.payload ->> 'intent' is not null
  `);
  return new Set(rows.rows.map((r) => r.graph_key));
}

/**
 * When runtimes started boosting from a stored graph: the earliest
 * `usage_boost` from a source while it was ranking from this graph key. Null
 * until a runtime has both reported and boosted. For the cloud graph this is
 * the start of the online period. Bounded to event retention: an older boost
 * has no events left to show for it anyway.
 */
export async function firstBoostFromGraphAt(
  projectId: string,
  graphKey: string,
  db: IntentGraphDb = getDb(),
  now: Date = new Date(),
): Promise<Date | null> {
  const windowStart = new Date(now.getTime() - RUNTIME_EVENT_RETENTION_DAYS * 86_400_000);
  const rows = await db.execute<{ at: string | Date | null }>(sql`
    with current as (${switchedToCurrentGraph} where s.project_id = ${projectId} and s.graph_key = ${graphKey})
    select min(${boostEventTime}) as at
    from trace_events e
    join current c on c.source_id = e.source_id
    where e.project_id = ${projectId}
      and e.type = 'usage_boost'
      and ${boostEventTime} >= greatest(${windowStart}, coalesce(c.switched_at, ${windowStart}))
      -- A boost event with no matched query group changed nothing: the runtime
      -- emits one per search even on an empty graph.
      and e.payload ->> 'intent' is not null
  `);
  const at = rows.rows[0]?.at ?? null;
  if (at === null) return null;
  return at instanceof Date ? at : new Date(at);
}
