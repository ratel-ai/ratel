import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { jobs } from "@/lib/jobs/schema";
import { getDb } from "@/lib/platform/db/client";
import { queryIntents } from "@/lib/readings/query-intents/schema";
import {
  type NewToolExplorerEdgeRow,
  type NewToolExplorerIntentToolRow,
  type NewToolExplorerSetRow,
  type ToolExplorerRunRow,
  toolExplorerEdges,
  toolExplorerIntentTools,
  toolExplorerRuns,
  toolExplorerSets,
} from "@/lib/readings/tool-explorer/schema";
import { ALWAYS_TOGETHER_LOW } from "@/lib/readings/tool-explorer/thresholds";
import type {
  ExplorerEdge,
  ExplorerEdgeKind,
  ExplorerScope,
  ExplorerSet,
  ExplorerSubject,
  ExplorerSummary,
  IntentToolShare,
} from "@/lib/readings/tool-explorer/types";

/**
 * The database side of the Tool Explorer: the run lifecycle, the
 * one-transaction persist, the coalesced job enqueue, and the typed reads the
 * page, the MCP tools and the Crafter consume. Every function takes an
 * injectable `db`. Reads address one explorer run, the project's latest
 * completed one unless the caller names it; the ledger itself is read in
 * `ledger.ts`.
 */

export type ExplorerDb = ReturnType<typeof getDb>;

export type ExplorerTrigger = "chained" | "manual";
export const EXPLORE_JOB_KIND = "explore_tool_usage";
const LIVE_STATUSES = ["queued", "running"] as const;
const INSERT_CHUNK = 500;

// --- jobs ---------------------------------------------------------------------

/**
 * Enqueue an `explore_tool_usage` job, coalesced by the partial unique index
 * `jobs_explore_tool_usage_queued_idx` (one queued per project): returns null
 * when one is already waiting.
 */
