import { RUNTIME_EVENT_RETENTION_DAYS } from "@/lib/ingest/trace-events/maintenance";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  reportServerException,
  trackServerEvent as trackServerEventFn,
} from "@/lib/platform/telemetry";
import {
  type ActionContext,
  buildActionContext,
  keyVocabulary,
  memberKey,
  parseLlmKey,
} from "@/lib/readings/intent-engine/actions";
import {
  type CatalogTool,
  loadCatalogTools as loadCatalogToolsFn,
} from "@/lib/readings/intent-engine/catalog";
import { compactEngine, type EngineCompactionOptions } from "@/lib/readings/intent-engine/compact";
import { type EngineEventRow, foldAsks } from "@/lib/readings/intent-engine/engine";
import { enqueueClusterIntentsJob as enqueueClusterIntentsJobFn } from "@/lib/readings/intent-engine/jobs";
import { buildLevels } from "@/lib/readings/intent-engine/levels";
import type { MatchThresholds } from "@/lib/readings/intent-engine/match";
import type { NamedLevel } from "@/lib/readings/intent-engine/names";
import {
  applyCachedIntentNames,
  cachedClusterKey,
  cachedClusterName,
  defaultNameDeps,
  emptyNameResult,
  loadNameCache,
  NAME_INTERVAL_MS,
  type NameCandidate,
  type NameJobDeps,
  type NameJobResult,
  nameCandidates,
  nameEngineClusters,
} from "@/lib/readings/intent-engine/names-job";
import { distinguishingTerms, medoid } from "@/lib/readings/intent-engine/naming";
import { seedState } from "@/lib/readings/intent-engine/seed";
import {
  applyMerges,
  boundEngineTransaction,
  CLUSTER_LOAD_LIMIT,
  claimNamingSlot,
  type EngineDb,
  getEngineState,
  insertAssignments,
  listAssignedEvents,
  loadActiveClusters,
  loadCloudGraphs,
  loadLevelNodes,
  loadSeedQueryIntents,
  saveClusters,
  saveEngineState,
  saveLevels,
  tryEngineLock,
} from "@/lib/readings/intent-engine/store";
import { VerbLexicon } from "@/lib/readings/intent-engine/text";
import { foldablePrefix, turnKey } from "@/lib/readings/intent-graph/fold";
import {
  type FoldableEventRow,
  listFoldableTraceEvents as listFoldableTraceEventsFn,
  listLastFoldedAsks as listLastFoldedAsksFn,
  listTraceEventHitsForEvents as listTraceEventHitsForEventsFn,
  USER_MESSAGE_EVENT_TYPE,
} from "@/lib/readings/intent-graph/queries";
import type {
  EngineCluster,
  EngineMerge,
  LevelTree,
} from "@/lib/readings/intent-types/engine-types";

/**
 * The `cluster_intents` job: run a project's new asks through the intent
 * engine, page by page, then compact, rebuild the levels and name once.
 *
 * Its own cursor and its own advisory lock, so it runs beside the intent-graph
 * fold without moving it. The lock is tried, never waited on: a run that
 * finds another one working on the project stops (`busy`) instead of holding
 * a pool connection, and every engine transaction carries statement and lock
 * timeouts. A first run seeds from the project's Cloud-built
 * graphs and recurring asks, then reads the retention window. Each page is one
 * transaction: assignments, cluster rows and the cursor move together, so a
 * crash resumes cleanly.
 *
 * Bounded: at most {@link MAX_PAGES_PER_JOB} pages of {@link ENGINE_PAGE_LIMIT}
 * events and {@link TIME_BUDGET_MS} of paging per run (a backlog continues in
 * a queued follow-up), at most `CLUSTER_LOAD_LIMIT` clusters read per page,
 * and level writes only where something changed. The engine never serves a
 * runtime and writes no Intents rows: what it builds is read under our Intents
 * by `./breakdown.ts`. Logs and events carry counts only, never ask text.
 */

/**
 * Events one page reads. Smaller than the graph fold's page on purpose: a
 * page's fold is synchronous CPU on the web process, about 2 s at 5,000
 * events in the worst case measured, and the event loop is only released
 * between pages (each page awaits its transaction). At 1,000 a page blocks
 * for a fraction of a second.
 */
