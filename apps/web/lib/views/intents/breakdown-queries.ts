import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import {
  type BoundReadDb,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback, type ResilientReadDeps } from "@/lib/platform/resilient-read";
import {
  intentClusterAssignments,
  intentClusters,
  intentEngineState,
} from "@/lib/readings/intent-engine/schema";
import { traceTopicInsights, traceTopics, traceTurnTopics } from "@/lib/readings/topics/schema";
import { topicWindow } from "@/lib/readings/topics/types";
import { asksTree, type IntentAsksTree } from "@/lib/views/intents/asks-tree";
import {
  type BreakdownInput,
  buildBreakdowns,
  type IntentBreakdown,
  type IntentBreakdownSummary,
  type PlacedAsk,
  samplesOf,
  summarizeBreakdown,
} from "@/lib/views/intents/breakdown";

/**
 * Reading the engine's levels back under our Intents (`./breakdown.ts`).
 *
 * Every read is bounded and on an index, forward from the Intents to the
 * engine, never the other way:
 *   1. each active Intent's turns in the topics' window, newest first, at most
 *      {@link TURNS_PER_INTENT} each, on that Intent's own range of
 *      `trace_turn_topics_project_topic_idx`;
 *   2. each turn's ask, by where the topic reading took it from: the first
 *      search step with a query (`trace_turn_steps` by turn, then the
 *      assignment by event), the declared turn's user message (by session and
 *      turn id), or the OTLP trace's first prompt (by trace id);
 *   3. the clusters those asks landed in and their level-1 groups (by id).
 * All of it runs in one transaction under a short statement timeout and a
 * budget for the whole read ({@link READ_BUDGET_MS}), and the result is kept
 * a few minutes per topic reading and engine state, so opening Intents one
 * after another reads once. A project the engine never ran for reads as none
 * without reading further; concurrent reads of one reading
 * share one read; a failed read reads as none for a minute after. The loaders
 * degrade to nothing, logged and reported, rather than fail a page.
 */

/** Turn ids, event ids and trace ids per statement. */
const CHUNK = 1_000;
/** Turns read per Intent at most, newest first: enough for its shares, bounded however busy it is. */
export const TURNS_PER_INTENT = 2_000;
/** Sample asks per way of asking. */
export const SAMPLES_PER_WAY = 3;
/** A reading is kept this long at most. */
const CACHE_TTL_MS = 5 * 60_000;
/** A failed read is remembered this long: a slow project is read again a minute later, not on every view. */
const FAILURE_TTL_MS = 60_000;
/**
 * The whole read's budget, checked between statements. Each statement has its
 * own timeout; this stops a read whose statements are each quick but many (a
 * busy project's first read) from holding a connection for long.
 */
export const READ_BUDGET_MS = 8_000;
const CACHE_LIMIT = 64;
const DECLARED = "declared:";
const OTLP = "otlp:";

type Reading = { breakdowns: Map<string, IntentBreakdown>; at: number; failed?: true };
const cache = new Map<string, Reading>();
const inflight = new Map<string, Promise<Map<string, IntentBreakdown>>>();

export function resetBreakdownCache(): void {
  cache.clear();
  inflight.clear();
}

/** A read past its budget: thrown between statements, logged and reported by the loader like a timeout. */
export class ReadBudgetExceeded extends Error {
  constructor() {
    super("intent breakdown read over its budget");
    this.name = "ReadBudgetExceeded";
  }
}

/** Throws once `deadline` (epoch ms) has passed; no deadline, no check. */
type Budget = () => void;
const budgetUntil =
  (deadline: number | undefined): Budget =>
  () => {
    if (deadline !== undefined && Date.now() > deadline) throw new ReadBudgetExceeded();
  };

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

interface TopicTurn {
  turnId: string;
  topicId: string;
  source: string | null;
  turnKey: string;
  sessionId: string;
}

type AskRow = { askIndex: number; clusterId: string };

/**
 * Each active Intent's turns of the window, newest first, at most `perIntent`
 * each: one index range per Intent, read in the index's order so it stops at
 * the cap. `capped` holds the Intents that had more.
 */
