import { sql } from "drizzle-orm";
import { RUNTIME_EVENT_RETENTION_DAYS } from "@/lib/ingest/trace-events/maintenance";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  reportServerException,
  trackServerEvent as trackServerEventFn,
} from "@/lib/platform/telemetry";
import { type CompactionOptions, compactIntentGraph } from "@/lib/readings/intent-graph/compact";
import {
  type FoldShadow,
  foldablePrefix,
  foldEventsIntoGraph,
  turnKey,
} from "@/lib/readings/intent-graph/fold";
import type { FoldableEventRow, FoldLane } from "@/lib/readings/intent-graph/queries";
import {
  advanceIntentGraphFoldCursor as advanceIntentGraphFoldCursorFn,
  enqueueFoldIntentGraphJob as enqueueFoldIntentGraphJobFn,
  FOLD_PAGE_LIMIT,
  getIntentGraph as getIntentGraphFn,
  getIntentGraphFoldCursor as getIntentGraphFoldCursorFn,
  listFoldableTraceEvents as listFoldableTraceEventsFn,
  listIntentGraphRuntimeStatus as listIntentGraphRuntimeStatusFn,
  listLastFoldedAsks as listLastFoldedAsksFn,
  listProjectsWithUnfoldedEvents as listProjectsWithUnfoldedEventsFn,
  listTraceEventHitsForEvents as listTraceEventHitsForEventsFn,
  putIntentGraph as putIntentGraphFn,
  syncIntentGraphLiveFromStatus as syncIntentGraphLiveFromStatusFn,
  upsertIntentGraphShadowTurns as upsertIntentGraphShadowTurnsFn,
} from "@/lib/readings/intent-graph/queries";
import {
  CLOUD_INTENT_GRAPH_KEY,
  cloudSourceGraphKey,
  intentGraphContentHash,
  intentGraphEtag,
  MAX_INTENT_GRAPH_BYTES,
  validateIntentGraph,
} from "@/lib/readings/intent-types/wire";

/**
 * The `fold_intent_graph` job: fold a project's stored runtime events, received
 * after its fold cursor, into the Cloud-built graph under the reserved key.
 *
 * One page at a time, cursor advanced per page, so a crash mid-backlog resumes
 * where it stopped. A null cursor (first run for a project) seeds from the
 * retention window; that is the same path, not a separate job. After
 * `MAX_PAGES_PER_JOB` pages with backlog left, a fresh job is enqueued so no
 * single run outlives the stale-job reaper or the cron route's time budget.
 *
 * Guardrails: the scratch catalog's sink is discarded, so nothing folded is ever
 * re-ingested; a graph that fails validation or the byte cap is not written and
 * the cursor does not move, so the job errors visibly instead of silently
 * dropping evidence; logs carry counts and rev only, never query text. There is
 * no feature-flag gate: every project with foldable events is folded.
 */

const MAX_PAGES_PER_JOB = 10;
const logger = getLogger("intent-graph/fold-job");

export interface FoldJobDeps {
  /** Runs each page inside one transaction that holds the project row, so two
   * folds of the same project never read the same cursor. */
  db?: Pick<ReturnType<typeof getDb>, "transaction">;
  /** Compaction gates (each page's graph is compacted before it is stored, RC-208); the defaults are production's. Tests shorten the settling time. */
  compactionOptions?: CompactionOptions;
  getCursor: typeof getIntentGraphFoldCursorFn;
  advanceCursor: typeof advanceIntentGraphFoldCursorFn;
  listEvents: typeof listFoldableTraceEventsFn;
  listHits: typeof listTraceEventHitsForEventsFn;
  /** What earlier folds learned from the OTLP traces this page continues. */
  listLastFoldedAsks: typeof listLastFoldedAsksFn;
  getIntentGraph: typeof getIntentGraphFn;
  putIntentGraph: typeof putIntentGraphFn;
  /**
   * Two registries over the project's tool catalog, for Cloud's own with-and-without
   * ranking of each search; null (or absent) skips the comparison and the graph is still
   * built. The match-quality reading supplies it through {@link foldSeams}; the fold never
   * imports that layer.
   */
  loadShadow?: (projectId: string) => Promise<FoldShadow | null>;
  upsertShadowTurns: typeof upsertIntentGraphShadowTurnsFn;
  /** Which graph each runtime ranks from, so its `base_hits` reports land on that graph. */
  listRuntimeStatus: typeof listIntentGraphRuntimeStatusFn;
  /** A graph created by this fold may already have a runtime asking for it. */
  syncLive: typeof syncIntentGraphLiveFromStatusFn;
  enqueueFoldIntentGraphJob: typeof enqueueFoldIntentGraphJobFn;
  trackServerEvent: typeof trackServerEventFn;
  now: () => Date;
  pageLimit: number;
  maxPages: number;
  /** How far behind now() the reader stays; see FOLD_COMMIT_LAG_MS. Tests set 0. */
  commitLagMs?: number;
  /** The store's byte cap on one graph document; see MAX_INTENT_GRAPH_BYTES. Tests shrink it. */
  maxGraphBytes?: number;
}