export const ENGINE_PAGE_LIMIT = 1_000;
/** Pages one run folds at most (as many events as ten graph-fold pages); a backlog continues in a queued follow-up. */
export const MAX_PAGES_PER_JOB = 50;
/** Paging stops after this long; the next run continues. */
export const TIME_BUDGET_MS = 2 * 60_000;
const SEED_QUERY_INTENTS = 5_000;
const SYSTEM_DISTINCT_ID = "system:intent-engine";
const logger = getLogger("intent-engine/job");

/**
 * How the engine reads asks, with flags retired: code defaults, measured with
 * `scripts/compare-intent-engine.mts` on 504 judged searches from a labelled production catalog and the
 * 1,500 labelled Site Copilot turns. Scripts and tests override them per run.
 */
export const ENGINE_DEFAULTS = {
  /**
   * Read each ask as intent frames: an ask that wants several things is
   * placed once per action ("Also wants" in the breakdown), and level 1 is
   * keyed by action and object. Level-1 F1 15% to 48% on that catalog, 39% to 51%
   * on Site Copilot, with no two labelled intents merged into one.
   */
  frames: true,
  /**
   * Let the model also key query clusters (action, object) when naming. Off:
   * the keys need every query cluster named (ten times the calls), and #264
   * measured them trading precision for recall (80% to 58%), the merge risk.
   */
  llmKeys: false,
  /**
   * Seed a project's first run from its Cloud-built graphs and recurring asks.
   * Off: seeding keeps wire ids for serving a graph from the engine, which is
   * deferred (ADR-0014); here it would only add old, assignment-less clusters.
   */
  seed: false,
} as const;

export interface IntentEngineJobDeps {
  db?: EngineDb;
  frames: boolean;
  llmKeys: boolean;
  seed: boolean;
  /** The naming step's collaborators, read once per run: no key, no call. */
  nameDeps: () => NameJobDeps;
  listEvents: typeof listFoldableTraceEventsFn;
  listHits: typeof listTraceEventHitsForEventsFn;
  listLastFoldedAsks: typeof listLastFoldedAsksFn;
  /** The project's tools: their names are the engine's vocabulary of actions and objects. */
  loadCatalogTools: typeof loadCatalogToolsFn;
  enqueueClusterIntentsJob: typeof enqueueClusterIntentsJobFn;
  trackServerEvent: typeof trackServerEventFn;
  now: () => Date;
  pageLimit: number;
  maxPages: number;
  timeBudgetMs: number;
  clusterLimit: number;
  commitLagMs?: number;
  thresholds?: MatchThresholds;
  compactionOptions?: EngineCompactionOptions;
}

const defaultDeps = (): IntentEngineJobDeps => ({
  frames: ENGINE_DEFAULTS.frames,
  llmKeys: ENGINE_DEFAULTS.llmKeys,
  seed: ENGINE_DEFAULTS.seed,
  nameDeps: () => defaultNameDeps(),
  listEvents: listFoldableTraceEventsFn,
  listHits: listTraceEventHitsForEventsFn,
  listLastFoldedAsks: listLastFoldedAsksFn,
  loadCatalogTools: (projectId) => loadCatalogToolsFn(projectId),
  enqueueClusterIntentsJob: enqueueClusterIntentsJobFn,
  trackServerEvent: trackServerEventFn,
  now: () => new Date(),
  pageLimit: ENGINE_PAGE_LIMIT,
  maxPages: MAX_PAGES_PER_JOB,
  timeBudgetMs: TIME_BUDGET_MS,
  clusterLimit: CLUSTER_LOAD_LIMIT,
});

export type IntentEngineOutcome = "clustered" | "caught_up" | "busy";

export interface IntentEngineJobResult {
  outcome: IntentEngineOutcome;
  pages: number;
  seeded: boolean;
  asks: number;
  assignments: number;
  clustersCreated: number;
  split: number;
  contained: number;
  merged: number;
  /** Level-0 clusters the run worked on. */
  clusters: number;
  /** Level-1 intents ("What they ask for") after the run. */
  intents: number;
  levels: number;
  /** True when the project holds more level-0 clusters than a run reads. */
  capped: boolean;
  /** Another run held the project's lock, so this one stopped there. */
  busy: boolean;
  frames: boolean;
  keys: boolean;
  naming: NameJobResult;
  /** Whether the page budget or the time budget stopped the run and a follow-up was queued. */
  continued: boolean;
}

