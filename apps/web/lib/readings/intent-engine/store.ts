import { and, desc, eq, gt, inArray, like, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { boundCluster } from "@/lib/readings/intent-engine/bounds";
import type { PriorNode } from "@/lib/readings/intent-engine/levels";
import {
  type IntentClusterRow,
  intentClusterAssignments,
  intentClusters,
  intentEngineState,
} from "@/lib/readings/intent-engine/schema";
import { intentGraphs } from "@/lib/readings/intent-graph/schema";
import type {
  EngineAssignment,
  EngineCluster,
  EngineMerge,
  LevelTree,
} from "@/lib/readings/intent-types/engine-types";
import {
  CLOUD_INTENT_GRAPH_KEY,
  CLOUD_SOURCE_GRAPH_PREFIX,
  type IntentGraphDocument,
} from "@/lib/readings/intent-types/wire";
import { queryIntents } from "@/lib/readings/query-intents/schema";

/**
 * The intent engine's reads and writes. Every write is scoped by project and
 * runs inside the caller's transaction, which holds the engine's advisory lock.
 *
 * Bounded: a run reads at most {@link CLUSTER_LOAD_LIMIT} level-0 clusters,
 * the most recently active, on `intent_clusters_project_level_last_idx`; a
 * cluster past that is cold and takes no new asks until it is active again.
 * Level writes are diffs: a node or a parent pointer is written only when it
 * changed.
 */

export type EngineDb = Pick<
  ReturnType<typeof getDb>,
  "execute" | "select" | "selectDistinct" | "insert" | "delete" | "update" | "transaction"
>;

/** Rows per insert statement, well under Postgres's bind cap. */
const WRITE_CHUNK = 500;
/** Any one statement of an engine transaction, at most. */
export const ENGINE_STATEMENT_TIMEOUT_MS = 60_000;
/** Any one lock wait of an engine transaction, at most. */
export const ENGINE_LOCK_TIMEOUT_MS = 30_000;

/** Bound the rest of an engine transaction: no runaway statement or lock wait while it holds the project's lock. */
export async function boundEngineTransaction(tx: Pick<EngineDb, "execute">): Promise<void> {
  await tx.execute(
    sql`select set_config('statement_timeout', ${String(ENGINE_STATEMENT_TIMEOUT_MS)}, true), set_config('lock_timeout', ${String(ENGINE_LOCK_TIMEOUT_MS)}, true)`,
  );
}

/** The project's engine lock for this transaction, or false when another run holds it. */
export async function tryEngineLock(
  tx: Pick<EngineDb, "execute">,
  projectId: string,
): Promise<boolean> {
  const result = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtext(${`intent-engine:${projectId}`}::text)) as locked`,
  );
  return result.rows[0]?.locked === true;
}

/**
 * Take this hour's naming pass for the project: true for the one run that
 * gets it. Claimed before any model call, so two runs never both pay, and a
 * pass that fails after paying is not paid again within the hour.
 */
export async function claimNamingSlot(
  projectId: string,
  now: Date,
  intervalMs: number,
  db: Pick<EngineDb, "execute"> = getDb(),
): Promise<boolean> {
  const result = await db.execute<{ project_id: string }>(sql`
    update intent_engine_state
       set named_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
     where project_id = ${projectId}
       and (named_at is null or named_at <= ${new Date(now.getTime() - intervalMs).toISOString()}::timestamptz)
    returning project_id
  `);
  return result.rows.length > 0;
}
/** Level-0 clusters one run reads at most, the most recently active first. */
export const CLUSTER_LOAD_LIMIT = 2_000;
/** Idle clusters one run expires at most, when retention is on. */
export const EXPIRE_BATCH = 1_000;

export interface EngineStateRow {
  /** The cursor as Postgres text (microseconds kept), or null before the first run. */
  cursor: string | null;
  nextGraphN: number;
  seededAt: Date | null;
  /** When the model last named this project's clusters. */
  namedAt: Date | null;
}

export async function getEngineState(
  projectId: string,
  db: EngineDb = getDb(),
): Promise<EngineStateRow | null> {
  const [row] = await db
    .select({
      cursor: sql<string | null>`${intentEngineState.clusteredThrough}::text`,
      nextGraphN: intentEngineState.nextGraphN,
      seededAt: intentEngineState.seededAt,
      namedAt: intentEngineState.namedAt,
    })
    .from(intentEngineState)
    .where(eq(intentEngineState.projectId, projectId))
    .limit(1);
  return row ?? null;
}

/**
 * Start a project's engine over: its clusters, levels, assignments and state go,
 * so the next `cluster_intents` run reseeds and re-reads the retention window
 * with the engine as it now is. For applying a change to how asks are clustered;
 * the cursor otherwise only moves forward.
 */
export async function resetIntentEngine(
  projectId: string,
  db: Pick<EngineDb, "transaction"> = getDb(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(intentClusterAssignments)
      .where(eq(intentClusterAssignments.projectId, projectId));
    await tx.delete(intentClusters).where(eq(intentClusters.projectId, projectId));
    await tx.delete(intentEngineState).where(eq(intentEngineState.projectId, projectId));
  });
}

export async function saveEngineState(
  projectId: string,
  patch: { cursor?: string; nextGraphN?: number; seededAt?: Date; namedAt?: Date },
  db: EngineDb = getDb(),
): Promise<void> {
  // The cursor only moves forward, like the fold's: two runs racing must not rewind it.
  const cursor = patch.cursor === undefined ? undefined : sql`${patch.cursor}::timestamptz`;
  await db
    .insert(intentEngineState)
    .values({
      projectId,
      clusteredThrough: cursor as unknown as Date | undefined,
      nextGraphN: patch.nextGraphN ?? 0,
      seededAt: patch.seededAt,
      namedAt: patch.namedAt,
    })
    .onConflictDoUpdate({
      target: intentEngineState.projectId,
      set: {
        ...(cursor !== undefined
          ? {
              clusteredThrough: sql`greatest(coalesce(${intentEngineState.clusteredThrough}, ${cursor}), ${cursor})`,
            }
          : {}),
        ...(patch.nextGraphN !== undefined
          ? { nextGraphN: sql`greatest(${intentEngineState.nextGraphN}, ${patch.nextGraphN})` }
          : {}),
        ...(patch.seededAt ? { seededAt: patch.seededAt } : {}),
        ...(patch.namedAt ? { namedAt: patch.namedAt } : {}),
        updatedAt: new Date(),
      },
    });
}

/* clusters */

export interface ActiveClusters {
  /** Biggest first, then oldest (the matcher's tie-break order). */
  clusters: EngineCluster[];
  /** True when the project holds more level-0 clusters than were read. */
  capped: boolean;
}

/**
 * The project's most recently active level-0 clusters, at most `limit`, in the
 * matcher's order: biggest first, then oldest.
 */
export async function loadActiveClusters(
  projectId: string,
  db: EngineDb = getDb(),
  limit: number = CLUSTER_LOAD_LIMIT,
): Promise<ActiveClusters> {
  const rows = await db
    .select()
    .from(intentClusters)
    .where(and(eq(intentClusters.projectId, projectId), eq(intentClusters.level, 0)))
    // The index's own order only, so the read stops at the limit whatever plan Postgres picks;
    // the matcher's order is set below.
    .orderBy(sql`${intentClusters.lastTs} desc nulls last`)
    .limit(limit + 1);
  const capped = rows.length > limit;
  const kept = capped ? rows.slice(0, limit) : rows;
  kept.sort(
    (a, b) =>
      b.asks - a.asks ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { clusters: kept.map(toCluster), capped };
}

/** {@link loadActiveClusters} without the cap flag: the clusters a run works on. */
export async function loadClusters(
  projectId: string,
  db: EngineDb = getDb(),
): Promise<EngineCluster[]> {
  return (await loadActiveClusters(projectId, db)).clusters;
}

function toCluster(row: IntentClusterRow): EngineCluster {
  const cluster: EngineCluster = {
    uuid: row.id,
    id: row.graphId ?? row.id,
    label: row.label,
    terms: row.terms,
    members: row.members,
    servedMembers: row.servedMembers,
    support: row.support,
    asks: row.asks,
    first_ts: row.firstTs ?? 0,
    tools: row.edges.tools ?? {},
    skills: row.edges.skills ?? {},
    usage: row.usage,
    sources: row.sources,
    queryIntentId: row.queryIntentId,
    parentId: row.parentId,
  };
  if (row.lastTs !== null) cluster.last_ts = row.lastTs;
  if (row.edges.surfaced_tools) cluster.surfaced_tools = row.edges.surfaced_tools;
  if (row.edges.surfaced_skills) cluster.surfaced_skills = row.edges.surfaced_skills;
  return cluster;
}

function toRow(projectId: string, cluster: EngineCluster) {
  // Every write within the row bounds: the maps are keyed by client ids.
  const c = boundCluster(cluster);
  const edges: IntentClusterRow["edges"] = { tools: c.tools, skills: c.skills };
  if (c.surfaced_tools) edges.surfaced_tools = c.surfaced_tools;
  if (c.surfaced_skills) edges.surfaced_skills = c.surfaced_skills;
  return {
    id: c.uuid,
    projectId,
    level: 0,
    graphId: c.id,
    label: c.label,
    terms: c.terms,
    members: c.members,
    servedMembers: c.servedMembers,
    support: c.support,
    asks: c.asks,
    edges,
    usage: c.usage,
    sources: c.sources,
    firstTs: Math.round(c.first_ts),
    lastTs: c.last_ts === undefined ? null : Math.round(c.last_ts),
    queryIntentId: c.queryIntentId,
    updatedAt: new Date(),
  };
}

/** Insert or update the given level-0 clusters. */
export async function saveClusters(
  projectId: string,
  clusters: readonly EngineCluster[],
  db: EngineDb = getDb(),
): Promise<void> {
  for (let i = 0; i < clusters.length; i += WRITE_CHUNK) {
    const rows = clusters.slice(i, i + WRITE_CHUNK).map((c) => toRow(projectId, c));
    await db
      .insert(intentClusters)
      .values(rows)
      .onConflictDoUpdate({
        target: intentClusters.id,
        set: {
          graphId: sql`excluded.graph_id`,
          label: sql`excluded.label`,
          terms: sql`excluded.terms`,
          members: sql`excluded.members`,
          servedMembers: sql`excluded.served_members`,
          support: sql`excluded.support`,
          asks: sql`excluded.asks`,
          edges: sql`excluded.edges`,
          usage: sql`excluded.usage`,
          sources: sql`excluded.sources`,
          firstTs: sql`excluded.first_ts`,
          lastTs: sql`excluded.last_ts`,
          queryIntentId: sql`excluded.query_intent_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
}