export async function enqueueExploreJob(
  projectId: string,
  trigger: ExplorerTrigger,
  signalRunId: string | null = null,
  db: Pick<ExplorerDb, "insert"> = getDb(),
): Promise<{ id: string } | null> {
  const rows = await db
    .insert(jobs)
    .values({
      projectId,
      kind: EXPLORE_JOB_KIND,
      status: "queued",
      payload: { trigger, signalRunId },
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0] ?? null;
}

// --- runs ---------------------------------------------------------------------

export interface StartExplorerRunInput {
  projectId: string;
  trigger: ExplorerTrigger;
  windowDays: number;
  windowStart: Date;
  windowEnd: Date;
  signalRunId: string | null;
}

/** Insert a running run, or null when the project already has a live one. */
export async function startExplorerRun(
  input: StartExplorerRunInput,
  db: Pick<ExplorerDb, "insert"> = getDb(),
  now: Date = new Date(),
): Promise<ToolExplorerRunRow | null> {
  const [row] = await db
    .insert(toolExplorerRuns)
    .values({ ...input, status: "running", startedAt: now, createdAt: now })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Fail live runs that started before `before`: a crashed job must not block the project forever. */
export async function reapStaleExplorerRuns(
  projectId: string,
  before: Date,
  db: Pick<ExplorerDb, "update"> = getDb(),
  now: Date = new Date(),
): Promise<number> {
  const reaped = await db
    .update(toolExplorerRuns)
    .set({ status: "failed", error: "stale", finishedAt: now })
    .where(
      and(
        eq(toolExplorerRuns.projectId, projectId),
        inArray(toolExplorerRuns.status, [...LIVE_STATUSES]),
        lt(sql`coalesce(${toolExplorerRuns.startedAt}, ${toolExplorerRuns.createdAt})`, before),
      ),
    )
    .returning({ id: toolExplorerRuns.id });
  return reaped.length;
}

export async function failExplorerRun(
  runId: string,
  error: string,
  db: Pick<ExplorerDb, "update"> = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(toolExplorerRuns)
    .set({ status: "failed", error: error.slice(0, 2_000), finishedAt: now })
    .where(eq(toolExplorerRuns.id, runId));
}

/** The project's latest run of any status, or of the given one. */
export async function latestExplorerRun(
  projectId: string,
  db: Pick<ExplorerDb, "select"> = getDb(),
  status?: "completed",
): Promise<ToolExplorerRunRow | null> {
  const [row] = await db
    .select()
    .from(toolExplorerRuns)
    .where(
      and(
        eq(toolExplorerRuns.projectId, projectId),
        status ? eq(toolExplorerRuns.status, status) : undefined,
      ),
    )
    .orderBy(desc(toolExplorerRuns.createdAt))
    .limit(1);
  return row ?? null;
}

// --- persist -------------------------------------------------------------------

export interface PersistExplorerInput {
  runId: string;
  projectId: string;
  edges: readonly ExplorerEdge[];
  sets: readonly ExplorerSet[];
  intentTools?: readonly IntentToolShare[];
  summary: ExplorerSummary;
  turnsScanned: number;
  sessionsScanned: number;
  turnsWithIntents?: number;
  now: Date;
}

function edgeRow(input: PersistExplorerInput, edge: ExplorerEdge): NewToolExplorerEdgeRow {
  return {
    runId: input.runId,
    projectId: input.projectId,
    scope: edge.scope,
    kind: edge.kind,
    subject: edge.subject,
    a: edge.a,
    b: edge.b,
    n: edge.n,
    nA: edge.nA,
    p: edge.p,
    pLow: edge.pLow,
    pHigh: edge.pHigh,
    lift: edge.lift,
    reverseN: edge.reverseN,
    exampleSessions: [...edge.exampleSessions],
    timedPairs: edge.timing?.pairs ?? null,
    betweenMsTotal: edge.timing?.betweenMsTotal ?? null,
    betweenMsMedian: edge.timing?.betweenMsMedian ?? null,
    searchesBetween: edge.timing?.searchesBetween ?? null,
  };
}

function setRow(input: PersistExplorerInput, set: ExplorerSet): NewToolExplorerSetRow {
  return {
    runId: input.runId,
    projectId: input.projectId,
    scope: set.scope,
    subject: set.subject,
    key: set.key,
    items: [...set.items],
    size: set.size,
    support: set.support,
    share: set.share,
    jaccard: set.jaccard,
    jaccardLow: set.jaccardLow,
    pAb: set.pAb,
    pBa: set.pBa,
    workflowId: set.workflowId,
    exampleSessions: [...set.exampleSessions],
  };
}

function intentToolRow(
  input: PersistExplorerInput,
  share: IntentToolShare,
): NewToolExplorerIntentToolRow {
  return {
    runId: input.runId,
    projectId: input.projectId,
    scope: share.scope,
    intentId: share.intentId,
    intentUnits: share.intentUnits,
    toolId: share.toolId,
    n: share.n,
    share: share.share,
    shareLow: share.shareLow,
  };
}

/**
 * Persist a finished run in one transaction: write its edge and set rows,
 * mark it completed, and delete the project's earlier completed runs (their
 * rows cascade), so the fact tables hold one run per project.
 */
export async function persistExplorerRun(
  input: PersistExplorerInput,
  db: Pick<ExplorerDb, "transaction"> = getDb(),
): Promise<void> {
  await db.transaction(async (tx) => {
    for (let i = 0; i < input.edges.length; i += INSERT_CHUNK) {
      await tx
        .insert(toolExplorerEdges)
        .values(input.edges.slice(i, i + INSERT_CHUNK).map((e) => edgeRow(input, e)));
    }
    for (let i = 0; i < input.sets.length; i += INSERT_CHUNK) {
      await tx
        .insert(toolExplorerSets)
        .values(input.sets.slice(i, i + INSERT_CHUNK).map((s) => setRow(input, s)));
    }
    const intentTools = input.intentTools ?? [];
    for (let i = 0; i < intentTools.length; i += INSERT_CHUNK) {
      await tx
        .insert(toolExplorerIntentTools)
        .values(intentTools.slice(i, i + INSERT_CHUNK).map((s) => intentToolRow(input, s)));
    }
    await tx
      .update(toolExplorerRuns)
      .set({
        status: "completed",
        summary: input.summary as unknown as Record<string, unknown>,
        turnsScanned: input.turnsScanned,
        sessionsScanned: input.sessionsScanned,
        turnsWithIntents: input.turnsWithIntents ?? 0,
        finishedAt: input.now,
      })
      .where(eq(toolExplorerRuns.id, input.runId));
    await tx
      .delete(toolExplorerRuns)
      .where(
        and(
          eq(toolExplorerRuns.projectId, input.projectId),
          eq(toolExplorerRuns.status, "completed"),
          ne(toolExplorerRuns.id, input.runId),
        ),
      );
  });
}

// --- reads ----------------------------------------------------------------------

export interface TransitionFilter {
  /** Read this run instead of resolving the project's latest completed one. */
  runId?: string;
  scope: ExplorerScope;
  kind: ExplorerEdgeKind;
  subject?: ExplorerSubject;
  /** Only edges leaving this id. */
  from?: string;
  /** Only edges arriving at this id. */
  to?: string;
  minN?: number;
  limit?: number;
}

export interface CousageFilter {
  /** Read this run instead of resolving the project's latest completed one. */
  runId?: string;
  scope: ExplorerScope;
  subject?: ExplorerSubject;
  size?: number;
  minSupport?: number;
  /** Only sets containing this id. */
  tool?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2_000;

function clampLimit(limit: number | undefined): number {
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)));
}