export async function runIntentEngine(
  projectId: string,
  overrides: Partial<IntentEngineJobDeps> = {},
): Promise<IntentEngineJobResult> {
  const deps = { ...defaultDeps(), ...overrides };
  const db = (): EngineDb => deps.db ?? getDb();
  const startedAt = deps.now();
  const result: IntentEngineJobResult = {
    outcome: "caught_up",
    pages: 0,
    seeded: false,
    asks: 0,
    assignments: 0,
    clustersCreated: 0,
    split: 0,
    contained: 0,
    merged: 0,
    clusters: 0,
    intents: 0,
    levels: 0,
    capped: false,
    busy: false,
    frames: deps.frames,
    keys: deps.llmKeys,
    naming: emptyNameResult(),
    continued: false,
  };
  try {
    await run(projectId, deps, db, result, startedAt);
  } catch (err) {
    logger.error({ err, project_id: projectId, pages: result.pages }, "intent engine run failed");
    throw err;
  }
  const fields = {
    project_id: projectId,
    outcome: result.outcome,
    pages: result.pages,
    seeded: result.seeded,
    asks: result.asks,
    assignments: result.assignments,
    clusters_created: result.clustersCreated,
    asks_split: result.split,
    asks_contained: result.contained,
    clusters_merged: result.merged,
    cluster_count: result.clusters,
    intent_count: result.intents,
    levels: result.levels,
    capped: result.capped,
    busy: result.busy,
    frames: result.frames,
    keys: result.keys,
    named: result.naming.named,
    continued: result.continued,
    duration_ms: Math.max(0, deps.now().getTime() - startedAt.getTime()),
  };
  logger.info(fields, "intent engine run completed");
  await deps.trackServerEvent(
    "intent_engine_clustered",
    { distinctId: SYSTEM_DISTINCT_ID, projectId },
    { object_action: "intent_engine_clustered", ...fields },
  );
  return result;
}

/** Bound the transaction and take the project's lock; false when another run holds it. */
async function enter(tx: EngineDb, projectId: string): Promise<boolean> {
  await boundEngineTransaction(tx);
  return tryEngineLock(tx, projectId);
}

const isMessage = (row: Pick<FoldableEventRow, "type">) =>
  (row.type as string) === USER_MESSAGE_EVENT_TYPE;