/**
 * Apply compaction merges: every ask an absorbed cluster held now belongs to
 * its survivor, and the absorbed row is gone.
 */
export async function applyMerges(
  projectId: string,
  merges: readonly EngineMerge[],
  db: EngineDb = getDb(),
): Promise<void> {
  for (const merge of merges) {
    // An ask counted toward both (a split) keeps one row: drop the absorbed copy first.
    await db.execute(sql`
      delete from intent_cluster_assignments a
       where a.project_id = ${projectId}
         and a.cluster_id = ${merge.absorbedUuid}
         and exists (select 1 from intent_cluster_assignments b
                      where b.trace_event_id = a.trace_event_id
                        and b.cluster_id = ${merge.survivorUuid})
    `);
    await db
      .update(intentClusterAssignments)
      .set({ clusterId: merge.survivorUuid })
      .where(
        and(
          eq(intentClusterAssignments.projectId, projectId),
          eq(intentClusterAssignments.clusterId, merge.absorbedUuid),
        ),
      );
  }
  const gone = merges.map((m) => m.absorbedUuid);
  for (let i = 0; i < gone.length; i += WRITE_CHUNK) {
    await db
      .delete(intentClusters)
      .where(
        and(
          eq(intentClusters.projectId, projectId),
          inArray(intentClusters.id, gone.slice(i, i + WRITE_CHUNK)),
        ),
      );
  }
}

