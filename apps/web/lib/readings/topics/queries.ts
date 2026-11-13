import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { OTLP_MODEL_CALL } from "@/lib/ingest/otlp/derive-model-calls";
import { events } from "@/lib/ingest/otlp/schema";
import { jobs } from "@/lib/jobs/schema";
import { TURN_EVENT_TYPES } from "@/lib/ledger/constants";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { parseStoredPattern } from "@/lib/readings/topics/patterns";
import { traceTopicInsights, traceTopics, traceTurnTopics } from "@/lib/readings/topics/schema";
import {
  type StoredTopic,
  type StoredTopicPattern,
  TOPIC_INSIGHTS_VERSION,
  type TopicInsights,
  type TopicVerdict,
} from "@/lib/readings/topics/types";
import { traceSelfCorrections, traceSignalRuns } from "@/lib/readings/trace-signals/schema";
import { storedHelperTools } from "@/lib/readings/trace-signals/signals/workflow-stored";

/**
 * Reads and writes of the `assign_topics` job and the Intents pages. Stored
 * JSON is untrusted: a row that does not parse reads as no reading. Text
 * never enters these tables; turns remember their ask only as a hash.
 */

export type TopicsDb = ReturnType<typeof getDb>;
type ReadDb = Pick<TopicsDb, "select">;

export const ASSIGN_TOPICS_JOB_KIND = "assign_topics";
const CHUNK = 500;
const WRITE_CHUNK = 1_000;

function chunks<T>(items: readonly T[], size: number = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Where a reading of at most `max` closed turns starts: the window's start,
 * or, when the window holds more, the end time of the `max`-th newest turn
 * (the reading keeps the newest).
 */
export async function readingStart(
  projectId: string,
  window: { from: Date; to: Date },
  max: number,
  db: ReadDb = getDb(),
): Promise<{ from: Date; capped: boolean }> {
  const rows = await db
    .select({ endedAt: traceTurns.endedAt })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.status, "closed"),
        gte(traceTurns.endedAt, window.from),
        lt(traceTurns.endedAt, window.to),
      ),
    )
    .orderBy(desc(traceTurns.endedAt), desc(traceTurns.id))
    .offset(Math.max(0, max - 1))
    .limit(2);
  if (rows.length < 2) return { from: window.from, capped: false };
  return { from: rows[0]!.endedAt, capped: true };
}

/** A trace whose agent answered from the model alone: no search, no tool call, so no ledger turn. */
export interface ModelOnlyTrace {
  traceId: string;
  sessionId: string | null;
  endUserId: string | null;
  startedAt: Date;
  endedAt: Date;
  /** The user's message the first model call carried. */
  prompt: string;
}

/**
 * Traces in the window made of model calls only, newest first, at most `max`,
 * that went quiet before `closedBefore` (as a turn closes). A trace with a
 * search or a tool call makes a ledger turn and is read there; these never
 * do, yet they are asks too, and none of them was answered by a tool. Only
 * traces whose model call carried the prompt (content capture) are returned.
 */