async function run(
  projectId: string,
  deps: IntentEngineJobDeps,
  db: () => EngineDb,
  result: IntentEngineJobResult,
  startedAt: Date,
): Promise<void> {
  // Once per run: the catalog changes far more slowly than a job runs.
  const catalog = await deps.loadCatalogTools(projectId);
  const catalogIds = catalog.map((t) => t.name);
  let outOfTime = false;

  while (result.pages < deps.maxPages) {
    if (deps.now().getTime() - startedAt.getTime() >= deps.timeBudgetMs) {
      outOfTime = true;
      break;
    }
    const page = await db().transaction(async (raw) => {
      const tx = raw as unknown as EngineDb;
      if (!(await enter(tx, projectId))) return "busy" as const;
      let state = await getEngineState(projectId, tx);
      if (!state?.seededAt) {
        const now = deps.now();
        const seeded = deps.seed
          ? seedState({
              ...(await loadCloudGraphs(projectId, tx)),
              queryIntents: await loadSeedQueryIntents(projectId, SEED_QUERY_INTENTS, tx),
              now: now.getTime(),
            })
          : { clusters: [], nextGraphN: 0 };
        await saveClusters(projectId, seeded.clusters, tx);
        await saveEngineState(projectId, { seededAt: now, nextGraphN: seeded.nextGraphN }, tx);
        state = {
          cursor: state?.cursor ?? null,
          nextGraphN: seeded.nextGraphN,
          seededAt: now,
          namedAt: state?.namedAt ?? null,
        };
        result.seeded = true;
      }
      const since: Date | string =
        state.cursor ?? new Date(deps.now().getTime() - RUNTIME_EVENT_RETENTION_DAYS * 86_400_000);
      const read = await deps.listEvents(projectId, since, tx, deps.pageLimit, deps.commitLagMs, {
        userMessages: true,
      });
      const pageRows = read.filter((r) => !isMessage(r)).length;
      if (pageRows === 0) return null;
      const { fold, held } = foldablePrefix(read, deps.now().getTime());
      // The cursor moves past the fold's own rows only; a user message never moves it.
      const last = fold.findLast((r) => !isMessage(r));
      if (!last) return { pageRows, held, folded: false as const };
      // A message read on an earlier page is placed once; one whose turn is held waits for it.
      const turnsHere = new Set(fold.filter((r) => !isMessage(r)).map(turnKey));
      const messageIds = fold.filter(isMessage).map((r) => r.id);
      const placed =
        messageIds.length > 0 ? await listAssignedEvents(messageIds, tx) : new Set<string>();
      const rows = fold.filter(
        (r) => !isMessage(r) || (!placed.has(r.id) && turnsHere.has(turnKey(r))),
      );

      const hits = await deps.listHits(
        rows.filter((r) => r.type === "search" || r.type === "skill_search").map((r) => r.id),
        tx,
      );
      const traces = [
        ...new Set(
          rows
            .filter((r) => r.lane === "otlp" && r.type === "search" && r.sessionId)
            .map((r) => r.sessionId!),
        ),
      ];
      const priorAsks = new Map(
        [...(await deps.listLastFoldedAsks(projectId, traces, state.cursor, tx))].map(
          ([traceId, ask]) => [turnKey({ sessionId: traceId, turnId: traceId }), ask],
        ),
      );
      const active = await loadActiveClusters(projectId, tx, deps.clusterLimit);
      const out = foldAsks({
        state: { clusters: active.clusters, nextGraphN: state.nextGraphN },
        rows: rows.map(toEngineRow),
        hits,
        priorAsks,
        catalogIds,
        thresholds: deps.thresholds,
        frames: deps.frames,
        now: deps.now().getTime(),
      });
      await saveClusters(
        projectId,
        out.state.clusters.filter((c) => c.dirty),
        tx,
      );
      const inserted = await insertAssignments(projectId, out.assignments, tx);
      await saveEngineState(
        projectId,
        { cursor: last.receivedAtRaw, nextGraphN: out.state.nextGraphN },
        tx,
      );
      return {
        pageRows,
        held,
        folded: true as const,
        stats: out.stats,
        inserted,
        capped: active.capped,
      };
    });
    if (page === "busy") {
      result.busy = true;
      break;
    }
    if (page === null || !page.folded) break;
    result.pages += 1;
    result.asks += page.stats.asks;
    result.assignments += page.inserted;
    result.clustersCreated += page.stats.created;
    result.split += page.stats.split;
    result.contained += page.stats.contained;
    result.capped ||= page.capped;
    if (page.pageRows < deps.pageLimit || page.held > 0) break;
  }

  if ((result.pages > 0 || result.seeded) && !result.busy) {
    const nameDeps = deps.nameDeps();
    const state = await getEngineState(projectId, db());
    const due =
      nameDeps.complete !== null &&
      nameDeps.maxNames > 0 &&
      (!state?.namedAt || deps.now().getTime() - state.namedAt.getTime() >= NAME_INTERVAL_MS);
    const levels: NamedLevel[] = deps.llmKeys ? [0, 1] : [1];
    // Compaction, labels and levels: once per run, not per page. The settle gate
    // cannot pass inside one run, and the hierarchy only needs the final clusters.
    const maintained = await maintainLocked(projectId, db, deps, catalog, due ? levels : []);
    if (maintained === null) {
      result.busy = true;
    } else {
      result.merged = maintained.merges.length;
      result.clusters = maintained.clusters;
      result.intents = maintained.intents;
      result.levels = maintained.levels;
      result.capped ||= maintained.capped;
      // The hour's pass is claimed before any call: one run pays, and a pass that fails is not paid twice.
      if (
        due &&
        maintained.candidates.length > 0 &&
        (await claimNamingSlot(projectId, deps.now(), NAME_INTERVAL_MS, db()))
      ) {
        result.naming = await nameClusters(
          projectId,
          db,
          deps,
          nameDeps,
          catalog,
          maintained.candidates,
        );
        // New keys regroup the levels now, not on the next run, and the regrouped intents take their names within the cap.
        if (deps.llmKeys && result.naming.keyedClusters > 0) {
          const regrouped = await maintainLocked(projectId, db, deps, catalog, [1]);
          if (regrouped) {
            result.intents = regrouped.intents;
            result.levels = regrouped.levels;
            const rest = {
              ...nameDeps,
              maxNames: Math.max(0, nameDeps.maxNames - result.naming.named),
            };
            if (rest.maxNames > 0)
              result.naming = addNames(
                result.naming,
                await nameClusters(projectId, db, deps, rest, catalog, regrouped.candidates),
              );
          }
        }
      }
    }
  }

  if (result.pages >= deps.maxPages || outOfTime) {
    result.continued = (await deps.enqueueClusterIntentsJob(projectId)) !== null;
  }
  result.outcome = result.pages > 0 ? "clustered" : result.busy ? "busy" : "caught_up";
}