export async function insertAssignments(
  projectId: string,
  assignments: readonly EngineAssignment[],
  db: EngineDb = getDb(),
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < assignments.length; i += WRITE_CHUNK) {
    const rows = await db
      .insert(intentClusterAssignments)
      .values(
        assignments.slice(i, i + WRITE_CHUNK).map((a) => ({
          projectId,
          traceEventId: a.eventId,
          askIndex: a.askIndex,
          clusterId: a.clusterUuid,
          kind: a.kind,
          sessionId: a.sessionId,
          turnId: a.turnId,
          traceId: a.traceId,
          sourceId: a.sourceId,
          occurredAt: new Date(a.at),
        })),
      )
      .onConflictDoNothing()
      .returning({ id: intentClusterAssignments.id });
    inserted += rows.length;
  }
  return inserted;
}

/** Of the given events, the ones that already hold an assignment: a user message read on an earlier page. */
export async function listAssignedEvents(
  eventIds: readonly string[],
  db: EngineDb = getDb(),
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < eventIds.length; i += WRITE_CHUNK) {
    const rows = await db
      .selectDistinct({ id: intentClusterAssignments.traceEventId })
      .from(intentClusterAssignments)
      .where(
        inArray(intentClusterAssignments.traceEventId, [...eventIds.slice(i, i + WRITE_CHUNK)]),
      );
    for (const row of rows) out.add(row.id);
  }
  return out;
}