export async function loadModelOnlyTraces(
  projectId: string,
  window: { from: Date; to: Date },
  closedBefore: Date,
  max: number,
  db: Pick<TopicsDb, "execute"> = getDb(),
): Promise<ModelOnlyTrace[]> {
  const at = sql`coalesce(e.occurred_at, e.received_at)`;
  const steps = sql.join(
    TURN_EVENT_TYPES.map((type) => sql`${type}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    select e.trace_id,
           min(${at}) as started_at,
           max(${at}) as ended_at,
           max(e.session_id) as session_id,
           max(e.end_user_id) as end_user_id,
           (array_agg(e.payload ->> 'prompt' order by ${at}) filter (where e.payload ? 'prompt'))[1] as prompt
    from trace_events e
    where e.project_id = ${projectId}
      and e.type = ${OTLP_MODEL_CALL}
      and e.trace_id is not null
      and ${at} >= ${window.from.toISOString()} and ${at} < ${window.to.toISOString()}
      and not exists (
        select 1 from trace_events s
        where s.project_id = ${projectId} and s.trace_id = e.trace_id and s.type in (${steps})
      )
    group by e.trace_id
    having max(e.received_at) < ${closedBefore.toISOString()}
       and bool_or(e.payload ? 'prompt')
    order by min(${at}) desc
    limit ${max}
  `);
  return (result.rows as Record<string, unknown>[]).flatMap((row) => {
    const prompt = typeof row.prompt === "string" ? row.prompt.trim() : "";
    if (typeof row.trace_id !== "string" || prompt === "") return [];
    return [
      {
        traceId: row.trace_id,
        sessionId: typeof row.session_id === "string" ? row.session_id : null,
        endUserId: typeof row.end_user_id === "string" ? row.end_user_id : null,
        startedAt: new Date(row.started_at as string),
        endedAt: new Date(row.ended_at as string),
        prompt,
      },
    ];
  });
}

/**
 * What a final reply says when the agent could not do what was asked: "I
 * can't book rentals", "I'm unable to", "isn't something I can do yet",
 * "isn't connected". A Postgres regular expression (`~*`, `\m` and `\M` are
 * word edges), so the reply is read where it is stored and never leaves the
 * database: only whether it matched does.
 */
export const REFUSAL_PATTERN = String.raw`\mI(['’]m| am) (unable|not able)\M|\mI (can['’]?t|cannot|can not|won['’]t be able|don['’]t have (a|any|the|access))\M|isn['’]?t something I can|(isn['’]?t|not) connected to|\mno (tool|way) (to|for)\M`;

/**
 * The traces among `traceIds` whose final reply (content capture) says the
 * agent could not do it. Reads the last message of the trace's final model
 * call (`finish_reason` stop) in `events`, joined by `trace_id`.
 */
export async function loadRefusedTraces(
  projectId: string,
  traceIds: readonly string[],
  db: Pick<TopicsDb, "selectDistinct"> = getDb(),
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const chunk of chunks(traceIds)) {
    const rows = await db
      .selectDistinct({ traceId: events.traceId })
      .from(events)
      .where(
        and(
          eq(events.projectId, projectId),
          inArray(events.traceId, chunk),
          sql`${events.payload} ->> 'finish_reason' = 'stop'`,
          sql`${events.payload} -> 'messages' -> -1 ->> 'role' = 'assistant'`,
          sql`(${events.payload} -> 'messages' -> -1 -> 'content')::text ~* ${REFUSAL_PATTERN}`,
        ),
      );
    for (const row of rows) if (row.traceId) out.add(row.traceId);
  }
  return out;
}

/** Each given turn's task (`trace_turns.workflow_id`), for the turns that have one. */
export async function loadTurnTasks(
  projectId: string,
  turnIds: readonly string[],
  db: ReadDb = getDb(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const chunk of chunks(turnIds)) {
    const rows = await db
      .select({ id: traceTurns.id, workflowId: traceTurns.workflowId })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, projectId),
          inArray(traceTurns.id, chunk),
          isNotNull(traceTurns.workflowId),
        ),
      );
    for (const row of rows) if (row.workflowId) out.set(row.id, row.workflowId);
  }
  return out;
}

/** Self-correction kinds per turn; null when none were recorded for any of the turns. */
export async function loadSelfCorrectionKinds(
  projectId: string,
  turnIds: readonly string[],
  db: ReadDb = getDb(),
): Promise<Map<string, string[]> | null> {
  const out = new Map<string, string[]>();
  for (const chunk of chunks(turnIds)) {
    const rows = await db
      .select({ turnId: traceSelfCorrections.turnId, kind: traceSelfCorrections.kind })
      .from(traceSelfCorrections)
      .where(
        and(
          eq(traceSelfCorrections.projectId, projectId),
          inArray(traceSelfCorrections.turnId, chunk),
        ),
      );
    for (const row of rows) out.set(row.turnId, [...(out.get(row.turnId) ?? []), row.kind]);
  }
  return out.size > 0 ? out : null;
}

const LABEL_SOURCES = new Set(["llm", "words", "user"]);

/** Every topic of the project, retired ones included, oldest first. */
export async function loadStoredTopics(
  projectId: string,
  db: ReadDb = getDb(),
): Promise<StoredTopic[]> {
  const rows = await db
    .select({
      topicId: traceTopics.topicId,
      name: traceTopics.name,
      description: traceTopics.description,
      labelSource: traceTopics.labelSource,
      model: traceTopics.model,
      inputHash: traceTopics.inputHash,
      retiredAt: traceTopics.retiredAt,
      createdAt: traceTopics.createdAt,
    })
    .from(traceTopics)
    .where(eq(traceTopics.projectId, projectId))
    .orderBy(traceTopics.createdAt, traceTopics.topicId);
  return rows.map((row) => ({
    ...row,
    labelSource: (LABEL_SOURCES.has(row.labelSource)
      ? row.labelSource
      : "llm") as StoredTopic["labelSource"],
  }));
}