function addNames(a: NameJobResult, b: NameJobResult): NameJobResult {
  return {
    candidates: a.candidates + b.candidates,
    named: a.named + b.named,
    keyedClusters: a.keyedClusters + b.keyedClusters,
    calls: a.calls + b.calls,
    failedCalls: a.failedCalls + b.failedCalls,
    cutOffCalls: a.cutOffCalls + b.cutOffCalls,
    declinedCalls: a.declinedCalls + b.declinedCalls,
    unusableCalls: a.unusableCalls + b.unusableCalls,
    skipped: a.skipped ?? b.skipped,
  };
}

/** The model naming step, isolated: a failure is logged and reported, never fatal to the run. */
async function nameClusters(
  projectId: string,
  db: () => EngineDb,
  deps: IntentEngineJobDeps,
  nameDeps: NameJobDeps,
  catalog: readonly CatalogTool[],
  candidates: readonly NameCandidate[],
): Promise<NameJobResult> {
  if (candidates.length === 0) return emptyNameResult();
  const withKeys: NameJobDeps = { ...nameDeps };
  if (deps.llmKeys && !withKeys.keys) {
    // The model also keys each query cluster, from the catalog's actions and things.
    const verbs = new VerbLexicon();
    for (const t of catalog) verbs.learnTool(t.name);
    const ctx = buildActionContext(catalog, verbs);
    withKeys.keys = { vocabulary: keyVocabulary(ctx), parse: (raw) => parseLlmKey(raw, ctx) };
  }
  try {
    const named = await nameEngineClusters(projectId, db(), withKeys, candidates);
    const counts = {
      candidates: named.candidates,
      named: named.named,
      keyed_clusters: named.keyedClusters,
      calls: named.calls,
      failed_calls: named.failedCalls,
      cut_off_calls: named.cutOffCalls,
      declined_calls: named.declinedCalls,
      unusable_calls: named.unusableCalls,
    };
    logger.info(
      { project_id: projectId, model: withKeys.model, skipped: named.skipped, ...counts },
      "intent engine clusters named",
    );
    if (named.calls > 0) {
      await deps.trackServerEvent(
        "intent_engine_named",
        { distinctId: SYSTEM_DISTINCT_ID, projectId },
        { object_action: "intent_engine_named", model: withKeys.model, ...counts },
      );
    }
    return named;
  } catch (err) {
    logger.error({ err, project_id: projectId }, "intent engine naming failed");
    reportServerException(err, `project:${projectId}`, { operation: "intent_engine_names" });
    return { ...emptyNameResult(), failedCalls: 1 };
  }
}

const keyOfMember = (ctx: ActionContext) => (member: string) => memberKey(member, ctx);

interface Maintained {
  merges: EngineMerge[];
  clusters: number;
  intents: number;
  levels: number;
  capped: boolean;
  candidates: NameCandidate[];
}