/**
 * Delete level-0 clusters idle since before `cutoffMs` (their last ask is
 * older than event retention), with their assignments; at most `limit` per
 * call. Member text forgets on the same clock as the events it came from.
 * Callers run it only when retention is on (`DATA_RETENTION_ENABLED=1`).
 */
export async function expireIdleClusters(
  projectId: string,
  cutoffMs: number,
  limit: number = EXPIRE_BATCH,
  db: EngineDb = getDb(),
): Promise<number> {
  const idle = await db
    .select({ id: intentClusters.id })
    .from(intentClusters)
    .where(
      and(
        eq(intentClusters.projectId, projectId),
        eq(intentClusters.level, 0),
        lt(intentClusters.lastTs, cutoffMs),
      ),
    )
    .limit(limit);
  const ids = idle.map((r) => r.id);
  for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
    const chunk = ids.slice(i, i + WRITE_CHUNK);
    await db
      .delete(intentClusterAssignments)
      .where(
        and(
          eq(intentClusterAssignments.projectId, projectId),
          inArray(intentClusterAssignments.clusterId, chunk),
        ),
      );
    await db
      .delete(intentClusters)
      .where(and(eq(intentClusters.projectId, projectId), inArray(intentClusters.id, chunk)));
  }
  return ids.length;
}

/* levels */

/** A stored node above level 0, with what a rebuild compares to decide whether to write it. */
export interface StoredLevelNode extends PriorNode {
  parentId: string | null;
  label: string;
  terms: string[];
}