async function latestCompletedId(
  projectId: string,
  db: Pick<ExplorerDb, "select">,
): Promise<string | null> {
  const [row] = await db
    .select({ id: toolExplorerRuns.id })
    .from(toolExplorerRuns)
    .where(and(eq(toolExplorerRuns.projectId, projectId), eq(toolExplorerRuns.status, "completed")))
    .orderBy(desc(toolExplorerRuns.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** Edges of the latest completed run, most counted first. */
export async function listTransitions(
  projectId: string,
  filter: TransitionFilter,
  db: Pick<ExplorerDb, "select"> = getDb(),
): Promise<ExplorerEdge[]> {
  const runId = filter.runId ?? (await latestCompletedId(projectId, db));
  if (!runId) return [];
  const rows = await db
    .select()
    .from(toolExplorerEdges)
    .where(
      and(
        eq(toolExplorerEdges.projectId, projectId),
        eq(toolExplorerEdges.runId, runId),
        eq(toolExplorerEdges.scope, filter.scope),
        eq(toolExplorerEdges.kind, filter.kind),
        eq(toolExplorerEdges.subject, filter.subject ?? "tool"),
        filter.from ? eq(toolExplorerEdges.a, filter.from) : undefined,
        filter.to ? eq(toolExplorerEdges.b, filter.to) : undefined,
        filter.minN ? gte(toolExplorerEdges.n, filter.minN) : undefined,
      ),
    )
    .orderBy(desc(toolExplorerEdges.n), asc(toolExplorerEdges.a), asc(toolExplorerEdges.b))
    .limit(clampLimit(filter.limit));
  return rows.map((r) => ({
    scope: r.scope as ExplorerScope,
    kind: r.kind as ExplorerEdgeKind,
    subject: r.subject as ExplorerSubject,
    a: r.a,
    b: r.b,
    n: r.n,
    nA: r.nA,
    p: r.p,
    pLow: r.pLow,
    pHigh: r.pHigh,
    lift: r.lift,
    reverseN: r.reverseN,
    exampleSessions: r.exampleSessions,
    ...(r.timedPairs !== null && r.betweenMsTotal !== null && r.searchesBetween !== null
      ? {
          timing: {
            pairs: r.timedPairs,
            betweenMsTotal: r.betweenMsTotal,
            betweenMsMedian: r.betweenMsMedian,
            searchesBetween: r.searchesBetween,
          },
        }
      : {}),
  }));
}

/** Co-used sets of the latest completed run, most supported first. */
export async function listCousage(
  projectId: string,
  filter: CousageFilter,
  db: Pick<ExplorerDb, "select"> = getDb(),
): Promise<ExplorerSet[]> {
  const runId = filter.runId ?? (await latestCompletedId(projectId, db));
  if (!runId) return [];
  const rows = await db
    .select()
    .from(toolExplorerSets)
    .where(
      and(
        eq(toolExplorerSets.projectId, projectId),
        eq(toolExplorerSets.runId, runId),
        eq(toolExplorerSets.scope, filter.scope),
        eq(toolExplorerSets.subject, filter.subject ?? "tool"),
        filter.size ? eq(toolExplorerSets.size, filter.size) : undefined,
        filter.minSupport ? gte(toolExplorerSets.support, filter.minSupport) : undefined,
        filter.tool ? sql`${filter.tool} = any(${toolExplorerSets.items})` : undefined,
      ),
    )
    .orderBy(desc(toolExplorerSets.support), asc(toolExplorerSets.size), asc(toolExplorerSets.key))
    .limit(clampLimit(filter.limit));
  return rows.map((r) => ({
    scope: r.scope as ExplorerScope,
    subject: r.subject as ExplorerSubject,
    key: r.key,
    items: r.items,
    size: r.size,
    support: r.support,
    share: r.share,
    jaccard: r.jaccard,
    jaccardLow: r.jaccardLow,
    pAb: r.pAb,
    pBa: r.pBa,
    workflowId: r.workflowId,
    exampleSessions: r.exampleSessions,
  }));
}

export interface MergeCandidateFilter {
  scope: ExplorerScope;
  minSupport?: number;
  minJaccardLow?: number;
  limit?: number;
}

export const MERGE_MIN_SUPPORT = 20;
export const MERGE_MIN_JACCARD_LOW = ALWAYS_TOGETHER_LOW;

/**
 * Pairs the agent (within the bound) never calls apart: the Crafter's entry
 * point. Strongest first by the Jaccard lower bound, then support.
 */
export async function listMergeCandidates(
  projectId: string,
  filter: MergeCandidateFilter,
  db: Pick<ExplorerDb, "select"> = getDb(),
): Promise<ExplorerSet[]> {
  const runId = await latestCompletedId(projectId, db);
  if (!runId) return [];
  const rows = await db
    .select()
    .from(toolExplorerSets)
    .where(
      and(
        eq(toolExplorerSets.projectId, projectId),
        eq(toolExplorerSets.runId, runId),
        eq(toolExplorerSets.scope, filter.scope),
        eq(toolExplorerSets.subject, "tool"),
        eq(toolExplorerSets.size, 2),
        gte(toolExplorerSets.support, filter.minSupport ?? MERGE_MIN_SUPPORT),
        gte(toolExplorerSets.jaccardLow, filter.minJaccardLow ?? MERGE_MIN_JACCARD_LOW),
      ),
    )
    .orderBy(
      desc(toolExplorerSets.jaccardLow),
      desc(toolExplorerSets.support),
      asc(toolExplorerSets.key),
    )
    .limit(clampLimit(filter.limit));
  return rows.map((r) => ({
    scope: r.scope as ExplorerScope,
    subject: "tool" as const,
    key: r.key,
    items: r.items,
    size: r.size,
    support: r.support,
    share: r.share,
    jaccard: r.jaccard,
    jaccardLow: r.jaccardLow,
    pAb: r.pAb,
    pBa: r.pBa,
    workflowId: r.workflowId,
    exampleSessions: r.exampleSessions,
  }));
}

export interface IntentToolsFilter {
  /** Read this run instead of resolving the project's latest completed one. */
  runId?: string;
  scope: ExplorerScope;
  /** Only this intent. */
  intentId?: string;
  /** Only these intents (a group). */
  intentIds?: readonly string[];
  minUnits?: number;
  limit?: number;
}

export interface IntentToolRow extends IntentToolShare {
  /** The intent's text from `query_intents`; null when the intent was rewritten away. */
  intentText: string | null;
}

/** Which tools serve each intent, from the latest completed run: biggest intents first, then by share. */
export async function listIntentTools(
  projectId: string,
  filter: IntentToolsFilter,
  db: Pick<ExplorerDb, "select"> = getDb(),
): Promise<IntentToolRow[]> {
  const runId = filter.runId ?? (await latestCompletedId(projectId, db));
  if (!runId) return [];
  if (filter.intentIds && filter.intentIds.length === 0) return [];
  const rows = await db
    .select({
      scope: toolExplorerIntentTools.scope,
      intentId: toolExplorerIntentTools.intentId,
      intentUnits: toolExplorerIntentTools.intentUnits,
      toolId: toolExplorerIntentTools.toolId,
      n: toolExplorerIntentTools.n,
      share: toolExplorerIntentTools.share,
      shareLow: toolExplorerIntentTools.shareLow,
      intentText: queryIntents.text,
    })
    .from(toolExplorerIntentTools)
    .leftJoin(queryIntents, eq(queryIntents.id, toolExplorerIntentTools.intentId))
    .where(
      and(
        eq(toolExplorerIntentTools.projectId, projectId),
        eq(toolExplorerIntentTools.runId, runId),
        eq(toolExplorerIntentTools.scope, filter.scope),
        filter.intentId ? eq(toolExplorerIntentTools.intentId, filter.intentId) : undefined,
        filter.intentIds
          ? inArray(toolExplorerIntentTools.intentId, [...filter.intentIds])
          : undefined,
        filter.minUnits ? gte(toolExplorerIntentTools.intentUnits, filter.minUnits) : undefined,
      ),
    )
    .orderBy(
      desc(toolExplorerIntentTools.intentUnits),
      asc(toolExplorerIntentTools.intentId),
      desc(toolExplorerIntentTools.n),
      asc(toolExplorerIntentTools.toolId),
    )
    .limit(clampLimit(filter.limit));
  return rows.map((r) => ({ ...r, scope: r.scope as ExplorerScope }));
}