async function readTopicTurns(
  projectId: string,
  from: Date,
  perIntent: number,
  db: BoundReadDb,
  budget: Budget,
): Promise<{ turns: TopicTurn[]; capped: Set<string> }> {
  const topics = await db
    .select({ id: traceTopics.topicId })
    .from(traceTopics)
    .where(and(eq(traceTopics.projectId, projectId), isNull(traceTopics.retiredAt)))
    .orderBy(asc(traceTopics.topicId));
  const turns: TopicTurn[] = [];
  const capped = new Set<string>();
  for (const { id } of topics) {
    budget();
    const rows = await db
      .select({
        turnId: traceTurnTopics.turnId,
        topicId: sql<string>`${traceTurnTopics.topicId}`,
        source: traceTurnTopics.askSource,
        turnKey: traceTurns.turnKey,
        sessionId: traceTurns.sessionId,
      })
      .from(traceTurnTopics)
      .innerJoin(traceTurns, eq(traceTurns.id, traceTurnTopics.turnId))
      .where(
        and(
          eq(traceTurnTopics.projectId, projectId),
          eq(traceTurnTopics.topicId, id),
          gte(traceTurnTopics.startedAt, from),
        ),
      )
      .orderBy(desc(traceTurnTopics.startedAt))
      .limit(perIntent + 1);
    if (rows.length > perIntent) capped.add(id);
    turns.push(...rows.slice(0, perIntent));
  }
  return { turns, capped };
}

const byIndex = (rows: AskRow[]) =>
  rows.sort((a, b) => a.askIndex - b.askIndex).map((r) => r.clusterId);

/** Search-read turns: the first search step with a query, then its frames. */
async function searchAsks(
  turns: readonly TopicTurn[],
  db: BoundReadDb,
  budget: Budget,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const chunk of chunks(turns.map((t) => t.turnId))) {
    budget();
    const first = await db.execute<{ turn_id: string; trace_event_id: string }>(sql`
      select distinct on (s.turn_id) s.turn_id, s.trace_event_id
        from trace_turn_steps s
        join trace_events e on e.id = s.trace_event_id
       where s.turn_id in (${sql.join(
         chunk.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
         and s.kind = 'search' and e.query is not null and btrim(e.query) <> ''
       order by s.turn_id, s.ordinal
    `);
    const turnOf = new Map(first.rows.map((r) => [r.trace_event_id, r.turn_id]));
    if (turnOf.size === 0) continue;
    const rows = await db
      .select({
        eventId: intentClusterAssignments.traceEventId,
        askIndex: intentClusterAssignments.askIndex,
        clusterId: intentClusterAssignments.clusterId,
      })
      .from(intentClusterAssignments)
      .where(inArray(intentClusterAssignments.traceEventId, [...turnOf.keys()]));
    const grouped = new Map<string, AskRow[]>();
    for (const r of rows) nested(grouped, turnOf.get(r.eventId)!).push(r);
    for (const [turnId, list] of grouped) out.set(turnId, byIndex(list));
  }
  return out;
}

/** User-message turns (declared): the message the turn scope sent, then its frames. */
async function messageAsks(
  projectId: string,
  turns: readonly TopicTurn[],
  db: BoundReadDb,
  budget: Budget,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const declared = turns.filter((t) => t.turnKey.startsWith(DECLARED));
  for (const chunk of chunks(declared)) {
    budget();
    const turnOf = new Map(
      chunk.map((t) => [`${t.sessionId}\u0000${t.turnKey.slice(DECLARED.length)}`, t.turnId]),
    );
    const rows = await db
      .select({
        sessionId: intentClusterAssignments.sessionId,
        turnId: intentClusterAssignments.turnId,
        eventId: intentClusterAssignments.traceEventId,
        askIndex: intentClusterAssignments.askIndex,
        clusterId: intentClusterAssignments.clusterId,
      })
      .from(intentClusterAssignments)
      .where(
        and(
          eq(intentClusterAssignments.projectId, projectId),
          eq(intentClusterAssignments.kind, "user_message"),
          inArray(intentClusterAssignments.sessionId, [...new Set(chunk.map((t) => t.sessionId))]),
          inArray(intentClusterAssignments.turnId, [
            ...new Set(chunk.map((t) => t.turnKey.slice(DECLARED.length))),
          ]),
        ),
      )
      .orderBy(
        asc(intentClusterAssignments.occurredAt),
        asc(intentClusterAssignments.traceEventId),
      );
    collectFirstEvent(rows, (r) => turnOf.get(`${r.sessionId}\u0000${r.turnId}`), out);
  }
  return out;
}

