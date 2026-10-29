import { sql } from "drizzle-orm";
import { RUNTIME_EVENT_RETENTION_DAYS } from "@/lib/ingest/trace-events/maintenance";
import { getDb } from "@/lib/platform/db/client";
import {
  getIntentGraph,
  type IntentGraphDb,
  putIntentGraph,
} from "@/lib/readings/intent-graph/queries";
import {
  expireIntentGraphClusters,
  intentGraphContentHash,
  intentGraphEtag,
} from "@/lib/readings/intent-types/wire";

export type IntentGraphMaintenanceDb = Pick<ReturnType<typeof getDb>, "execute">;
/** Cloud graphs rewritten per drain by the member expiry; a backlog is worked off across drains. */
const EXPIRE_GRAPH_BATCH_SIZE = 20;

/** Revisions retained per (project, graph_key), newest first. */
export const INTENT_GRAPH_REVISIONS_KEPT = 10;
const PRUNE_BATCH_SIZE = 5_000;

export interface PruneIntentGraphRevisionsOptions {
  kept?: number;
  batchSize?: number;
}

/**
 * Delete one bounded batch of intent graph revisions beyond the newest
 * `kept` per key. The revision the current `intent_graphs` row points at is
 * never removed, even if it is somehow not among the newest. The current row
 * itself is state, not history, and is never touched here.
 */
export async function pruneIntentGraphRevisions(
  options: PruneIntentGraphRevisionsOptions = {},
  db: IntentGraphMaintenanceDb = getDb(),
): Promise<number> {
  const kept = options.kept ?? INTENT_GRAPH_REVISIONS_KEPT;
  const batchSize = options.batchSize ?? PRUNE_BATCH_SIZE;
  const result = await db.execute<{ rev: number }>(sql`
    with ranked as (
      select r.project_id, r.graph_key, r.rev,
             row_number() over (partition by r.project_id, r.graph_key order by r.rev desc) as rn
      from intent_graph_revisions r
    ),
    victims as (
      select ranked.project_id, ranked.graph_key, ranked.rev
      from ranked
      left join intent_graphs g
        on g.project_id = ranked.project_id and g.graph_key = ranked.graph_key
      where ranked.rn > ${kept}
        and (g.rev is null or g.rev <> ranked.rev)
      limit ${batchSize}
    )
    delete from intent_graph_revisions r
    using victims v
    where r.project_id = v.project_id and r.graph_key = v.graph_key and r.rev = v.rev
    returning r.rev
  `);
  return result.rows.length;
}

/** Shadow turns older than this are dropped, in step with the events they replay. */
export const INTENT_GRAPH_SHADOW_RETENTION_DAYS = 30;

/**
 * Trim Cloud's shadow comparison rows past retention. The Boost panel reads a
 * 30-day window, so older rows are never shown; bounded per call like the
 * revision prune so a backlog is worked off across drains.
 */
export async function pruneIntentGraphShadowTurns(
  options: { retentionDays?: number; batchSize?: number; now?: Date } = {},
  db: IntentGraphMaintenanceDb = getDb(),
): Promise<number> {
  const retentionDays = options.retentionDays ?? INTENT_GRAPH_SHADOW_RETENTION_DAYS;
  const batchSize = options.batchSize ?? PRUNE_BATCH_SIZE;
  const cutoff = new Date((options.now ?? new Date()).getTime() - retentionDays * 86_400_000);
  const result = await db.execute<{ search_event_id: string }>(sql`
    with victims as (
      select project_id, graph_key, search_event_id
      from intent_graph_shadow_turns
      where occurred_at < ${cutoff}
      limit ${batchSize}
    )
    delete from intent_graph_shadow_turns t
    using victims v
    where t.project_id = v.project_id and t.graph_key = v.graph_key and t.search_event_id = v.search_event_id
    returning t.search_event_id
  `);
  return result.rows.length;
}

/**
 * Cloud graph members are raw asks, and `trace_events` forgets them after
 * `RUNTIME_EVENT_RETENTION_DAYS`. A Cloud-built graph forgets them on the
 * same clock: each drain rewrites a bounded batch of cloud graphs holding a
 * cluster last observed before the cutoff, with those clusters removed, through
 * `putIntentGraph` so the rev moves and the projection follows. A runtime's own
 * pushed graph is its author's to keep. Returns the number of graphs rewritten.
 */
export async function expireIntentGraphClusterMembers(
  options: { retentionDays?: number; batchSize?: number; now?: Date } = {},
  db: IntentGraphDb = getDb(),
): Promise<{ graphs: number; clusters: number }> {
  const retentionDays = options.retentionDays ?? RUNTIME_EVENT_RETENTION_DAYS;
  const batchSize = options.batchSize ?? EXPIRE_GRAPH_BATCH_SIZE;
  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - retentionDays * 86_400_000;
  const stale = await db.execute<{ project_id: string; graph_key: string }>(sql`
    select project_id, graph_key
    from intent_graphs
    where producer = 'cloud'
      and jsonb_path_exists(document, '$.intents[*] ? (@.last_ts < $cutoff)', jsonb_build_object('cutoff', ${cutoffMs}::bigint))
    order by updated_at asc
    limit ${batchSize}
  `);
  let graphs = 0;
  let clusters = 0;
  for (const row of stale.rows) {
    const current = await getIntentGraph(row.project_id, row.graph_key, db);
    if (!current) continue;
    const { graph, expired } = expireIntentGraphClusters(current.document, cutoffMs);
    if (expired === 0) continue;
    const put = await putIntentGraph(
      {
        projectId: row.project_id,
        sourceId: row.graph_key,
        graph,
        contentHash: intentGraphContentHash(graph),
        byteSize: Buffer.byteLength(JSON.stringify(graph), "utf8"),
        ifMatch: intentGraphEtag(current.contentHash),
        producer: "cloud",
        now,
      },
      db,
    );
    // A fold wrote between the read and this write: it folded from the same
    // document and the next drain sees whatever is still stale.
    if (put.outcome !== "stored") continue;
    graphs += 1;
    clusters += expired;
  }
  return { graphs, clusters };
}