/** Where each ask (by hash) of the given turns went in the last reading: its topic. */
export async function loadPreviousPlacements(
  projectId: string,
  turnIds: readonly string[],
  db: ReadDb = getDb(),
): Promise<Map<string, string>> {
  const counts = new Map<string, Map<string, number>>();
  for (const chunk of chunks(turnIds)) {
    const rows = await db
      .select({ askHash: traceTurnTopics.askHash, topicId: traceTurnTopics.topicId })
      .from(traceTurnTopics)
      .where(
        and(
          eq(traceTurnTopics.projectId, projectId),
          inArray(traceTurnTopics.turnId, chunk),
          eq(traceTurnTopics.verdict, "topic"),
          isNotNull(traceTurnTopics.askHash),
        ),
      );
    for (const row of rows) {
      if (!row.askHash || !row.topicId) continue;
      const byTopic = counts.get(row.askHash) ?? new Map<string, number>();
      byTopic.set(row.topicId, (byTopic.get(row.topicId) ?? 0) + 1);
      counts.set(row.askHash, byTopic);
    }
  }
  return new Map(
    [...counts].map(([hash, byTopic]) => [
      hash,
      [...byTopic].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0],
    ]),
  );
}

/** The stored reading, when there is one and it parses. */
export async function loadTopicReading(
  projectId: string,
  db: ReadDb = getDb(),
): Promise<{ insights: TopicInsights; computedAt: Date; model: string | null } | null> {
  const [row] = await db
    .select({
      data: traceTopicInsights.data,
      computedAt: traceTopicInsights.computedAt,
      model: traceTopicInsights.model,
    })
    .from(traceTopicInsights)
    .where(eq(traceTopicInsights.projectId, projectId))
    .limit(1);
  if (!row) return null;
  const insights = parseTopicInsights(row.data);
  return insights ? { insights, computedAt: row.computedAt, model: row.model } : null;
}

/** A stored reading, or null when it is of another version or missing its parts. */
export function parseTopicInsights(data: unknown): TopicInsights | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Partial<TopicInsights>;
  if (
    record.version !== TOPIC_INSIGHTS_VERSION ||
    !Array.isArray(record.topics) ||
    !Array.isArray(record.tools)
  )
    return null;
  if (typeof record.turns !== "number" || !record.verdicts || !record.sources) return null;
  return record as TopicInsights;
}

export interface TurnTopicRow {
  turnId: string;
  topicId: string | null;
  verdict: TopicVerdict;
  askSource: string | null;
  askHash: string | null;
  sentiment: string | null;
  startedAt: Date;
}

export interface SavedReading {
  /** Topics created, renamed or retired by this reading. */
  topics: readonly StoredTopic[];
  turns: readonly TurnTopicRow[];
  insights: TopicInsights;
  model: string | null;
}

/** Writes one reading at once: the topics it changed, every turn's place, and the numbers. */
export async function saveTopicReading(
  projectId: string,
  reading: SavedReading,
  db: TopicsDb = getDb(),
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const topic of reading.topics) {
      await tx
        .insert(traceTopics)
        .values({ projectId, ...topic, createdAt: topic.createdAt, updatedAt: now })
        .onConflictDoUpdate({
          target: [traceTopics.projectId, traceTopics.topicId],
          set: {
            name: topic.name,
            description: topic.description,
            labelSource: topic.labelSource,
            model: topic.model,
            inputHash: topic.inputHash,
            retiredAt: topic.retiredAt,
            updatedAt: now,
          },
        });
    }
    for (const chunk of chunks(reading.turns, WRITE_CHUNK)) {
      await tx
        .insert(traceTurnTopics)
        .values(chunk.map((row) => ({ projectId, ...row, createdAt: now })))
        .onConflictDoUpdate({
          target: traceTurnTopics.turnId,
          set: {
            topicId: sql`excluded.topic_id`,
            verdict: sql`excluded.verdict`,
            askSource: sql`excluded.ask_source`,
            askHash: sql`excluded.ask_hash`,
            sentiment: sql`excluded.sentiment`,
            startedAt: sql`excluded.started_at`,
            createdAt: sql`excluded.created_at`,
          },
        });
    }
    const data = reading.insights as unknown as Record<string, unknown>;
    await tx
      .insert(traceTopicInsights)
      .values({ projectId, data, model: reading.model, computedAt: now })
      .onConflictDoUpdate({
        target: traceTopicInsights.projectId,
        set: { data, model: reading.model, computedAt: now },
      });
  });
}

/**
 * Queue one `assign_topics` job for the project, unless one is already
 * waiting (a running one does not count: what arrived since deserves a
 * reading). Coalesced in the insert itself; null when one was waiting.
 */
export async function enqueueAssignTopicsJob(
  projectId: string,
  db: Pick<TopicsDb, "execute"> = getDb(),
): Promise<{ id: string } | null> {
  const result = await db.execute(sql`
    insert into ${jobs} (project_id, kind, status, payload)
    select ${projectId}::uuid, ${ASSIGN_TOPICS_JOB_KIND}, 'queued', '{}'::jsonb
    where not exists (
      select 1 from ${jobs}
      where ${jobs.projectId} = ${projectId}::uuid and ${jobs.kind} = ${ASSIGN_TOPICS_JOB_KIND} and ${jobs.status} = 'queued'
    )
    returning id
  `);
  const row = result.rows[0] as { id?: string } | undefined;
  return row?.id ? { id: row.id } : null;
}