/** Prompt-read turns (OTLP): the trace's first prompt the engine read, then its frames. */
async function promptAsks(
  projectId: string,
  turns: readonly TopicTurn[],
  db: BoundReadDb,
  budget: Budget,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const traced = turns.filter((t) => t.turnKey.startsWith(OTLP));
  for (const chunk of chunks(traced)) {
    budget();
    const turnOf = new Map(chunk.map((t) => [t.turnKey.slice(OTLP.length), t.turnId]));
    const rows = await db
      .select({
        traceId: intentClusterAssignments.traceId,
        eventId: intentClusterAssignments.traceEventId,
        askIndex: intentClusterAssignments.askIndex,
        clusterId: intentClusterAssignments.clusterId,
      })
      .from(intentClusterAssignments)
      .where(
        and(
          eq(intentClusterAssignments.projectId, projectId),
          eq(intentClusterAssignments.kind, "prompt"),
          inArray(intentClusterAssignments.traceId, [...turnOf.keys()]),
        ),
      )
      .orderBy(
        asc(intentClusterAssignments.occurredAt),
        asc(intentClusterAssignments.traceEventId),
      );
    collectFirstEvent(rows, (r) => (r.traceId ? turnOf.get(r.traceId) : undefined), out);
  }
  return out;
}

/** Per turn, the frames of its earliest event only (rows arrive oldest first). */
function collectFirstEvent<R extends AskRow & { eventId: string }>(
  rows: readonly R[],
  turnOf: (r: R) => string | undefined,
  out: Map<string, string[]>,
) {
  const firstEvent = new Map<string, string>();
  const grouped = new Map<string, AskRow[]>();
  for (const r of rows) {
    const turnId = turnOf(r);
    if (!turnId) continue;
    const event = firstEvent.get(turnId) ?? (firstEvent.set(turnId, r.eventId), r.eventId);
    if (event === r.eventId) nested(grouped, turnId).push(r);
  }
  for (const [turnId, list] of grouped) out.set(turnId, byIndex(list));
}

function nested<V>(map: Map<string, V[]>, key: string): V[] {
  let list = map.get(key);
  if (!list) map.set(key, (list = []));
  return list;
}

/** Everything `buildBreakdowns` reads, for one project. */
export async function readBreakdownInput(
  projectId: string,
  options: {
    now?: Date;
    turnsPerIntent?: number /** Epoch ms the read must finish by; none, no limit. */;
    deadline?: number;
  },
  db: BoundReadDb,
): Promise<BreakdownInput> {
  const budget = budgetUntil(options.deadline);
  const { turns, capped } = await readTopicTurns(
    projectId,
    topicWindow(options.now ?? new Date()).from,
    options.turnsPerIntent ?? TURNS_PER_INTENT,
    db,
    budget,
  );
  const asksByTopic = new Map<string, number>();
  for (const t of turns) asksByTopic.set(t.topicId, (asksByTopic.get(t.topicId) ?? 0) + 1);

  const bySource = (source: string) => turns.filter((t) => t.source === source);
  // One after another: the transaction is one connection.
  const frames = new Map<string, string[]>([
    ...(await searchAsks(bySource("search"), db, budget)),
    ...(await messageAsks(projectId, bySource("user"), db, budget)),
    ...(await promptAsks(projectId, bySource("prompt"), db, budget)),
  ]);
  const asks: PlacedAsk[] = turns.flatMap((t) => {
    const clusters = frames.get(t.turnId);
    return clusters && clusters.length > 0 ? [{ topicId: t.topicId, clusters }] : [];
  });

  const clusterIds = [...new Set(asks.flatMap((a) => a.clusters))];
  const clusters = new Map<string, { parentId: string | null; label: string }>();
  for (const chunk of chunks(clusterIds)) {
    budget();
    const rows = await db
      .select({
        id: intentClusters.id,
        parentId: intentClusters.parentId,
        label: intentClusters.label,
      })
      .from(intentClusters)
      .where(
        and(
          eq(intentClusters.projectId, projectId),
          eq(intentClusters.level, 0),
          inArray(intentClusters.id, chunk),
        ),
      );
    for (const r of rows) clusters.set(r.id, { parentId: r.parentId, label: r.label });
  }
  const groupIds = [
    ...new Set([...clusters.values()].flatMap((c) => (c.parentId ? [c.parentId] : []))),
  ];
  const groups = new Map<string, { label: string; named: boolean }>();
  for (const chunk of chunks(groupIds)) {
    budget();
    const rows = await db
      .select({
        id: intentClusters.id,
        label: intentClusters.label,
        llmLabel: intentClusters.llmLabel,
      })
      .from(intentClusters)
      .where(
        and(
          eq(intentClusters.projectId, projectId),
          eq(intentClusters.level, 1),
          inArray(intentClusters.id, chunk),
        ),
      );
    for (const r of rows)
      groups.set(r.id, { label: r.label, named: r.llmLabel !== null && r.llmLabel === r.label });
  }
  // A cluster whose parent is gone (a rebuild between two reads) has no group.
  for (const [id, c] of clusters)
    if (c.parentId && !groups.has(c.parentId)) clusters.set(id, { ...c, parentId: null });
  return { asksByTopic, asks, clusters, groups, capped };
}