const defaultDeps: FoldJobDeps = {
  getCursor: getIntentGraphFoldCursorFn,
  advanceCursor: advanceIntentGraphFoldCursorFn,
  listEvents: listFoldableTraceEventsFn,
  listHits: listTraceEventHitsForEventsFn,
  listLastFoldedAsks: listLastFoldedAsksFn,
  getIntentGraph: getIntentGraphFn,
  putIntentGraph: putIntentGraphFn,
  upsertShadowTurns: upsertIntentGraphShadowTurnsFn,
  listRuntimeStatus: listIntentGraphRuntimeStatusFn,
  syncLive: syncIntentGraphLiveFromStatusFn,
  enqueueFoldIntentGraphJob: enqueueFoldIntentGraphJobFn,
  trackServerEvent: trackServerEventFn,
  now: () => new Date(),
  pageLimit: FOLD_PAGE_LIMIT,
  maxPages: MAX_PAGES_PER_JOB,
};

/**
 * The seam a higher reading fills: the shadow replay over the project's tool catalog. Set by
 * the match-quality registration; the fold job reads it per run, so the default registration
 * below needs no import from that layer.
 */
export const foldSeams: Pick<FoldJobDeps, "loadShadow"> = {};

export type FoldJobOutcome = "folded" | "caught_up";

export interface FoldJobResult {
  outcome: FoldJobOutcome;
  pages: number;
  eventsFolded: number;
  /** Of those, how many came from each ingest lane: a runtime's searches and invokes, an agent's asks and tool calls over OpenTelemetry. */
  eventsByLane: Record<FoldLane, number>;
  eventsSkipped: number;
  /** OTLP asks that repeated the trace's previous one, in this run or an earlier one, and were not learned again. */
  eventsRepeated: number;
  /** Events left for the next run because a turn's invoke had not arrived. */
  eventsHeld: number;
  /** Graph revisions gained; each confirmed turn bumps the rev once. */
  revDelta: number;
  rev: number | null;
  clusterCount: number | null;
  /** Clusters the merged graph had before compaction on the last page; equals clusterCount when compaction is off or merged nothing. */
  clustersBeforeCompaction: number | null;
  /** Clusters absorbed by compaction across the job's pages. */
  clustersMerged: number;
  /** True when a follow-up job was enqueued for remaining backlog. */
  continued: boolean;
}

/** Thrown when the folded graph no longer fits the store: the cursor is left
 * untouched so the evidence is not lost, and the job errors visibly. */
export class IntentGraphCapExceededError extends Error {
  constructor(details: readonly string[]) {
    super(`cloud intent graph exceeds the store caps: ${details.join("; ")}`);
    this.name = "IntentGraphCapExceededError";
  }
}