/** Whether a reading is queued or running now (fresh rows only, as `listInFlightJobs` reads them). */
export async function topicReadingInFlight(
  projectId: string,
  db: ReadDb = getDb(),
): Promise<boolean> {
  const fresh = new Date(Date.now() - 10 * 60_000);
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, projectId),
        eq(jobs.kind, ASSIGN_TOPICS_JOB_KIND),
        inArray(jobs.status, ["queued", "running"]),
        gte(jobs.createdAt, fresh),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export interface TaskSummary {
  id: string;
  runs: number;
  /** Its tools in their usual order: the name a task has before a model names it. */
  typicalOrder: string[];
}

/** The latest completed signal run's tasks with their runs: what task colors are ranked by (`lib/tasks/palette.ts`). */
export async function loadTaskRuns(
  projectId: string,
  db: ReadDb = getDb(),
): Promise<TaskSummary[]> {
  const [row] = await db
    .select({ items: sql<unknown>`${traceSignalRuns.summary} -> 'workflows' -> 'items'` })
    .from(traceSignalRuns)
    .where(and(eq(traceSignalRuns.projectId, projectId), eq(traceSignalRuns.status, "completed")))
    .orderBy(desc(traceSignalRuns.createdAt))
    .limit(1);
  const items = row?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as { id?: unknown; runs?: unknown; typicalOrder?: unknown };
    if (typeof record.id !== "string" || typeof record.runs !== "number") return [];
    const order = Array.isArray(record.typicalOrder)
      ? record.typicalOrder.filter((tool): tool is string => typeof tool === "string")
      : [];
    return [{ id: record.id, runs: record.runs, typicalOrder: order }];
  });
}

/**
 * The project's helper tools from the latest completed signal run
 * (`StoredWorkflows.ubiquitousTools`, the miner's own set): what an intent's
 * pattern sets aside. One row, one JSON path. Null when they are unknown: no
 * completed run yet, or a run stored before the set was kept. An empty list
 * is a known answer: no tool runs in half the multi-tool turns.
 */
export async function loadHelperTools(
  projectId: string,
  db: ReadDb = getDb(),
): Promise<string[] | null> {
  const [row] = await db
    .select({ tools: sql<unknown>`${traceSignalRuns.summary} -> 'workflows' -> 'ubiquitousTools'` })
    .from(traceSignalRuns)
    .where(and(eq(traceSignalRuns.projectId, projectId), eq(traceSignalRuns.status, "completed")))
    .orderBy(desc(traceSignalRuns.createdAt))
    .limit(1);
  if (!Array.isArray(row?.tools)) return null;
  return storedHelperTools({ ubiquitousTools: row.tools as string[] });
}

/** One live intent's stored tool pattern, as the crafter and Fixes read it. */
export interface TopicPatternRow {
  topicId: string;
  /** Its name as Intents shows it (model-written, or its asks' own words without a model). */
  name: string;
  turns: number;
  pattern: StoredTopicPattern;
}

/**
 * Every live intent's tool pattern from the latest reading: the reading's
 * own row, its topics picked out by a JSON path, joined to their names. No
 * turn is read. Rows whose pattern does not parse are left out.
 */
export async function loadTopicPatterns(
  projectId: string,
  db: Pick<TopicsDb, "execute"> = getDb(),
): Promise<TopicPatternRow[]> {
  const result = await db.execute(sql`
    select topic ->> 'id' as topic_id, named.name as name, topic ->> 'turns' as turns, topic -> 'pattern' as pattern
    from ${traceTopicInsights} as insights
    cross join lateral jsonb_array_elements(case when jsonb_typeof(insights.data -> 'topics') = 'array' then insights.data -> 'topics' else '[]'::jsonb end) as topic
    join ${traceTopics} as named on named.project_id = insights.project_id and named.topic_id = topic ->> 'id' and named.retired_at is null
    where insights.project_id = ${projectId}
      and insights.data ->> 'version' = ${String(TOPIC_INSIGHTS_VERSION)}
      and jsonb_typeof(topic -> 'pattern') = 'object'
    order by topic ->> 'id'
  `);
  return (
    result.rows as { topic_id?: unknown; name?: unknown; turns?: unknown; pattern?: unknown }[]
  ).flatMap((row) => {
    const pattern = parseStoredPattern(row.pattern);
    const turns = Number(row.turns);
    if (
      !pattern ||
      typeof row.topic_id !== "string" ||
      typeof row.name !== "string" ||
      !Number.isFinite(turns)
    )
      return [];
    return [{ topicId: row.topic_id, name: row.name, turns, pattern }];
  });
}