export async function loadLevelNodes(
  projectId: string,
  db: EngineDb = getDb(),
): Promise<StoredLevelNode[]> {
  return db
    .select({
      uuid: intentClusters.id,
      level: intentClusters.level,
      children: intentClusters.children,
      parentId: intentClusters.parentId,
      label: intentClusters.label,
      terms: intentClusters.terms,
    })
    .from(intentClusters)
    .where(and(eq(intentClusters.projectId, projectId), gt(intentClusters.level, 0)));
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Replace the hierarchy: write the nodes that are new or changed, point each
 * loaded level-0 cluster at its level-1 parent where that changed, then drop
 * the nodes this build no longer has, unless a row still names one as its
 * parent. A cluster this run did not load (past the load cap) keeps the
 * parent it had, and that parent stays, so its asks keep their group.
 */
export async function saveLevels(
  projectId: string,
  tree: LevelTree,
  prior: readonly StoredLevelNode[],
  clusters: readonly Pick<EngineCluster, "uuid" | "parentId">[],
  db: EngineDb = getDb(),
): Promise<{ nodesWritten: number; parentsWritten: number; nodesRemoved: number }> {
  const nodes = tree.levels.slice(1).flat();
  const keep = new Set(nodes.map((n) => n.uuid));
  const before = new Map(prior.map((p) => [p.uuid, p]));
  const changed = nodes.filter((n) => {
    const p = before.get(n.uuid);
    const parent = tree.parentOf.get(n.uuid) ?? null;
    return (
      !p ||
      p.level !== n.level ||
      p.parentId !== parent ||
      p.label !== n.label ||
      !same(p.terms, n.terms) ||
      !same(p.children, n.children)
    );
  });
  for (let i = 0; i < changed.length; i += WRITE_CHUNK) {
    await db
      .insert(intentClusters)
      .values(
        changed.slice(i, i + WRITE_CHUNK).map((n) => ({
          id: n.uuid,
          projectId,
          level: n.level,
          parentId: tree.parentOf.get(n.uuid) ?? null,
          label: n.label,
          terms: n.terms,
          children: n.children,
          updatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: intentClusters.id,
        set: {
          level: sql`excluded.level`,
          parentId: sql`excluded.parent_id`,
          label: sql`excluded.label`,
          terms: sql`excluded.terms`,
          children: sql`excluded.children`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
  const parents = clusters
    .map((c) => ({
      id: c.uuid,
      parent: tree.parentOf.get(c.uuid) ?? null,
      was: c.parentId ?? null,
    }))
    .filter((c) => c.parent !== c.was);
  for (let i = 0; i < parents.length; i += WRITE_CHUNK) {
    const chunk = parents.slice(i, i + WRITE_CHUNK);
    await db.execute(sql`
      update intent_clusters c
         set parent_id = v.parent_id::uuid
        from (values ${sql.join(
          chunk.map((p) => sql`(${p.id}, ${p.parent})`),
          sql`, `,
        )}) as v(id, parent_id)
       where c.project_id = ${projectId} and c.level = 0 and c.id = v.id::uuid
    `);
  }
  // `prior` was read under the same lock, so it is every node there is. Lowest level
  // first: a level-1 node kept for an unread cluster keeps its own parent in turn.
  let removed = 0;
  const gone = prior.filter((p) => !keep.has(p.uuid)).sort((a, b) => a.level - b.level);
  for (const level of [...new Set(gone.map((p) => p.level))]) {
    const ids = gone.filter((p) => p.level === level).map((p) => p.uuid);
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
      const result = await db.execute<{ id: string }>(sql`
        delete from intent_clusters n
         where n.project_id = ${projectId}
           and n.level = ${level}
           and n.id in (${sql.join(
             ids.slice(i, i + WRITE_CHUNK).map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
           and not exists (select 1 from intent_clusters c where c.project_id = ${projectId} and c.parent_id = n.id)
        returning n.id
      `);
      removed += result.rows.length;
    }
  }
  return { nodesWritten: changed.length, parentsWritten: parents.length, nodesRemoved: removed };
}

/* seeding sources */

/** The Cloud-built graphs the first run seeds from: the merged one and each source's. */
export async function loadCloudGraphs(
  projectId: string,
  db: EngineDb = getDb(),
): Promise<{ merged: IntentGraphDocument | null; bySource: Map<string, IntentGraphDocument> }> {
  const rows = await db
    .select({ key: intentGraphs.graphKey, document: intentGraphs.document })
    .from(intentGraphs)
    .where(
      and(
        eq(intentGraphs.projectId, projectId),
        or(
          eq(intentGraphs.graphKey, CLOUD_INTENT_GRAPH_KEY),
          like(intentGraphs.graphKey, `${CLOUD_SOURCE_GRAPH_PREFIX}%`),
        ),
      ),
    );
  const bySource = new Map<string, IntentGraphDocument>();
  let merged: IntentGraphDocument | null = null;
  for (const row of rows) {
    if (row.key === CLOUD_INTENT_GRAPH_KEY) merged = row.document;
    else bySource.set(row.key.slice(CLOUD_SOURCE_GRAPH_PREFIX.length), row.document);
  }
  return { merged, bySource };
}

/** Query intents worth seeding: the project's recurring asks, most frequent first. */
export async function loadSeedQueryIntents(
  projectId: string,
  limit: number,
  db: EngineDb = getDb(),
): Promise<Array<{ id: string; text: string; memberText: string; occurrences: number }>> {
  return db
    .select({
      id: queryIntents.id,
      text: queryIntents.text,
      memberText: queryIntents.memberText,
      occurrences: queryIntents.occurrences,
    })
    .from(queryIntents)
    .where(and(eq(queryIntents.projectId, projectId), gt(queryIntents.occurrences, 0)))
    .orderBy(desc(queryIntents.occurrences), queryIntents.id)
    .limit(limit);
}