export async function foldProjectIntentGraph(
  projectId: string,
  overrides: Partial<FoldJobDeps> = {},
): Promise<FoldJobResult> {
  const deps = { ...defaultDeps, ...overrides };
  // Resolved lazily: tests never open the pool.
  const db = () => deps.db ?? getDb();
  const startedAt = deps.now();

  let pages = 0;
  let eventsFolded = 0;
  const eventsByLane: Record<FoldLane, number> = { runtime: 0, otlp: 0 };
  let eventsSkipped = 0;
  let eventsRepeated = 0;
  let revDelta = 0;
  let rev: number | null = null;
  let clusterCount: number | null = null;
  let clustersBeforeCompaction: number | null = null;
  let clustersMerged = 0;
  let continued = false;
  let eventsHeld = 0;
  // Built on first use and reused across pages and graphs: registering the
  // catalog is the expensive part, and the graph is attached per fold.
  let shadow: FoldShadow | null | undefined;
  const loadShadow = async (): Promise<FoldShadow | null> => {
    if (shadow !== undefined) return shadow;
    try {
      shadow = deps.loadShadow ? await deps.loadShadow(projectId) : null;
    } catch (error) {
      // The comparison is a bonus: a catalog that cannot be loaded must not stop the graph building.
      logger.error({ err: error, project_id: projectId }, "shadow catalog load failed");
      reportServerException(error, `project:${projectId}`, {
        project_id: projectId,
        operation: "intent_graph_shadow_catalog_load",
      });
      shadow = null;
    }
    return shadow;
  };

  // A runtime that ranks from a Cloud graph reports both rankings on each
  // search it changed; those reports replace the replay on that graph only.
  const graphBySource = new Map<string, string>();
  for (const status of await deps.listRuntimeStatus(projectId)) {
    if (status.status === "active" && status.graphKey !== null)
      graphBySource.set(status.sourceId, status.graphKey);
  }

  while (pages < deps.maxPages) {
    // One page per transaction, under a per-project advisory lock, so a
    // second fold job for the same project (a burst of ingest batches can
    // queue one while another runs) waits here and then reads the advanced
    // cursor instead of folding the same rows a second time. An advisory lock
    // rather than FOR UPDATE on the project row: every trace_events insert
    // takes FOR KEY SHARE on that row through its foreign key, which FOR
    // UPDATE blocks, so ingest for the project would wait out every page.
    const page = await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId}::text))`);
      const cursor = await deps.getCursor(projectId, tx);
      const since: Date | string =
        cursor ?? new Date(deps.now().getTime() - RUNTIME_EVENT_RETENTION_DAYS * 86_400_000);
      const read = await deps.listEvents(projectId, since, tx, deps.pageLimit, deps.commitLagMs);
      if (read.length === 0) return null;
      // A search whose invoke has not arrived yet waits for the next run, so
      // the turn is folded whole. Nothing foldable: leave the cursor alone.
      const { fold: rows, held } = foldablePrefix(read, deps.now().getTime());
      if (rows.length === 0) return { rowCount: read.length, held, merged: null, folded: false };
      const searchIds = rows
        .filter((r) => r.type === "search" || r.type === "skill_search")
        .map((r) => r.id);
      const hits = await deps.listHits(searchIds, tx);
      // An OTLP trace that began before this page: the ask already learned
      // from it, so its repeat here is not learned again. The trace id is the
      // lane's session and turn, so the key is the fold's turn key.
      const continuedTraces = [
        ...new Set(
          rows
            .filter((r) => r.lane === "otlp" && r.type === "search" && r.sessionId)
            .map((r) => r.sessionId!),
        ),
      ];
      const priorAsks = new Map(
        [...(await deps.listLastFoldedAsks(projectId, continuedTraces, cursor, tx))].map(
          ([traceId, ask]) => [turnKey({ sessionId: traceId, turnId: traceId }), ask],
        ),
      );
      // The merged graph learns from every row; each source's own graph from its
      // rows alone. Same learner, same page, so the two stay in step.
      const bySource = new Map<string, FoldableEventRow[]>();
      for (const row of rows) {
        if (row.sourceId === null) continue;
        const list = bySource.get(row.sourceId);
        if (list) list.push(row);
        else bySource.set(row.sourceId, [row]);
      }
      const targets: Array<{ key: string; rows: FoldableEventRow[] }> = [
        { key: CLOUD_INTENT_GRAPH_KEY, rows },
        ...[...bySource].map(([sourceId, sourceRows]) => ({
          key: cloudSourceGraphKey(sourceId),
          rows: sourceRows,
        })),
      ];
      let merged: {
        recorded: number;
        recordedByLane: Record<FoldLane, number>;
        skipped: number;
        repeated: number;
        revDelta: number;
        rev: number;
        clusterCount: number;
        clustersBefore: number;
        clustersMerged: number;
      } | null = null;
      for (const target of targets) {
        const current = await deps.getIntentGraph(projectId, target.key, tx);
        const baseJson = current ? JSON.stringify(current.document) : null;
        const baseRev = current?.rev ?? 0;
        const folded = foldEventsIntoGraph({
          rows: target.rows,
          hits,
          baseJson,
          shadow: (await loadShadow()) ?? undefined,
          reports: { graphKey: target.key, graphBySource },
          priorAsks,
        });
        const document = validateIntentGraph(JSON.parse(folded.json));
        if (!document.ok) throw new IntentGraphCapExceededError(document.details);
        // Compaction is a bonus like the shadow comparison: a merge the SDK
        // rejects stores the page's graph as the learner produced it.
        let graph = document.graph;
        let mergedCount = 0;
        try {
          const compacted = compactIntentGraph(document.graph, deps.compactionOptions);
          const revalidated = validateIntentGraph(compacted.graph);
          if (!revalidated.ok)
            throw new Error(`compacted graph invalid: ${revalidated.details.join("; ")}`);
          graph = revalidated.graph;
          mergedCount = compacted.report.merged;
        } catch (error) {
          logger.error(
            { err: error, project_id: projectId, graph_key: target.key },
            "intent graph compaction failed",
          );
          reportServerException(error, `project:${projectId}`, {
            project_id: projectId,
            graph_key: target.key,
            operation: "intent_graph_compact",
          });
        }
        const json = graph === document.graph ? folded.json : JSON.stringify(graph);
        const byteSize = Buffer.byteLength(json, "utf8");
        const maxBytes = deps.maxGraphBytes ?? MAX_INTENT_GRAPH_BYTES;
        if (byteSize > maxBytes) {
          throw new IntentGraphCapExceededError([`byte_size: exceeds ${maxBytes}`]);
        }
        const put = await deps.putIntentGraph(
          {
            projectId,
            sourceId: target.key,
            graph,
            contentHash: intentGraphContentHash(graph),
            byteSize,
            ifMatch: current ? intentGraphEtag(current.contentHash) : null,
            producer: "cloud",
            now: deps.now(),
          },
          tx,
        );
        if (put.outcome === "stale") {
          throw new Error(`cloud intent graph write was stale at rev ${put.rev}`);
        }
        if (folded.shadowTurns.length > 0) {
          // The graph's live_at as of now, not as of the read before the fold:
          // this fold may have just created the graph a runtime already ranks
          // from, and a turn's live flag is stored once, by the search's time
          // against live_at, so it must see the live_at this page establishes.
          await deps.syncLive(projectId, tx);
          const liveAt = (await deps.getIntentGraph(projectId, target.key, tx))?.liveAt ?? null;
          await deps.upsertShadowTurns(projectId, target.key, folded.shadowTurns, liveAt, tx);
        }
        // The job's figures describe the merged graph; per-source graphs ride along.
        if (target.key === CLOUD_INTENT_GRAPH_KEY) {
          merged = {
            recorded: folded.recorded,
            recordedByLane: folded.recordedByLane,
            skipped: folded.skipped,
            repeated: folded.repeated,
            revDelta: Math.max(0, put.rev - baseRev),
            rev: put.rev,
            clusterCount: graph.intents.length,
            clustersBefore: folded.clusterCount,
            clustersMerged: mergedCount,
          };
        }
      }
      // A page with no shadow turns (no catalog) still records a graph a runtime asked for.
      await deps.syncLive(projectId, tx);
      const last = rows[rows.length - 1];
      if (last) await deps.advanceCursor(projectId, last.receivedAtRaw, tx);
      return { rowCount: read.length, held, merged, folded: true };
    });
    if (page === null) break;
    eventsHeld = page.held;
    if (!page.folded) break;
    pages += 1;
    if (page.merged) {
      eventsFolded += page.merged.recorded;
      eventsByLane.runtime += page.merged.recordedByLane.runtime;
      eventsByLane.otlp += page.merged.recordedByLane.otlp;
      eventsSkipped += page.merged.skipped;
      eventsRepeated += page.merged.repeated;
      revDelta += page.merged.revDelta;
      rev = page.merged.rev;
      clusterCount = page.merged.clusterCount;
      clustersBeforeCompaction = page.merged.clustersBefore;
      clustersMerged += page.merged.clustersMerged;
    }
    // Rows read, not rows folded: a held tail means there is nothing more to do now.
    if (page.rowCount < deps.pageLimit || page.held > 0) break;
  }

  if (pages >= deps.maxPages) {
    continued = (await deps.enqueueFoldIntentGraphJob(projectId)) !== null;
  }

  const outcome: FoldJobOutcome = pages === 0 ? "caught_up" : "folded";
  const durationMs = Math.max(0, deps.now().getTime() - startedAt.getTime());
  logger.info(
    {
      project_id: projectId,
      outcome,
      pages,
      events_folded: eventsFolded,
      events_runtime: eventsByLane.runtime,
      events_otlp: eventsByLane.otlp,
      events_skipped: eventsSkipped,
      events_repeated: eventsRepeated,
      events_held: eventsHeld,
      rev_delta: revDelta,
      rev,
      cluster_count: clusterCount,
      clusters_before_compaction: clustersBeforeCompaction,
      clusters_merged: clustersMerged,
      continued,
      duration_ms: durationMs,
    },
    "intent graph fold completed",
  );
  await deps.trackServerEvent(
    "intent_graph_folded",
    { distinctId: "system:intent-graph-fold", projectId },
    {
      object_action: "intent_graph_folded",
      project_id: projectId,
      outcome,
      pages,
      events_folded: eventsFolded,
      events_runtime: eventsByLane.runtime,
      events_otlp: eventsByLane.otlp,
      events_skipped: eventsSkipped,
      events_repeated: eventsRepeated,
      events_held: eventsHeld,
      rev_delta: revDelta,
      rev,
      cluster_count: clusterCount,
      clusters_before_compaction: clustersBeforeCompaction,
      clusters_merged: clustersMerged,
      continued,
      duration_ms: durationMs,
    },
  );

  return {
    outcome,
    pages,
    eventsFolded,
    eventsByLane,
    eventsSkipped,
    eventsRepeated,
    eventsHeld,
    revDelta,
    rev,
    clusterCount,
    clustersBeforeCompaction,
    clustersMerged,
    continued,
  };
}

/**
 * The cron drain's safety net: enqueue a fold for every project that has
 * unfolded events and no queued fold. Normal traffic never needs this; it only
 * recovers a post-response kick that was lost.
 */
export async function enqueueDueIntentGraphFolds(
  overrides: Partial<
    Pick<FoldJobDeps, "enqueueFoldIntentGraphJob"> & {
      listProjectsWithUnfoldedEvents: typeof listProjectsWithUnfoldedEventsFn;
    }
  > = {},
): Promise<{ enqueued: number }> {
  const deps = {
    enqueueFoldIntentGraphJob: enqueueFoldIntentGraphJobFn,
    listProjectsWithUnfoldedEvents: listProjectsWithUnfoldedEventsFn,
    ...overrides,
  };
  const candidates = await deps.listProjectsWithUnfoldedEvents(undefined, {
    retentionDays: RUNTIME_EVENT_RETENTION_DAYS,
  });
  let enqueued = 0;
  for (const { id } of candidates) {
    if ((await deps.enqueueFoldIntentGraphJob(id)) !== null) enqueued += 1;
  }
  return { enqueued };
}