/** {@link maintain} in its own transaction under the engine's lock; null when another run holds it. */
function maintainLocked(
  projectId: string,
  db: () => EngineDb,
  deps: IntentEngineJobDeps,
  catalog: readonly CatalogTool[],
  nameLevels: readonly NamedLevel[],
): Promise<Maintained | null> {
  return db().transaction(async (raw) => {
    const tx = raw as unknown as EngineDb;
    if (!(await enter(tx, projectId))) return null;
    return maintain(projectId, tx, deps, catalog, nameLevels);
  });
}

/**
 * Compact, relabel and rebuild the levels; with `nameLevels`, also list what
 * the naming step should name, from the clusters and hierarchy in hand.
 */
async function maintain(
  projectId: string,
  tx: EngineDb,
  deps: IntentEngineJobDeps,
  catalog: readonly CatalogTool[],
  nameLevels: readonly NamedLevel[],
): Promise<Maintained> {
  const now = deps.now().getTime();
  const active = await loadActiveClusters(projectId, tx, deps.clusterLimit);
  const { clusters, merges } = compactEngine(active.clusters, now, deps.compactionOptions);
  await applyMerges(projectId, merges, tx);

  // Model-written names stand, whether or not this run may call the model.
  const names = await loadNameCache(projectId, tx);
  relabel(clusters, (c) => cachedClusterName(names, c));
  await saveClusters(
    projectId,
    clusters.filter((c) => c.dirty),
    tx,
  );

  // The catalog's actions and objects first, then the tools the asks' turns ran.
  const verbs = new VerbLexicon();
  for (const t of catalog) verbs.learnTool(t.name);
  const toolIdsOf = (c: EngineCluster) =>
    Object.keys(c.usage)
      .filter((k) => k.startsWith("tool:"))
      .map((k) => k.slice("tool:".length));
  for (const c of clusters) for (const id of toolIdsOf(c)) verbs.learnTool(id);
  const prior = await loadLevelNodes(projectId, tx);
  // With frames, level 1 is keyed by action and object: the model's key for a
  // cluster when it has one (model keys on), else the rules' from the catalog.
  const tree: LevelTree = buildLevels(
    clusters.map((c) => ({
      uuid: c.uuid,
      members: c.members,
      weight: c.asks,
      tools: toolIdsOf(c),
      llmKey: deps.llmKeys ? (cachedClusterKey(names, c) ?? undefined) : undefined,
    })),
    prior,
    verbs,
    deps.frames ? { keyOf: keyOfMember(buildActionContext(catalog, verbs)) } : {},
  );
  applyCachedIntentNames(tree, names);
  await saveLevels(projectId, tree, prior, clusters, tx);
  const candidates =
    nameLevels.length > 0
      ? nameCandidates(tree, clusters, names, { levels: nameLevels, keyed: deps.llmKeys })
      : [];
  return {
    merges,
    clusters: clusters.length,
    intents: tree.levels[1]?.length ?? 0,
    levels: tree.levels.length - 1,
    capped: active.capped,
    candidates,
  };
}

/** Level-0 names: the medoid member, and the terms that set a cluster apart. Marks changed ones dirty. */
function relabel(clusters: EngineCluster[], nameOf?: (c: EngineCluster) => string | null): void {
  const terms = distinguishingTerms(clusters.map((c) => c.members));
  clusters.forEach((c, i) => {
    const label = nameOf?.(c) || medoid(c.members) || c.label;
    if (label !== c.label || terms[i].join("\u0000") !== c.terms.join("\u0000")) {
      c.label = label;
      c.terms = terms[i];
      c.dirty = true;
    }
  });
}

function toEngineRow(row: FoldableEventRow): EngineEventRow {
  return {
    id: row.id,
    type: row.type as EngineEventRow["type"],
    lane: row.lane,
    sessionId: row.sessionId,
    turnId: row.turnId,
    sourceId: row.sourceId,
    query: row.query,
    toolId: row.toolId,
    skillId: row.skillId,
    receivedAt: row.receivedAt,
    occurredAt: row.occurredAt ?? null,
    traceId: row.traceId ?? null,
    endUserId: row.endUserId ?? null,
  };
}