/**
 * What a cached reading is keyed by: the latest topic reading and engine
 * state, and a short clock. Null when the engine never ran for the project:
 * nothing to read.
 */
async function readingKey(projectId: string, now: Date, db: BoundReadDb): Promise<string | null> {
  const [topics] = await db
    .select({ at: sql<string | null>`${traceTopicInsights.computedAt}::text` })
    .from(traceTopicInsights)
    .where(eq(traceTopicInsights.projectId, projectId))
    .limit(1);
  const [engine] = await db
    .select({ at: sql<string | null>`${intentEngineState.updatedAt}::text` })
    .from(intentEngineState)
    .where(eq(intentEngineState.projectId, projectId))
    .limit(1);
  if (!engine) return null;
  return `${projectId}|${topics?.at ?? "-"}|${engine.at ?? "-"}|${Math.floor(now.getTime() / CACHE_TTL_MS)}`;
}

export interface BreakdownReadOptions {
  now?: Date;
  /** Turns read per Intent at most; {@link TURNS_PER_INTENT} by default. */
  turnsPerIntent?: number;
  db?: BoundReadDb;
  timeoutMs?: number | null;
  /** The whole read's budget; {@link READ_BUDGET_MS} by default. */
  budgetMs?: number;
}

/**
 * Every Intent's breakdown for a project, without samples. Throws on a
 * failed, cancelled or over-budget read; for a minute after, the same reading
 * reads as none (the failure was logged and reported once already).
 */
export async function readIntentBreakdowns(
  projectId: string,
  options: BreakdownReadOptions = {},
): Promise<Map<string, IntentBreakdown>> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDb();
  const timeoutMs =
    options.timeoutMs === undefined ? supplementaryReadTimeoutMs() : options.timeoutMs;
  const key = await withStatementTimeout((tx) => readingKey(projectId, now, tx), {
    operation: "intent_breakdown_key",
    db,
    timeoutMs,
  });
  if (key === null) return new Map();
  const hit = cache.get(key);
  if (hit && !(hit.failed && now.getTime() - hit.at > FAILURE_TTL_MS)) return hit.breakdowns;
  const pending = inflight.get(key);
  if (pending) return pending;
  const deadline = Date.now() + (options.budgetMs ?? READ_BUDGET_MS);
  const read = withStatementTimeout(
    async (tx) =>
      buildBreakdowns(
        await readBreakdownInput(
          projectId,
          { now, turnsPerIntent: options.turnsPerIntent, deadline },
          tx,
        ),
      ),
    { operation: "intent_breakdown", db, timeoutMs },
  );
  inflight.set(key, read);
  try {
    const breakdowns = await read;
    remember(key, { breakdowns, at: now.getTime() });
    return breakdowns;
  } catch (error) {
    remember(key, { breakdowns: new Map(), at: now.getTime(), failed: true });
    throw error;
  } finally {
    inflight.delete(key);
  }
}

