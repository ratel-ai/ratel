import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { skills } from "@/lib/catalog/schema";
import { ifMatchMatches } from "@/lib/catalog/wire";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import {
  FOLD_COMMIT_LAG_MS,
  type FoldEventType,
  type FoldLane,
  foldableEventPredicate,
  foldableReceivedBefore,
  OTLP_FOLD_EVENT_TYPES,
} from "@/lib/ingest/trace-events/event-types";
import { RUNTIME_EVENT_RETENTION_DAYS } from "@/lib/ingest/trace-events/maintenance";
import {
  type IntentGraphRuntimeStatusRow,
  intentGraphRuntimeStatus,
  toolUsageCounters,
  traceEventHits,
  traceEvents,
} from "@/lib/ingest/trace-events/schema";
import type { JobsDb } from "@/lib/jobs/queries";
import { jobs } from "@/lib/jobs/schema";
import { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";
import type { ShadowTurn } from "@/lib/readings/intent-graph/fold";
import {
  type IntentGraphClusterRow,
  type IntentGraphEdgeRow,
  type IntentGraphRow,
  intentGraphClusters,
  intentGraphEdges,
  intentGraphRevisions,
  intentGraphShadowTurns,
  intentGraphs,
  type NewIntentGraphClusterRow,
  type NewIntentGraphEdgeRow,
} from "@/lib/readings/intent-graph/schema";
import {
  cloudGraphSource,
  type IntentGraphDocument,
  type IntentGraphEdgeKind,
  type IntentGraphProducer,
  intentGraphEtag,
} from "@/lib/readings/intent-types/wire";

// The fold's event-type lists, re-exported so the fold job, the reader's
// consumers and the tests import them from one place.
export {
  FOLD_EVENT_TYPES,
  type FoldEventType,
  type FoldLane,
  OTLP_FOLD_EVENT_TYPES,
} from "@/lib/ingest/trace-events/event-types";

export type IntentGraphDb = Pick<
  ReturnType<typeof getDb>,
  "execute" | "select" | "selectDistinct" | "insert" | "delete" | "update" | "transaction"
>;

/** Postgres caps bind parameters at 65,535 per statement; chunk well below it. */
const CLUSTER_INSERT_CHUNK = 500;
const EDGE_INSERT_CHUNK = 1_000;
const SHADOW_INSERT_CHUNK = 500;

export interface PutIntentGraphInput {
  projectId: string;
  sourceId: string;
  graph: IntentGraphDocument;
  contentHash: string;
  byteSize: number;
  /** Raw `If-Match` header, or null when the client sent none. */
  ifMatch: string | null;
  /** Who is writing. Defaults to `"runtime"` (the PUT route); the Cloud-side
   * fold passes `"cloud"` and writes under `CLOUD_INTENT_GRAPH_KEY`. */
  producer?: IntentGraphProducer;
  now?: Date;
}

export type PutIntentGraphResult = {
  outcome: "stored" | "unchanged" | "stale";
  /** The revision now stored (for `stale`, the one that won). */
  rev: number;
  /** ETag of the stored graph. */
  etag: string;
};

/**
 * Store a runtime's graph under (project, source) with stale-base detection.
 *
 * Decision, made against the row under an advisory lock so two writers for the
 * same key serialize:
 * - the client sent a `rev` lower than the stored one, or an `If-Match` that
 *   does not match the stored ETag -> `stale`, nothing written;
 * - the content hash equals the stored one -> `unchanged`, only the receipt
 *   timestamp moves;
 * - otherwise -> `stored`: current row upserted, a revision appended, and the
 *   cluster/edge projection rebuilt, all in one transaction.
 *
 * The stored document is byte-for-byte what the runtime sent, except that its
 * top-level `rev` is rewritten to the revision Cloud assigned, so a pulled graph
 * carries the same counter the next stale check compares against.
 *
 * A first write for a key ignores `If-Match`: there is nothing it could clobber.
 */
export async function putIntentGraph(
  input: PutIntentGraphInput,
  db: IntentGraphDb = getDb(),
): Promise<PutIntentGraphResult> {
  const now = input.now ?? new Date();
  const { projectId, sourceId, graph, contentHash, byteSize } = input;
  const etag = intentGraphEtag(contentHash);
  const incomingRev = graph.rev;

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${projectId}::text || ':' || ${sourceId}::text))`,
    );

    const [current] = await tx
      .select({ rev: intentGraphs.rev, contentHash: intentGraphs.contentHash })
      .from(intentGraphs)
      .where(and(eq(intentGraphs.projectId, projectId), eq(intentGraphs.graphKey, sourceId)))
      .limit(1);

    let newRev: number;
    if (current) {
      const currentEtag = intentGraphEtag(current.contentHash);
      if (incomingRev !== undefined && current.rev > incomingRev) {
        return { outcome: "stale", rev: current.rev, etag: currentEtag };
      }
      if (!ifMatchMatches(input.ifMatch, currentEtag)) {
        return { outcome: "stale", rev: current.rev, etag: currentEtag };
      }
      if (current.contentHash === contentHash) {
        await tx
          .update(intentGraphs)
          .set({ receivedAt: now })
          .where(and(eq(intentGraphs.projectId, projectId), eq(intentGraphs.graphKey, sourceId)));
        return { outcome: "unchanged", rev: current.rev, etag: currentEtag };
      }
      newRev = Math.max(incomingRev ?? 0, current.rev + 1);
    } else {
      newRev = incomingRev ?? 0;
    }

    const stored: IntentGraphDocument = { ...graph, rev: newRev };
    const producer = input.producer ?? ("runtime" as const);
    const summary = {
      producer,
      document: stored,
      rev: newRev,
      schemaVersion: graph.v,
      model: graph.model ?? null,
      builtFromTs: new Date(graph.built_from_ts),
      clusterCount: graph.intents.length,
      byteSize,
      contentHash,
      receivedAt: now,
      updatedAt: now,
    };

    await tx
      .insert(intentGraphs)
      .values({ projectId, graphKey: sourceId, ...summary })
      .onConflictDoUpdate({
        target: [intentGraphs.projectId, intentGraphs.graphKey],
        set: summary,
      });

    // Revisions keep what a runtime pushed. A Cloud-built graph is rebuilt
    // from stored events, so its history is already there, and a fold runs on
    // every ingest batch: appending a copy of the document each time would be
    // the largest write in the system for nothing.
    if (producer !== "cloud") {
      await tx
        .insert(intentGraphRevisions)
        .values({
          projectId,
          graphKey: sourceId,
          rev: newRev,
          document: stored,
          contentHash,
          clusterCount: graph.intents.length,
          receivedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            intentGraphRevisions.projectId,
            intentGraphRevisions.graphKey,
            intentGraphRevisions.rev,
          ],
          set: {
            document: stored,
            contentHash,
            clusterCount: graph.intents.length,
            receivedAt: now,
          },
        });
    }

    await rebuildProjection(tx, projectId, sourceId, stored);

    return { outcome: "stored", rev: newRev, etag };
  });
}

type Tx = Parameters<Parameters<IntentGraphDb["transaction"]>[0]>[0];

/** Flatten the document into cluster and edge rows, replacing whatever was there. */
async function rebuildProjection(
  tx: Tx,
  projectId: string,
  graphKey: string,
  graph: IntentGraphDocument,
): Promise<void> {
  const scope = and(
    eq(intentGraphEdges.projectId, projectId),
    eq(intentGraphEdges.graphKey, graphKey),
  );
  await tx.delete(intentGraphEdges).where(scope);
  await tx
    .delete(intentGraphClusters)
    .where(
      and(eq(intentGraphClusters.projectId, projectId), eq(intentGraphClusters.graphKey, graphKey)),
    );

  const clusters: NewIntentGraphClusterRow[] = graph.intents.map((intent) => ({
    projectId,
    graphKey,
    clusterId: intent.id,
    label: intent.label,
    terms: intent.terms,
    members: intent.members,
    memberCount: intent.members.length,
    support: intent.support,
    seededSupport: intent.seeded_support ?? 0,
    lastTs: intent.last_ts ? new Date(intent.last_ts) : null,
    hasCentroid: Array.isArray(intent.centroid) && intent.centroid.length > 0,
  }));
  for (const chunk of chunked(clusters, CLUSTER_INSERT_CHUNK)) {
    await tx.insert(intentGraphClusters).values(chunk);
  }

  const edges: NewIntentGraphEdgeRow[] = [];
  for (const intent of graph.intents) {
    for (const [capabilityId, weight] of Object.entries(intent.tools)) {
      edges.push({
        projectId,
        graphKey,
        clusterId: intent.id,
        kind: "tool",
        capabilityId,
        weight,
        surfaced: intent.surfaced_tools?.[capabilityId] ?? null,
      });
    }
    for (const [capabilityId, weight] of Object.entries(intent.skills)) {
      edges.push({
        projectId,
        graphKey,
        clusterId: intent.id,
        kind: "skill",
        capabilityId,
        weight,
        surfaced: intent.surfaced_skills?.[capabilityId] ?? null,
      });
    }
  }
  for (const chunk of chunked(edges, EDGE_INSERT_CHUNK)) {
    await tx.insert(intentGraphEdges).values(chunk);
  }
}

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** The current stored graph for one source, or null. */
export async function getIntentGraph(
  projectId: string,
  sourceId: string,
  db: IntentGraphDb = getDb(),
): Promise<IntentGraphRow | null> {
  const [row] = await db
    .select()
    .from(intentGraphs)
    .where(and(eq(intentGraphs.projectId, projectId), eq(intentGraphs.graphKey, sourceId)))
    .limit(1);
  return row ?? null;
}

/**
 * Record that a runtime pulled a graph. Called before the 200/304 decision: the
 * pull itself is the only positive evidence a stored graph reaches a runtime.
 * With `graphKey`, the served row's own `pulled_at` moves too, so adoption is
 * visible per graph and not only per project.
 */
export async function touchIntentGraphPull(
  projectId: string,
  now: Date = new Date(),
  db: IntentGraphDb = getDb(),
  graphKey?: string,
): Promise<void> {
  await db.update(projects).set({ intentGraphPulledAt: now }).where(eq(projects.id, projectId));
  if (graphKey !== undefined) {
    await db
      .update(intentGraphs)
      .set({ pulledAt: now })
      .where(and(eq(intentGraphs.projectId, projectId), eq(intentGraphs.graphKey, graphKey)));
  }
}

// --- dashboard reads ---------------------------------------------------------

/**
 * A runtime adopting a newer revision disables and re-enables ranking, so it
 * reports inactive a moment before active, possibly in separate batches. A
 * graph is only taken back to watching once none of its own runtimes has
 * reported disabling within this window, so the moment it went live survives
 * those hand-overs. Other graphs' runtimes, and a runtime paused on this
 * graph, never hold it live.
 */
export const LIVE_RELEASE_GRACE_MS = 10 * 60_000;

/**
 * Keep `live_at` on a project's Cloud-built graphs in step with what runtimes
 * report. A graph is live from the moment a runtime says it ranks from it (an
 * active `usage_ranking_status` naming its key) and back to watching when none
 * does. Going live is started in the customer's code, by pulling the graph and
 * enabling ranking; this only records it. The first moment is kept while the
 * graph stays live, since the Boost panel dates the online period from it.
 * Called wherever either side can change: a status event arriving, and a fold,
 * which may create the graph a runtime was already asking for.
 */
export async function syncIntentGraphLiveFromStatus(
  projectId: string,
  db: IntentGraphDb = getDb(),
  now: Date = new Date(),
): Promise<void> {
  const releaseBefore = new Date(now.getTime() - LIVE_RELEASE_GRACE_MS).toISOString();
  await db.execute(sql`
    update intent_graphs g
       set live_at = case when s.first_at is null then null else coalesce(g.live_at, s.first_at) end
      from (
        select g2.graph_key, min(r.observed_at) as first_at
          from intent_graphs g2
          left join intent_graph_runtime_status r
            on r.project_id = g2.project_id and r.graph_key = g2.graph_key and r.status = 'active'
         where g2.project_id = ${projectId} and g2.producer = 'cloud'
         group by g2.graph_key
      ) s
     where g.project_id = ${projectId}
       and g.producer = 'cloud'
       and g.graph_key = s.graph_key
       and (
         (g.live_at is null and s.first_at is not null)
         or (
           g.live_at is not null and s.first_at is null
           and not exists (
             select 1 from intent_graph_runtime_status r2
              where r2.project_id = ${projectId}
                and r2.graph_key = g.graph_key
                and r2.reason = 'disabled'
                and r2.observed_at > ${releaseBefore}::timestamptz
           )
         )
       )
  `);
}

/** How many graphs a project stores; the improvement index card needs only this. */
export async function countIntentGraphs(
  projectId: string,
  db: IntentGraphDb = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(intentGraphs)
    .where(eq(intentGraphs.projectId, projectId));
  return row?.n ?? 0;
}

/** One stored graph with its projection aggregates; never carries `document`. */
export interface IntentGraphSummaryRow {
  graphKey: string;
  producer: IntentGraphProducer;
  rev: number;
  model: string | null;
  clusterCount: number;
  byteSize: number;
  builtFromTs: Date;
  receivedAt: Date;
  updatedAt: Date;
  toolEdgeCount: number;
  skillEdgeCount: number;
  memberCount: number;
  /** 0..1: mean of min(1, support / 3) over clusters, i.e. how much of the graph ranks at full weight. */
  maturity: number;
  /** Last time a runtime pulled this graph, or null. */
  pulledAt: Date | null;
  /** Since when a runtime has ranked from this Cloud-built graph, or null while none does. */
  liveAt: Date | null;
}

/**
 * Every stored graph of a project, newest change first. Reads summary columns
 * plus aggregates over the projection tables; the jsonb document is never
 * loaded here because a single row can be megabytes.
 */
export async function listIntentGraphSummaries(
  projectId: string,
  db: IntentGraphDb = getDb(),
): Promise<IntentGraphSummaryRow[]> {
  const edgeAgg = db
    .select({
      graphKey: intentGraphEdges.graphKey,
      toolEdges: sql<number>`count(*) filter (where ${intentGraphEdges.kind} = 'tool')`
        .mapWith(Number)
        .as("tool_edges"),
      skillEdges: sql<number>`count(*) filter (where ${intentGraphEdges.kind} = 'skill')`
        .mapWith(Number)
        .as("skill_edges"),
    })
    .from(intentGraphEdges)
    .where(eq(intentGraphEdges.projectId, projectId))
    .groupBy(intentGraphEdges.graphKey)
    .as("edge_agg");
  const clusterAgg = db
    .select({
      graphKey: intentGraphClusters.graphKey,
      members: sql<number>`coalesce(sum(${intentGraphClusters.memberCount}), 0)`
        .mapWith(Number)
        .as("members"),
      maturity: sql<number>`coalesce(avg(least(${intentGraphClusters.support}, 3)) / 3.0, 0)`
        .mapWith(Number)
        .as("maturity"),
    })
    .from(intentGraphClusters)
    .where(eq(intentGraphClusters.projectId, projectId))
    .groupBy(intentGraphClusters.graphKey)
    .as("cluster_agg");

  const rows = await db
    .select({
      graphKey: intentGraphs.graphKey,
      producer: intentGraphs.producer,
      rev: intentGraphs.rev,
      model: intentGraphs.model,
      clusterCount: intentGraphs.clusterCount,
      byteSize: intentGraphs.byteSize,
      builtFromTs: intentGraphs.builtFromTs,
      receivedAt: intentGraphs.receivedAt,
      updatedAt: intentGraphs.updatedAt,
      pulledAt: intentGraphs.pulledAt,
      liveAt: intentGraphs.liveAt,
      toolEdgeCount: sql<number>`coalesce(${edgeAgg.toolEdges}, 0)`.mapWith(Number),
      skillEdgeCount: sql<number>`coalesce(${edgeAgg.skillEdges}, 0)`.mapWith(Number),
      memberCount: sql<number>`coalesce(${clusterAgg.members}, 0)`.mapWith(Number),
      maturity: sql<number>`coalesce(${clusterAgg.maturity}, 0)`.mapWith(Number),
    })
    .from(intentGraphs)
    .leftJoin(edgeAgg, eq(edgeAgg.graphKey, intentGraphs.graphKey))
    .leftJoin(clusterAgg, eq(clusterAgg.graphKey, intentGraphs.graphKey))
    .where(eq(intentGraphs.projectId, projectId))
    .orderBy(desc(intentGraphs.updatedAt), asc(intentGraphs.graphKey));
  return rows;
}

/** What the catalog knows about a capability an edge points at. */
export interface CapabilityInfo {
  kind: IntentGraphEdgeKind;
  id: string;
  name: string;
  description: string;
  searchableDescription: string;
  /** Exact calls from direct runtime facts, summed over sources; 0 when unknown. */
  calls: number;
  lastUsedAt: Date | null;
  /** Cloud skill id when the wire name resolves to an authored skill. */
  skillId: string | null;
}

/**
 * A cluster row without `members`. The page carries one of these per cluster;
 * members are raw query text, up to 50 per cluster, and are read one cluster at
 * a time when its drawer opens (`getIntentGraphClusterMembers`).
 */
export type IntentGraphClusterSummaryRow = Omit<IntentGraphClusterRow, "members">;

export interface IntentGraphDetail {
  graph: Omit<IntentGraphRow, "document">;
  /** Support descending. Never carries `members`. */
  clusters: IntentGraphClusterSummaryRow[];
  edges: IntentGraphEdgeRow[];
  /** `kind:capabilityId` of edges whose capability has no runtime catalog entry. */
  missingCapabilities: Set<string>;
  /** Catalog details keyed by `kind:capabilityId`, for every edge with an entry. */
  capabilities: Record<string, CapabilityInfo>;
}

/** One graph's summary row plus its full projection and catalog drift. */
export async function getIntentGraphDetail(
  projectId: string,
  graphKey: string,
  db: IntentGraphDb = getDb(),
): Promise<IntentGraphDetail | null> {
  const scope = and(eq(intentGraphs.projectId, projectId), eq(intentGraphs.graphKey, graphKey));
  const [graph] = await db
    .select({
      projectId: intentGraphs.projectId,
      graphKey: intentGraphs.graphKey,
      producer: intentGraphs.producer,
      rev: intentGraphs.rev,
      schemaVersion: intentGraphs.schemaVersion,
      model: intentGraphs.model,
      builtFromTs: intentGraphs.builtFromTs,
      clusterCount: intentGraphs.clusterCount,
      byteSize: intentGraphs.byteSize,
      contentHash: intentGraphs.contentHash,
      receivedAt: intentGraphs.receivedAt,
      updatedAt: intentGraphs.updatedAt,
      pulledAt: intentGraphs.pulledAt,
      liveAt: intentGraphs.liveAt,
    })
    .from(intentGraphs)
    .where(scope)
    .limit(1);
  if (!graph) return null;

  const [clusters, edges, missing, known, usage, skillRows] = await Promise.all([
    db
      .select({
        projectId: intentGraphClusters.projectId,
        graphKey: intentGraphClusters.graphKey,
        clusterId: intentGraphClusters.clusterId,
        label: intentGraphClusters.label,
        labelOverride: intentGraphClusters.labelOverride,
        terms: intentGraphClusters.terms,
        memberCount: intentGraphClusters.memberCount,
        support: intentGraphClusters.support,
        seededSupport: intentGraphClusters.seededSupport,
        lastTs: intentGraphClusters.lastTs,
        hasCentroid: intentGraphClusters.hasCentroid,
      })
      .from(intentGraphClusters)
      .where(
        and(
          eq(intentGraphClusters.projectId, projectId),
          eq(intentGraphClusters.graphKey, graphKey),
        ),
      )
      .orderBy(desc(intentGraphClusters.support), asc(intentGraphClusters.clusterId)),
    db
      .select()
      .from(intentGraphEdges)
      .where(
        and(eq(intentGraphEdges.projectId, projectId), eq(intentGraphEdges.graphKey, graphKey)),
      )
      .orderBy(
        asc(intentGraphEdges.clusterId),
        asc(intentGraphEdges.kind),
        desc(intentGraphEdges.weight),
      ),
    db
      .selectDistinct({ kind: intentGraphEdges.kind, capabilityId: intentGraphEdges.capabilityId })
      .from(intentGraphEdges)
      .where(
        and(
          eq(intentGraphEdges.projectId, projectId),
          eq(intentGraphEdges.graphKey, graphKey),
          notExists(
            db
              .select({ one: sql`1` })
              .from(runtimeCatalogEntries)
              .where(
                and(
                  eq(runtimeCatalogEntries.projectId, intentGraphEdges.projectId),
                  eq(runtimeCatalogEntries.kind, intentGraphEdges.kind),
                  eq(runtimeCatalogEntries.entryId, intentGraphEdges.capabilityId),
                ),
              ),
          ),
        ),
      ),
    db
      .selectDistinct({
        kind: runtimeCatalogEntries.kind,
        entryId: runtimeCatalogEntries.entryId,
        name: runtimeCatalogEntries.name,
        description: runtimeCatalogEntries.description,
        searchableDescription: runtimeCatalogEntries.searchableDescription,
        override: runtimeCatalogEntries.searchableDescriptionOverride,
      })
      .from(runtimeCatalogEntries)
      .innerJoin(
        intentGraphEdges,
        and(
          eq(intentGraphEdges.projectId, runtimeCatalogEntries.projectId),
          eq(intentGraphEdges.kind, runtimeCatalogEntries.kind),
          eq(intentGraphEdges.capabilityId, runtimeCatalogEntries.entryId),
        ),
      )
      .where(
        and(eq(intentGraphEdges.projectId, projectId), eq(intentGraphEdges.graphKey, graphKey)),
      ),
    db
      .select({
        toolId: toolUsageCounters.toolId,
        calls: sql<number>`coalesce(sum(${toolUsageCounters.calls}), 0)`.mapWith(Number),
        lastUsedAt: sql<Date | null>`max(${toolUsageCounters.lastUsedAt})`.mapWith((v: unknown) =>
          v ? new Date(v as string) : null,
        ),
      })
      .from(toolUsageCounters)
      .where(eq(toolUsageCounters.projectId, projectId))
      .groupBy(toolUsageCounters.toolId),
    db
      .select({ id: skills.id, name: skills.name })
      .from(skills)
      .where(eq(skills.projectId, projectId)),
  ]);

  const usageByTool = new Map(usage.map((u) => [u.toolId, u]));
  const skillIdByName = new Map(skillRows.map((s) => [s.name, s.id]));
  const capabilities: Record<string, CapabilityInfo> = {};
  for (const entry of known) {
    if (entry.kind !== "tool" && entry.kind !== "skill") continue;
    const kind: IntentGraphEdgeKind = entry.kind;
    const use = kind === "tool" ? usageByTool.get(entry.entryId) : undefined;
    capabilities[`${kind}:${entry.entryId}`] = {
      kind,
      id: entry.entryId,
      name: entry.name,
      description: entry.description,
      searchableDescription: entry.override ?? entry.searchableDescription,
      calls: use?.calls ?? 0,
      lastUsedAt: use?.lastUsedAt ?? null,
      skillId: kind === "skill" ? (skillIdByName.get(entry.entryId) ?? null) : null,
    };
  }

  return {
    graph,
    clusters,
    edges,
    missingCapabilities: new Set(missing.map((m) => `${m.kind}:${m.capabilityId}`)),
    capabilities,
  };
}

/** One cluster's members (raw query text), or null when the cluster does not exist. */
export async function getIntentGraphClusterMembers(
  projectId: string,
  graphKey: string,
  clusterId: string,
  db: IntentGraphDb = getDb(),
): Promise<string[] | null> {
  const [row] = await db
    .select({ members: intentGraphClusters.members })
    .from(intentGraphClusters)
    .where(
      and(
        eq(intentGraphClusters.projectId, projectId),
        eq(intentGraphClusters.graphKey, graphKey),
        eq(intentGraphClusters.clusterId, clusterId),
      ),
    )
    .limit(1);
  return row ? row.members : null;
}

export interface IntentGraphTopCluster {
  graphKey: string;
  clusterId: string;
  support: number;
  memberCount: number;
}

/**
 * The strongest clusters of every graph in a project, at most `perGraph` each,
 * support descending. Feeds the list page's per-card motif so the miniature
 * reflects the real graph rather than a decoration.
 */
export async function listIntentGraphTopClusters(
  projectId: string,
  perGraph = 10,
  db: IntentGraphDb = getDb(),
): Promise<IntentGraphTopCluster[]> {
  const ranked = db
    .select({
      graphKey: intentGraphClusters.graphKey,
      clusterId: intentGraphClusters.clusterId,
      support: intentGraphClusters.support,
      memberCount: intentGraphClusters.memberCount,
      rank: sql<number>`row_number() over (partition by ${intentGraphClusters.graphKey} order by ${intentGraphClusters.support} desc, ${intentGraphClusters.memberCount} desc, ${intentGraphClusters.clusterId} asc)`
        .mapWith(Number)
        .as("rank"),
    })
    .from(intentGraphClusters)
    .where(eq(intentGraphClusters.projectId, projectId))
    .as("ranked");
  const rows = await db
    .select({
      graphKey: ranked.graphKey,
      clusterId: ranked.clusterId,
      support: ranked.support,
      memberCount: ranked.memberCount,
    })
    .from(ranked)
    .where(sql`${ranked.rank} <= ${perGraph}`)
    .orderBy(asc(ranked.graphKey), asc(ranked.rank));
  return rows;
}

// --- shadow turns: Cloud's own with-and-without ranking per search ----------

/**
 * Store the shadow turns one fold page produced for one graph; a re-fold
 * overwrites. `liveAt` is the graph's as the page was folded: a turn counts as
 * online when its search happened at or after it.
 */
export async function upsertIntentGraphShadowTurns(
  projectId: string,
  graphKey: string,
  turns: readonly ShadowTurn[],
  liveAt: Date | null,
  db: IntentGraphDb = getDb(),
): Promise<void> {
  for (const chunk of chunked(turns, SHADOW_INSERT_CHUNK)) {
    await db
      .insert(intentGraphShadowTurns)
      .values(
        chunk.map((turn) => ({
          projectId,
          graphKey,
          searchEventId: turn.searchEventId,
          sourceId: turn.sourceId,
          occurredAt: turn.occurredAt,
          plainIds: turn.plainIds,
          boostedIds: turn.boostedIds,
          matched: turn.matched,
          // Live by the search's own time, not the fold's: a fold that runs
          // after the graph went live still holds searches from before it. A
          // reported turn was ranked with the graph by the runtime itself.
          live: turn.reported || (liveAt !== null && turn.occurredAt >= liveAt),
          reported: turn.reported,
          invokedToolId: turn.invokedToolId,
        })),
      )
      .onConflictDoUpdate({
        target: [
          intentGraphShadowTurns.projectId,
          intentGraphShadowTurns.graphKey,
          intentGraphShadowTurns.searchEventId,
        ],
        set: {
          plainIds: sql`excluded.plain_ids`,
          boostedIds: sql`excluded.boosted_ids`,
          matched: sql`excluded.matched`,
          live: sql`excluded.live`,
          reported: sql`excluded.reported`,
          invokedToolId: sql`excluded.invoked_tool_id`,
        },
      });
  }
}

// --- Cloud-built graph: fold cursor and event reads ---------------------------

/** Rows per fold page. Bounds one learner pass and the hits join. */
export const FOLD_PAGE_LIMIT = 5_000;
/** Hits are fetched per chunk of event ids, well under Postgres's bind cap. */
const HITS_ID_CHUNK = 500;

export interface FoldableEventRow {
  id: string;
  /** Already mapped: an OTLP ask reads as `search`, an OTLP tool call as `invoke_start`. */
  type: FoldEventType;
  lane: FoldLane;
  sessionId: string | null;
  sourceId: string | null;
  query: string | null;
  origin: string | null;
  toolId: string | null;
  skillId: string | null;
  topK: number | null;
  tookMs: number | null;
  receivedAt: Date;
  /** `received_at` exactly as Postgres holds it (microsecond precision). The
   * cursor is advanced with this, never with the millisecond `Date`, or the
   * tail of every batch would be re-read and folded twice. */
  receivedAtRaw: string;
  /** `turn_id` from the promoted column when present, else the raw envelope. */
  turnId: string | null;
  /** The runtime's own timestamp for the event, when it sent one. */
  occurredAt?: Date | null;
  /** The OTel trace the row came in, when it has one. */
  traceId?: string | null;
  /** The opaque end user the host attributed the event to. */
  endUserId?: string | null;
  /**
   * For a search the runtime's intent graph changed: the ids it would have
   * served without it, best first (`base_hits` on the event). Null otherwise.
   */
  baseHitIds?: string[] | null;
}

/** The user-message rows `listFoldableTraceEvents` adds with `userMessages`: an SDK turn scope's `turn_start`. */
export const USER_MESSAGE_EVENT_TYPE = "turn_start";
/** How far from a page's events a turn's user message is looked for, by event time. */
const USER_MESSAGE_SLACK_MS = 3_600_000;
/** Event times further apart than this are looked up as separate windows. */
const USER_MESSAGE_GAP_MS = 86_400_000;
/** Windows one page looks messages up in, at most; past it, the closest are merged. */
const USER_MESSAGE_WINDOWS = 8;

/**
 * The event-time windows a page's messages are looked for in: its times cut
 * wherever they are more than a day apart, each widened by the slack. A client
 * clock can say anything, so one drifted event gets a small window of its own
 * instead of stretching one window over the project's whole history; a page of
 * replayed history still gets its own span. At most `max` windows: past that,
 * the closest neighbours are merged.
 */
export function messageWindows(
  times: readonly number[],
  max: number = USER_MESSAGE_WINDOWS,
): Array<[number, number]> {
  const sorted = [...times].sort((a, b) => a - b);
  const windows: Array<[number, number]> = [];
  for (const t of sorted) {
    const last = windows[windows.length - 1];
    if (last && t - last[1] <= USER_MESSAGE_GAP_MS) last[1] = t;
    else windows.push([t, t]);
  }
  while (windows.length > max) {
    let at = 0;
    for (let i = 1; i < windows.length - 1; i += 1) {
      if (windows[i + 1]![0] - windows[i]![1] < windows[at + 1]![0] - windows[at]![1]) at = i;
    }
    windows.splice(at, 2, [windows[at]![0], windows[at + 1]![1]]);
  }
  return windows.map(([from, to]) => [from - USER_MESSAGE_SLACK_MS, to + USER_MESSAGE_SLACK_MS]);
}

export interface FoldableHit {
  rank: number;
  targetType: string;
  targetId: string;
  score: number | null;
}

/**
 * The project's fold cursor: the latest `received_at` already folded, or null
 * before the first run. Returned as Postgres's own text so it round-trips at
 * microsecond precision; a millisecond `Date` here would re-read the tail of
 * every boundary batch on the next run and fold it twice.
 */
export async function getIntentGraphFoldCursor(
  projectId: string,
  db: IntentGraphDb = getDb(),
): Promise<string | null> {
  const [row] = await db
    .select({ through: sql<string | null>`${projects.intentGraphFoldedThrough}::text` })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.through ?? null;
}

/** Advance the fold cursor, never backwards: two runs racing must not rewind it. */
export async function advanceIntentGraphFoldCursor(
  projectId: string,
  through: Date | string,
  db: IntentGraphDb = getDb(),
): Promise<void> {
  // A string is the DB's own `received_at::text`, cast back without losing the
  // microseconds a JS Date cannot carry.
  const value = typeof through === "string" ? sql`${through}::timestamptz` : sql`${through}`;
  await db
    .update(projects)
    .set({
      intentGraphFoldedThrough: sql`greatest(coalesce(${projects.intentGraphFoldedThrough}, ${value}), ${value})`,
    })
    .where(eq(projects.id, projectId));
}

/**
 * One page of foldable events received after `since`, oldest first by
 * `(received_at, id)`.
 *
 * Order within one `received_at` (one ingest batch) is the event's own time,
 * `coalesce(occurred_at, received_at)`, then id: the SDK stamps `ts` in
 * emission order, so a search precedes the invoke that confirms it. The row id
 * is a content hash and carries no order at all.
 *
 * Tie completion: every event of one ingest request shares the insert
 * transaction's `received_at`, so a page that ends mid-timestamp would split a
 * batch, and the caller's strict `>` cursor would then skip the rest of it
 * forever. When a page comes back full, the remainder of the last timestamp is
 * fetched and appended, so the cursor always lands on a complete boundary. A
 * page is therefore at most `limit + one batch`.
 *
 * With `userMessages` (the intent engine, never the fold) each declared turn
 * on the page also gets the user's message its SDK turn scope sent
 * (`turn_start.user_message`), placed just before the turn's first row. They
 * are looked up by the page's own sessions and turn ids within an hour of its
 * events, on the event-time index, so the page itself still reads by the
 * fold's partial index. A message row never moves a cursor: callers advance
 * past the last row of another type.
 */
export async function listFoldableTraceEvents(
  projectId: string,
  since: Date | string,
  db: IntentGraphDb = getDb(),
  limit: number = FOLD_PAGE_LIMIT,
  commitLagMs: number = FOLD_COMMIT_LAG_MS,
  options: { userMessages?: boolean } = {},
): Promise<FoldableEventRow[]> {
  // A string is a cursor as `getIntentGraphFoldCursor` returned it: cast in SQL
  // so the comparison keeps the microseconds.
  const after = typeof since === "string" ? sql`${since}::timestamptz` : sql`${since}`;
  // The OTLP lane is the plain-trace rows only. An SDK runtime exporting over
  // OTLP leaves ordinary `search` rows, and those stay on the runtime lane.
  const otlp = and(
    eq(traceEvents.ingestSource, "otlp"),
    inArray(traceEvents.type, [...OTLP_FOLD_EVENT_TYPES]),
  );
  // An OTLP row is mapped here, once, so the fold sees one shape: the model
  // call's prompt is the query of a `search` with no served list, the tool
  // span an `invoke_start`, and the trace is the turn. The session is the
  // trace too: a tool span exported in its own batch resolves no conversation
  // id, and the pair must still key alike.
  const columns = {
    id: traceEvents.id,
    type: sql<string>`case
      when ${traceEvents.type} = 'otlp_model_call' and ${otlp} then 'search'
      when ${traceEvents.type} in ('invoke_end', 'invoke_error') and ${otlp} then 'invoke_start'
      else ${traceEvents.type} end`,
    lane: sql<FoldLane>`case when ${otlp} then 'otlp' else 'runtime' end`,
    sessionId: sql<
      string | null
    >`case when ${otlp} then ${traceEvents.traceId} else ${traceEvents.sessionId} end`,
    sourceId: traceEvents.sourceId,
    query: sql<
      string | null
    >`case when ${traceEvents.type} = 'otlp_model_call' then ${traceEvents.payload} ->> 'prompt'
      when ${traceEvents.type} = ${USER_MESSAGE_EVENT_TYPE} then ${traceEvents.payload} ->> 'user_message'
      else ${traceEvents.query} end`,
    origin: sql<
      string | null
    >`case when ${traceEvents.type} = 'otlp_model_call' then 'baseline' else ${traceEvents.origin} end`,
    toolId: traceEvents.toolId,
    skillId: traceEvents.skillId,
    topK: sql<
      number | null
    >`case when ${traceEvents.type} = 'otlp_model_call' then 0 else ${traceEvents.topK} end`,
    tookMs: traceEvents.tookMs,
    receivedAt: traceEvents.receivedAt,
    occurredAt: traceEvents.occurredAt,
    receivedAtRaw: sql<string>`${traceEvents.receivedAt}::text`,
    traceId: traceEvents.traceId,
    endUserId: traceEvents.endUserId,
    // The promoted column, falling back to the raw envelope for rows ingested
    // before it existed. An OTLP row's turn is its trace, as its session is.
    turnId: sql<string | null>`case when ${otlp} then ${traceEvents.traceId}
      else coalesce(${traceEvents.turnId}, ${traceEvents.payload} ->> 'turn_id') end`,
    // The runtime's own "without the graph" ranking, when it sent one.
    baseHitIds: sql<string[] | null>`(
      select jsonb_agg(coalesce(h ->> 'tool_id', h ->> 'skill_id') order by ord)
        from jsonb_array_elements(case when jsonb_typeof(${traceEvents.payload} -> 'base_hits') = 'array'
                                       then ${traceEvents.payload} -> 'base_hits' else '[]'::jsonb end)
             with ordinality as t(h, ord)
    )`,
  };
  // The one predicate the cron safety net asks by too, so the two cannot drift.
  const inTypes = foldableEventPredicate(traceEvents);
  const eventTime = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
  // A turn's search and its invoke often share a millisecond, and the row id is
  // a hash of a random client id, so an id tie-break puts the invoke first about
  // half the time and the learner sees an invoke with no search before it. Within
  // one instant, searches go first.
  const typeOrder = sql`case when ${traceEvents.type} in ('search', 'skill_search', 'otlp_model_call') then 0 else 1 end`;
  const page = await db
    .select(columns)
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        inTypes,
        sql`${traceEvents.receivedAt} > ${after}`,
        // Not past the newest row a still-open ingest transaction could commit behind.
        foldableReceivedBefore(traceEvents, commitLagMs),
      ),
    )
    .orderBy(asc(traceEvents.receivedAt), asc(eventTime), typeOrder, asc(traceEvents.id))
    .limit(limit);
  let rows = page.map(toFoldable);
  const last = rows[rows.length - 1];
  if (rows.length >= limit && last) {
    // Re-read the whole last timestamp rather than "after the last id": the
    // page's tail is ordered by event time, not id, so an id cut would be wrong.
    const seen = new Set(rows.map((r) => r.id));
    const rest = await db
      .select(columns)
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          inTypes,
          sql`${traceEvents.receivedAt} = ${last.receivedAtRaw}::timestamptz`,
        ),
      )
      .orderBy(asc(eventTime), typeOrder, asc(traceEvents.id));
    rows = rows.concat(rest.map(toFoldable).filter((r) => !seen.has(r.id)));
  }
  if (!options.userMessages || rows.length === 0) return rows;
  const declared = rows.filter(
    (r) => r.lane === "runtime" && r.sessionId !== null && r.turnId !== null,
  );
  if (declared.length === 0) return rows;
  const sessions = [...new Set(declared.map((r) => r.sessionId!))];
  const turnIds = [...new Set(declared.map((r) => r.turnId!))];
  const messages: FoldableEventRow[] = [];
  // One after another: the caller may hand over one connection (the engine's transaction).
  for (const [from, to] of messageWindows(
    declared.map((r) => (r.occurredAt ?? r.receivedAt).getTime()),
  )) {
    const found = await db
      .select(columns)
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          eq(traceEvents.type, USER_MESSAGE_EVENT_TYPE),
          sql`${traceEvents.payload} ? 'user_message'`,
          // The event-time index: bounded ranges around the page, never the project's history.
          sql`${eventTime} >= ${new Date(from).toISOString()}::timestamptz`,
          sql`${eventTime} <= ${new Date(to).toISOString()}::timestamptz`,
          inArray(traceEvents.sessionId, sessions),
          inArray(
            sql`coalesce(${traceEvents.turnId}, ${traceEvents.payload} ->> 'turn_id')`,
            turnIds,
          ),
          // Not past the page: what arrives later is read with the page it belongs to.
          sql`${traceEvents.receivedAt} <= ${rows[rows.length - 1]!.receivedAtRaw}::timestamptz`,
        ),
      )
      .orderBy(asc(eventTime), asc(traceEvents.id));
    messages.push(...found.map(toFoldable));
  }
  return withUserMessages(rows, messages);
}

/**
 * Each message just before the first row of its turn, the page's own order
 * kept. A message whose turn is not on the page is dropped; one turn keeps its
 * first message.
 */
export function withUserMessages(
  rows: readonly FoldableEventRow[],
  messages: readonly FoldableEventRow[],
): FoldableEventRow[] {
  const key = (r: Pick<FoldableEventRow, "sessionId" | "turnId">) =>
    `${r.sessionId ?? ""}\u0000${r.turnId ?? ""}`;
  const byTurn = new Map<string, FoldableEventRow>();
  for (const m of messages)
    if (m.sessionId !== null && m.turnId !== null && !byTurn.has(key(m))) byTurn.set(key(m), m);
  if (byTurn.size === 0) return [...rows];
  const out: FoldableEventRow[] = [];
  for (const row of rows) {
    const message = row.lane === "runtime" ? byTurn.get(key(row)) : undefined;
    if (message) {
      out.push(message);
      byTurn.delete(key(row));
    }
    out.push(row);
  }
  return out;
}

function toFoldable(r: {
  id: string;
  type: string;
  lane: FoldLane;
  sessionId: string | null;
  sourceId: string | null;
  query: string | null;
  origin: string | null;
  toolId: string | null;
  skillId: string | null;
  topK: number | null;
  tookMs: number | null;
  receivedAt: Date | string;
  receivedAtRaw: string;
  turnId: string | null;
  traceId?: string | null;
  endUserId?: string | null;
  baseHitIds?: string[] | null;
}): FoldableEventRow {
  return {
    ...r,
    type: r.type as FoldEventType,
    receivedAt: r.receivedAt instanceof Date ? r.receivedAt : new Date(r.receivedAt),
  };
}

/**
 * For each of the given OTLP traces, the ask the fold last learned from it:
 * the newest model call with a prompt received at or before the cursor. An
 * agent loop re-sends the user's message on every model call, and the fold
 * learns a trace's ask once per change; a trace folded in two passes (a pause
 * past the hold grace, a run past its cap, a page boundary) would otherwise
 * have its first repeat learned again in the second. Keyed by trace id, which
 * is the OTLP lane's session and turn.
 */
export async function listLastFoldedAsks(
  projectId: string,
  traceIds: readonly string[],
  cursor: Date | string | null,
  db: IntentGraphDb = getDb(),
): Promise<Map<string, string>> {
  if (traceIds.length === 0 || cursor === null) return new Map();
  const before = typeof cursor === "string" ? sql`${cursor}::timestamptz` : sql`${cursor}`;
  const rows = await db.execute<{ trace_id: string; prompt: string }>(sql`
    select distinct on (trace_id) trace_id, payload ->> 'prompt' as prompt
      from trace_events
     where project_id = ${projectId}
       and trace_id = any(${sql.raw(`array[${traceIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")}]::text[]`)})
       and ingest_source = 'otlp'
       and type = 'otlp_model_call'
       and payload ? 'prompt'
       and received_at <= ${before}
     order by trace_id, coalesce(occurred_at, received_at) desc, received_at desc, id desc
  `);
  return new Map(rows.rows.map((r) => [r.trace_id, r.prompt]));
}

/** Ranked hits for a set of search events, keyed by event id, rank ascending. */
export async function listTraceEventHitsForEvents(
  eventIds: readonly string[],
  db: IntentGraphDb = getDb(),
): Promise<Map<string, FoldableHit[]>> {
  const out = new Map<string, FoldableHit[]>();
  for (const ids of chunked(eventIds, HITS_ID_CHUNK)) {
    const rows = await db
      .select({
        traceEventId: traceEventHits.traceEventId,
        rank: traceEventHits.rank,
        targetType: traceEventHits.targetType,
        targetId: traceEventHits.targetId,
        score: traceEventHits.score,
      })
      .from(traceEventHits)
      .where(inArray(traceEventHits.traceEventId, [...ids]))
      .orderBy(asc(traceEventHits.traceEventId), asc(traceEventHits.rank));
    for (const row of rows) {
      const list = out.get(row.traceEventId) ?? [];
      list.push({
        rank: row.rank,
        targetType: row.targetType,
        targetId: row.targetId,
        score: row.score,
      });
      out.set(row.traceEventId, list);
    }
  }
  return out;
}

/** Every runtime source's latest reported adaptive-ranking status, newest first. */
export async function listIntentGraphRuntimeStatus(
  projectId: string,
  db: IntentGraphDb = getDb(),
): Promise<IntentGraphRuntimeStatusRow[]> {
  return db
    .select()
    .from(intentGraphRuntimeStatus)
    .where(eq(intentGraphRuntimeStatus.projectId, projectId))
    .orderBy(desc(intentGraphRuntimeStatus.observedAt), asc(intentGraphRuntimeStatus.sourceId));
}

/** What one source sent in a window: a runtime's searches, or an agent's asks over OpenTelemetry. */
export interface LearningSource {
  sourceId: string;
  lane: FoldLane;
  /** Runtime lane: tool searches. OTLP lane: model calls that carried the user's ask. */
  searches: number;
  invokes: number;
  /** OTLP lane only: model calls with no ask on them, content capture off. */
  silentCalls: number;
  lastAt: Date;
}

/**
 * Learning events per source since `since`, per lane: how many searches and
 * tool calls a runtime sent, how many asks and tool calls an agent sent over
 * OpenTelemetry, and how many of its model calls carried no ask. The first
 * thing the setup checklist looks at.
 */
export async function listRecentLearningSources(
  projectId: string,
  since: Date,
  db: IntentGraphDb = getDb(),
): Promise<LearningSource[]> {
  const rows = await db.execute<{
    source_id: string;
    lane: FoldLane;
    searches: number;
    invokes: number;
    silent_calls: number;
    last_at: string | Date;
  }>(sql`
    select source_id,
           case when ingest_source = 'otlp' then 'otlp' else 'runtime' end as lane,
           count(*) filter (where type = 'search' or (type = 'otlp_model_call' and payload ? 'prompt'))::int as searches,
           count(*) filter (where type = 'invoke_start' or (ingest_source = 'otlp' and type in ('invoke_end', 'invoke_error')))::int as invokes,
           count(*) filter (where type = 'otlp_model_call' and not payload ? 'prompt')::int as silent_calls,
           max(received_at) as last_at
    from trace_events
    where project_id = ${projectId}
      and (
        (ingest_source = 'runtime' and type in ('search', 'invoke_start'))
        or (ingest_source = 'otlp' and type in (${sql.join(
          OTLP_FOLD_EVENT_TYPES.map((t) => sql`${t}`),
          sql`, `,
        )}))
      )
      and source_id is not null
      and received_at >= ${since}
    group by source_id, case when ingest_source = 'otlp' then 'otlp' else 'runtime' end
    order by searches desc, source_id asc
  `);
  return rows.rows.map((r) => ({
    sourceId: r.source_id,
    lane: r.lane,
    searches: Number(r.searches),
    invokes: Number(r.invokes),
    silentCalls: Number(r.silent_calls),
    lastAt: r.last_at instanceof Date ? r.last_at : new Date(r.last_at),
  }));
}

/**
 * Per Cloud-built graph, how many of its tools are no longer in the runtime
 * catalog: the graph keeps promoting something the agent can no longer call.
 * Empty when the project has no catalog to compare against.
 */
export async function countMissingToolsByGraph(
  projectId: string,
  db: IntentGraphDb = getDb(),
): Promise<Map<string, number>> {
  const rows = await db.execute<{ graph_key: string; missing: number }>(sql`
    select e.graph_key, count(distinct e.capability_id)::int as missing
    from intent_graph_edges e
    where e.project_id = ${projectId}
      and e.kind = 'tool'
      and exists (select 1 from runtime_catalog_entries c where c.project_id = e.project_id and c.kind = 'tool')
      and not exists (
        select 1 from runtime_catalog_entries c
        where c.project_id = e.project_id and c.kind = 'tool' and c.entry_id = e.capability_id
      )
    group by e.graph_key
  `);
  return new Map(rows.rows.map((r) => [r.graph_key, Number(r.missing)]));
}

// --- the fold job's queue: from the upstream queries hub ----------------------

/**
 * Enqueue a `fold_intent_graph` job for a project, coalesced: the partial
 * unique index `jobs_fold_intent_graph_queued_idx` allows at most one *queued*
 * fold per project, so under concurrent ingest the insert simply no-ops and
 * this returns null. A `running` fold does not block a new queued one, so a
 * batch that lands mid-run still gets a follow-up.
 *
 * With `minIntervalMs`, nothing is enqueued while a fold finished less than
 * that long ago, done or errored: every fold rewrites each of the project's
 * Cloud graphs and their projections, and a runtime flushes every few seconds,
 * so the ingest path paces itself and the cron safety net folds whatever the
 * pause left. An errored fold counts too, or a failure that repeats by design
 * (the store cap holds the cursor and throws again) would re-run on every
 * batch; the cron's hour-long error backoff governs the longer term. The read
 * ranges on `jobs_fold_intent_graph_finished_idx`, so it stays bounded as a
 * project's finished folds accrue.
 */
export async function enqueueFoldIntentGraphJob(
  projectId: string,
  db: JobsDb = getDb(),
  options: { minIntervalMs?: number } = {},
): Promise<{ id: string } | null> {
  if (options.minIntervalMs !== undefined && options.minIntervalMs > 0) {
    const since = new Date(Date.now() - options.minIntervalMs);
    const [recent] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.projectId, projectId),
          eq(jobs.kind, "fold_intent_graph"),
          inArray(jobs.status, ["done", "error"]),
          gt(jobs.finishedAt, since),
        ),
      )
      .limit(1);
    if (recent) return null;
  }
  const rows = await db
    .insert(jobs)
    .values({ projectId, kind: "fold_intent_graph", status: "queued", payload: null })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0] ?? null;
}

/**
 * Projects with foldable events past their fold cursor (or within the retention
 * window when the cursor is null), excluding those with a queued fold already
 * and those with any fold job that errored within the last hour. Only projects
 * the fold has met before are candidates: one with a cursor or a fold job of
 * any status, so the limit bounds the read. A project's first fold therefore
 * comes from the ingest kick; this only catches a later kick that was lost (a
 * replica recycled between the insert and the post-response drain).
 */
export async function listProjectsWithUnfoldedEvents(
  db: JobsDb = getDb(),
  options: {
    retentionDays?: number;
    errorBackoffMs?: number;
    limit?: number;
    commitLagMs?: number;
  } = {},
): Promise<Array<{ id: string }>> {
  const retentionDays = options.retentionDays ?? 30;
  const errorBackoffMs = options.errorBackoffMs ?? 60 * 60 * 1000;
  const limit = options.limit ?? 200;
  const windowStart = sql`now() - make_interval(days => ${retentionDays})`;
  const backoffStart = new Date(Date.now() - errorBackoffMs);
  return db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        exists(
          db
            .select({ one: sql`1` })
            .from(traceEvents)
            .where(
              and(
                eq(traceEvents.projectId, projects.id),
                foldableEventPredicate(traceEvents),
                sql`${traceEvents.receivedAt} > coalesce(${projects.intentGraphFoldedThrough}, ${windowStart})`,
                // The reader's own lag: a row it cannot read yet is not unfolded.
                foldableReceivedBefore(traceEvents, options.commitLagMs),
              ),
            ),
        ),
        or(
          isNotNull(projects.intentGraphFoldedThrough),
          exists(
            db
              .select({ one: sql`1` })
              .from(jobs)
              .where(and(eq(jobs.projectId, projects.id), eq(jobs.kind, "fold_intent_graph"))),
          ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(jobs)
            .where(
              and(
                eq(jobs.projectId, projects.id),
                eq(jobs.kind, "fold_intent_graph"),
                eq(jobs.status, "queued"),
              ),
            ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(jobs)
            .where(
              and(
                eq(jobs.projectId, projects.id),
                eq(jobs.kind, "fold_intent_graph"),
                eq(jobs.status, "error"),
                gt(jobs.finishedAt, backoffStart),
              ),
            ),
        ),
      ),
    )
    .limit(limit);
}