function remember(key: string, reading: Reading): void {
  cache.set(key, reading);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** Fill a breakdown's sample asks: a few members of each way's cluster, newest first. */
async function withSamples(
  projectId: string,
  breakdown: IntentBreakdown,
  options: BreakdownReadOptions,
): Promise<IntentBreakdown> {
  const ids = breakdown.whatTheyAskFor.groups.flatMap((g) => g.waysOfAsking.ways.map((w) => w.id));
  if (ids.length === 0) return breakdown;
  const rows = await withStatementTimeout(
    (db) =>
      db
        .select({ id: intentClusters.id, members: intentClusters.members })
        .from(intentClusters)
        .where(and(eq(intentClusters.projectId, projectId), inArray(intentClusters.id, ids))),
    {
      operation: "intent_breakdown_samples",
      db: options.db ?? getDb(),
      timeoutMs: options.timeoutMs === undefined ? supplementaryReadTimeoutMs() : options.timeoutMs,
    },
  );
  const members = new Map(rows.map((r) => [r.id, r.members]));
  return {
    ...breakdown,
    whatTheyAskFor: {
      ...breakdown.whatTheyAskFor,
      groups: breakdown.whatTheyAskFor.groups.map((g) => ({
        ...g,
        waysOfAsking: {
          ...g.waysOfAsking,
          ways: g.waysOfAsking.ways.map((w) => ({
            ...w,
            samples: samplesOf(members.get(w.id) ?? [], w.label, SAMPLES_PER_WAY),
          })),
        },
      })),
    },
  };
}

/**
 * One Intent's "What they ask for", "Ways people ask it" (with samples) and
 * "Also wants"; null when the engine placed nothing there or the read failed
 * (logged and reported, never thrown).
 */
export async function loadIntentBreakdown(
  projectId: string,
  topicId: string,
  options: BreakdownReadOptions = {},
  deps?: ResilientReadDeps,
): Promise<IntentBreakdown | null> {
  return loadOrFallback(
    {
      operation: "intent_breakdown",
      distinctId: `project:${projectId}`,
      fallback: null,
      load: async () => {
        const breakdown = (await readIntentBreakdowns(projectId, options)).get(topicId);
        return breakdown && breakdown.placed > 0
          ? withSamples(projectId, breakdown, options)
          : null;
      },
    },
    deps,
  );
}

/** The All intents table's counts per Intent: the rows each chevron opens. Empty when the read failed. */
export async function loadIntentBreakdownSummary(
  projectId: string,
  options: BreakdownReadOptions = {},
  deps?: ResilientReadDeps,
): Promise<Map<string, IntentBreakdownSummary>> {
  return loadOrFallback(
    {
      operation: "intent_breakdown_summary",
      distinctId: `project:${projectId}`,
      fallback: new Map(),
      load: async () =>
        new Map(
          [...(await readIntentBreakdowns(projectId, options))].map(([id, b]) => [
            id,
            summarizeBreakdown(b),
          ]),
        ),
    },
    deps,
  );
}

/**
 * Every intent's asks as a tree, for Intents › Map's Asks lens: one read for
 * all of them (the same cached breakdowns, no samples). An intent the engine
 * placed nothing in is left out. Degrades to none, logged and reported.
 */
export async function loadIntentAsksTrees(
  projectId: string,
  options: BreakdownReadOptions = {},
  deps?: ResilientReadDeps,
): Promise<Map<string, IntentAsksTree>> {
  return loadOrFallback(
    {
      operation: "intent_asks_trees",
      distinctId: `project:${projectId}`,
      fallback: new Map(),
      load: async () =>
        new Map(
          [...(await readIntentBreakdowns(projectId, options))]
            .filter(([, breakdown]) => breakdown.placed > 0)
            .map(([id, breakdown]) => [id, asksTree(breakdown)]),
        ),
    },
    deps,
  );
}
