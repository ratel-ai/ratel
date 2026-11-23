import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { intentClusters } from "@/lib/readings/intent-engine/schema";
import {
  traceSessionOutcomes,
  traceTaskOutcomes,
  traceTurnOutcomes,
} from "@/lib/readings/trace-signals/schema";
import type {
  PageAnswer,
  PageIntent,
  PageSession,
  PageTask,
  PageTurn,
} from "@/lib/views/traces/sentiment/page-model";

/**
 * The database side of the Sentiment analysis page (`page-load.ts`). Every
 * read is of one project and one window, on an index, and bounded: the turns
 * with something to explain and the sessions are capped, newest first, and the
 * page says when a window held more.
 *
 * Text-free: outcome rows hold closed values, counts, ids and times, and the
 * intent join reads cluster ids and names, never an ask.
 */

export type PageDb = Pick<ReturnType<typeof getDb>, "select" | "execute">;

/** Turns with a failed call, an unmet search, an unsatisfied person or a cause a model chose, read at most. */
export const MAX_PAGE_TURNS = 5_000;
export const MAX_PAGE_SESSIONS = 20_000;
const ID_CHUNK = 500;

export interface PageWindow {
  from: Date;
  to: Date;
}

function chunks<T>(items: readonly T[], size: number = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const inWindow = (projectId: string, window: PageWindow) =>
  and(
    eq(traceTurnOutcomes.projectId, projectId),
    gte(traceTurnOutcomes.endedAt, window.from),
    lt(traceTurnOutcomes.endedAt, window.to),
  );

/** The window's turns with something to explain, newest first, at most `max`. Their cost is read apart (`loadTurnCosts`). */
export async function loadPageTurns(
  projectId: string,
  window: PageWindow,
  db: PageDb = getDb(),
  max: number = MAX_PAGE_TURNS,
): Promise<{ turns: PageTurn[]; capped: boolean }> {
  const rows = await db
    .select({
      turnId: traceTurnOutcomes.turnId,
      sessionId: traceTurnOutcomes.sessionId,
      startedAt: traceTurnOutcomes.startedAt,
      endedAt: traceTurnOutcomes.endedAt,
      cause: traceTurnOutcomes.cause,
      causeSource: traceTurnOutcomes.causeSource,
      failures: traceTurnOutcomes.failures,
      unmetSearches: traceTurnOutcomes.unmetSearches,
      satisfaction: traceTurnOutcomes.satisfaction,
      reaction: traceTurnOutcomes.reaction,
    })
    .from(traceTurnOutcomes)
    .where(
      and(
        inWindow(projectId, window),
        or(
          gte(traceTurnOutcomes.failedCalls, 1),
          gte(traceTurnOutcomes.unmetSearches, 1),
          eq(traceTurnOutcomes.satisfaction, "unsatisfied"),
          // A cause a model chose: a turn that went wrong with every call working.
          eq(traceTurnOutcomes.causeSource, "model"),
        ),
      ),
    )
    .orderBy(desc(traceTurnOutcomes.endedAt), desc(traceTurnOutcomes.turnId))
    .limit(max + 1);
  return {
    turns: rows.slice(0, max).map((row) => ({ ...row, costUsd: null })),
    capped: rows.length > max,
  };
}

/** Whether the window holds a model call sent with a cost: without one the page shows no cost. */
export async function hasCostedModelCalls(
  projectId: string,
  window: PageWindow,
  db: PageDb = getDb(),
): Promise<boolean> {
  const result = await db.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from events
       where project_id = ${projectId}::uuid and cost_usd is not null
         and coalesce(occurred_at, received_at) >= ${window.from.toISOString()}::timestamptz
         and coalesce(occurred_at, received_at) < ${window.to.toISOString()}::timestamptz
    ) as found
  `);
  return result.rows[0]?.found === true;
}

/**
 * What each turn's model calls cost: the calls of the traces its steps belong
 * to (or, for an OpenTelemetry turn, its own trace). A trace two turns share
 * is split evenly between them, so a cost is never counted twice. A turn with
 * no costed call is absent.
 */
export async function loadTurnCosts(
  projectId: string,
  turnIds: readonly string[],
  db: PageDb = getDb(),
): Promise<Map<string, number>> {
  const usage = await loadTurnUsage(projectId, turnIds, db);
  return new Map(
    [...usage]
      .filter(([, used]) => used.costUsd !== null)
      .map(([turnId, used]) => [turnId, used.costUsd!]),
  );
}

/**
 * What each turn's model calls cost and how many tokens they used (input and
 * output), split between turns as `loadTurnCosts` does. A turn whose calls
 * were sent with neither is absent; one sent with tokens and no cost has a
 * null cost.
 */
export async function loadTurnUsage(
  projectId: string,
  turnIds: readonly string[],
  db: PageDb = getDb(),
): Promise<Map<string, { costUsd: number | null; tokens: number }>> {
  const tracesOf = new Map<string, Set<string>>();
  for (const ids of chunks([...new Set(turnIds)])) {
    const result = await db.execute<{ turn_id: string; trace_id: string }>(sql`
      select distinct s.turn_id, e.trace_id
        from trace_turn_steps s
        join trace_events e on e.id = s.trace_event_id
       where s.turn_id in (${uuids(ids)}) and e.project_id = ${projectId}::uuid and e.trace_id is not null
      union
      select t.id as turn_id, substr(t.turn_key, 6) as trace_id
        from trace_turns t
       where t.project_id = ${projectId}::uuid and t.id in (${uuids(ids)}) and t.turn_source = 'otlp'
    `);
    for (const row of result.rows) {
      const set = tracesOf.get(row.turn_id) ?? new Set<string>();
      tracesOf.set(row.turn_id, set);
      set.add(row.trace_id);
    }
  }
  const turnsOf = new Map<string, number>();
  for (const traces of tracesOf.values())
    for (const trace of traces) turnsOf.set(trace, (turnsOf.get(trace) ?? 0) + 1);

  const usageOf = new Map<string, { cost: number | null; tokens: number }>();
  for (const traces of chunks([...turnsOf.keys()])) {
    const result = await db.execute<{
      trace_id: string;
      cost: string | number | null;
      tokens: string | number | null;
    }>(sql`
      select trace_id, sum(cost_usd) as cost, sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) as tokens
        from events
       where project_id = ${projectId}::uuid and (cost_usd is not null or input_tokens is not null or output_tokens is not null)
         and trace_id in (${sql.join(
           traces.map((trace) => sql`${trace}`),
           sql`, `,
         )})
       group by trace_id
    `);
    for (const row of result.rows)
      usageOf.set(row.trace_id, {
        cost: row.cost === null ? null : Number(row.cost),
        tokens: Number(row.tokens ?? 0),
      });
  }

  const out = new Map<string, { costUsd: number | null; tokens: number }>();
  for (const [turnId, traces] of tracesOf) {
    let cost: number | null = null;
    let tokens = 0;
    let used = false;
    for (const trace of traces) {
      const usage = usageOf.get(trace);
      if (usage === undefined) continue;
      used = true;
      const share = turnsOf.get(trace) ?? 1;
      if (usage.cost !== null) cost = (cost ?? 0) + usage.cost / share;
      tokens += usage.tokens / share;
    }
    if (used) out.set(turnId, { costUsd: cost, tokens });
  }
  return out;
}

/** Turns the person said were satisfying or not, read at most: a window with more is capped, newest first. */
export const MAX_PAGE_ANSWERS = 5_000;

/**
 * The window's turns the person reacted to, newest first, at most `max`:
 * every turn with a reading of their next message. `satisfied` is whether
 * they did not push back: a turn they moved on from counts, the way a
 * satisfied one does; only an unsatisfied one does not. Where their own words
 * were not read, what the agent's next reply shows stands in, marked
 * `inferred`: a correction, a repeat or a call for a human as pushing back.
 */
export async function loadSatisfactionAnswers(
  projectId: string,
  window: PageWindow,
  db: PageDb = getDb(),
  max: number = MAX_PAGE_ANSWERS,
): Promise<{ answers: PageAnswer[]; capped: boolean }> {
  const rows = await db
    .select({
      turnId: traceTurnOutcomes.turnId,
      sessionId: traceTurnOutcomes.sessionId,
      endedAt: traceTurnOutcomes.endedAt,
      satisfaction: traceTurnOutcomes.satisfaction,
      replyReaction: traceTurnOutcomes.replyReaction,
    })
    .from(traceTurnOutcomes)
    .where(
      and(
        inWindow(projectId, window),
        or(
          inArray(traceTurnOutcomes.satisfaction, [
            "satisfied",
            "unsatisfied",
            "neutral",
            "unknown",
          ]),
          and(
            sql`${traceTurnOutcomes.satisfaction} is null`,
            inArray(traceTurnOutcomes.replyReaction, [
              "satisfied",
              "corrects",
              "repeats",
              "asks_human",
              "new_request",
            ]),
          ),
        ),
      ),
    )
    .orderBy(desc(traceTurnOutcomes.endedAt), desc(traceTurnOutcomes.turnId))
    .limit(max + 1);
  const answers = rows.slice(0, max).map((row): PageAnswer => {
    const inferred = row.satisfaction === null;
    return {
      turnId: row.turnId,
      sessionId: row.sessionId,
      endedAt: row.endedAt,
      satisfied: inferred
        ? !["corrects", "repeats", "asks_human"].includes(row.replyReaction ?? "")
        : row.satisfaction !== "unsatisfied",
      inferred,
    };
  });
  return { answers, capped: rows.length > max };
}

/** Tasks read at most: a window with more is capped, newest first. */
export const MAX_PAGE_TASKS = 20_000;

/** The tasks that ended in the window, newest first, at most `max`. Closed values and ids only. */
export async function loadPageTasks(
  projectId: string,
  window: PageWindow,
  db: PageDb = getDb(),
  max: number = MAX_PAGE_TASKS,
): Promise<{ tasks: PageTask[]; capped: boolean }> {
  const rows = await db
    .select({
      taskId: traceTaskOutcomes.taskId,
      sessionId: traceTaskOutcomes.sessionId,
      turnIds: traceTaskOutcomes.turnIds,
      startedAt: traceTaskOutcomes.startedAt,
      endedAt: traceTaskOutcomes.endedAt,
      tier: traceTaskOutcomes.tier,
      goalSource: traceTaskOutcomes.goalSource,
      result: traceTaskOutcomes.result,
      reason: traceTaskOutcomes.reason,
      cause: traceTaskOutcomes.cause,
      checked: traceTaskOutcomes.checked,
    })
    .from(traceTaskOutcomes)
    .where(
      and(
        eq(traceTaskOutcomes.projectId, projectId),
        gte(traceTaskOutcomes.endedAt, window.from),
        lt(traceTaskOutcomes.endedAt, window.to),
      ),
    )
    .orderBy(desc(traceTaskOutcomes.endedAt), desc(traceTaskOutcomes.taskId))
    .limit(max + 1);
  return {
    tasks: rows
      .slice(0, max)
      .map((row) => ({ ...row, costUsd: null, tokens: null, friction: null })),
    capped: rows.length > max,
  };
}

/** The sessions that ended in the window, newest first, at most `max`. */
export async function loadPageSessions(
  projectId: string,
  window: PageWindow,
  db: PageDb = getDb(),
  max: number = MAX_PAGE_SESSIONS,
): Promise<{ sessions: PageSession[]; capped: boolean }> {
  const rows = await db
    .select({
      sessionId: traceSessionOutcomes.sessionId,
      outcome: traceSessionOutcomes.outcome,
      outcomeSource: traceSessionOutcomes.outcomeSource,
      frictionCount: traceSessionOutcomes.frictionCount,
      openRequest: traceSessionOutcomes.openRequest,
      endedAt: traceSessionOutcomes.endedAt,
    })
    .from(traceSessionOutcomes)
    .where(
      and(
        eq(traceSessionOutcomes.projectId, projectId),
        gte(traceSessionOutcomes.endedAt, window.from),
        lt(traceSessionOutcomes.endedAt, window.to),
      ),
    )
    .orderBy(desc(traceSessionOutcomes.endedAt), desc(traceSessionOutcomes.sessionId))
    .limit(max + 1);
  return { sessions: rows.slice(0, max), capped: rows.length > max };
}

export interface TurnTotals {
  turns: number;
  answered: number;
  satisfaction: Record<string, number>;
  reactions: Record<string, number>;
  /** How people took turns, inferred from the agent's next reply, by reaction. */
  replyReactions: Record<string, number>;
}

/** Every turn row of the window, counted: how many a model answered about, and what it answered. */
export async function loadTurnTotals(
  projectId: string,
  window: PageWindow,
  db: PageDb = getDb(),
): Promise<TurnTotals> {
  const rows = await db
    .select({
      satisfaction: traceTurnOutcomes.satisfaction,
      reaction: traceTurnOutcomes.reaction,
      replyReaction: traceTurnOutcomes.replyReaction,
      turns: sql<number>`count(*)`.mapWith(Number),
      answered: sql<number>`count(${traceTurnOutcomes.modelVersion})`.mapWith(Number),
    })
    .from(traceTurnOutcomes)
    .where(inWindow(projectId, window))
    .groupBy(
      traceTurnOutcomes.satisfaction,
      traceTurnOutcomes.reaction,
      traceTurnOutcomes.replyReaction,
    );
  const out: TurnTotals = {
    turns: 0,
    answered: 0,
    satisfaction: {},
    reactions: {},
    replyReactions: {},
  };
  for (const row of rows) {
    out.turns += row.turns;
    out.answered += row.answered;
    if (row.satisfaction)
      out.satisfaction[row.satisfaction] = (out.satisfaction[row.satisfaction] ?? 0) + row.turns;
    if (row.reaction) out.reactions[row.reaction] = (out.reactions[row.reaction] ?? 0) + row.turns;
    if (row.replyReaction)
      out.replyReactions[row.replyReaction] =
        (out.replyReactions[row.replyReaction] ?? 0) + row.turns;
  }
  return out;
}

/**
 * The person's messages in the window, counted and never read: the turn scopes
 * that sent one (`turn_start.user_message`), and how many of the window's
 * turn rows belong to such a scope. A turn with a message and no call has no
 * turn row, so the two differ.
 */
export async function countTextTurns(
  projectId: string,
  window: PageWindow,
  db: PageDb = getDb(),
): Promise<{ messages: number; turns: number }> {
  // A turn's message arrives before its last step: a day covers the longest turn.
  const from = new Date(window.from.getTime() - 86_400_000).toISOString();
  const result = await db.execute<{ messages: string | number; turns: string | number }>(sql`
    select count(*) filter (where coalesce(e.occurred_at, e.received_at) >= ${window.from.toISOString()}::timestamptz) as messages,
           count(distinct o.turn_id) as turns
      from trace_events e
      left join trace_turns t
        on t.project_id = e.project_id and t.session_id = e.session_id
       and t.turn_key = 'declared:' || coalesce(e.turn_id, e.payload ->> 'turn_id')
      left join trace_turn_outcomes o
        on o.turn_id = t.id and o.ended_at >= ${window.from.toISOString()}::timestamptz and o.ended_at < ${window.to.toISOString()}::timestamptz
     where e.project_id = ${projectId}::uuid and e.type = 'turn_start'
       and coalesce(e.occurred_at, e.received_at) >= ${from}::timestamptz
       and coalesce(e.occurred_at, e.received_at) < ${window.to.toISOString()}::timestamptz
       and coalesce(e.payload ->> 'user_message', '') <> ''
  `);
  const row = result.rows[0];
  return { messages: Number(row?.messages ?? 0), turns: Number(row?.turns ?? 0) };
}

const uuids = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/**
 * The intent of each turn: the cluster its ask landed in, read the way the
 * Intents breakdown reads it (`lib/intent-engine/breakdown-queries.ts`). A
 * declared turn's user message by (session, turn id), else an OTLP trace's
 * first prompt by trace id, else the turn's first search. The intent is the
 * cluster's level-2 group (what is acted on: "assign / create / update task"
 * all read "task"), else its level-1 group, else the cluster itself. A turn
 * the engine placed nowhere is absent.
 */
export async function loadTurnIntents(
  projectId: string,
  turnIds: readonly string[],
  db: PageDb = getDb(),
): Promise<Map<string, PageIntent>> {
  const clusterOf = new Map<string, string>();
  for (const ids of chunks([...new Set(turnIds)])) {
    const result = await db.execute<{ turn_id: string; cluster_id: string | null }>(sql`
      select t.id as turn_id,
             coalesce(
               (select a.cluster_id from intent_cluster_assignments a
                 where a.project_id = t.project_id and a.kind = 'user_message' and t.turn_source = 'declared'
                   and a.session_id = t.session_id and a.turn_id = substr(t.turn_key, 10)
                 order by a.occurred_at, a.trace_event_id, a.ask_index limit 1),
               (select a.cluster_id from intent_cluster_assignments a
                 where a.project_id = t.project_id and a.kind = 'prompt' and t.turn_source = 'otlp'
                   and a.trace_id = substr(t.turn_key, 6)
                 order by a.occurred_at, a.trace_event_id, a.ask_index limit 1),
               (select a.cluster_id from trace_turn_steps s
                  join intent_cluster_assignments a on a.trace_event_id = s.trace_event_id
                 where s.turn_id = t.id and s.kind = 'search'
                 order by s.ordinal, a.ask_index limit 1)
             ) as cluster_id
        from trace_turns t
       where t.project_id = ${projectId}::uuid and t.id in (${uuids(ids)})
    `);
    for (const row of result.rows) if (row.cluster_id) clusterOf.set(row.turn_id, row.cluster_id);
  }

  const named = async (ids: readonly string[], level: number) => {
    const out = new Map<string, { parentId: string | null; label: string }>();
    for (const chunk of chunks([...new Set(ids)])) {
      const rows = await db
        .select({
          id: intentClusters.id,
          parentId: intentClusters.parentId,
          label: intentClusters.label,
          llmLabel: intentClusters.llmLabel,
        })
        .from(intentClusters)
        .where(
          and(
            eq(intentClusters.projectId, projectId),
            eq(intentClusters.level, level),
            inArray(intentClusters.id, chunk),
          ),
        );
      for (const row of rows)
        out.set(row.id, {
          parentId: row.parentId,
          label: row.llmLabel?.trim() || row.label.trim(),
        });
    }
    return out;
  };
  const parentsOf = (nodes: Map<string, { parentId: string | null }>) =>
    [...nodes.values()].flatMap((node) => (node.parentId ? [node.parentId] : []));
  const clusters = await named([...clusterOf.values()], 0);
  const groups = await named(parentsOf(clusters), 1);
  const areas = await named(parentsOf(groups), 2);

  const out = new Map<string, PageIntent>();
  for (const [turnId, clusterId] of clusterOf) {
    const cluster = clusters.get(clusterId);
    if (!cluster) continue;
    const group = cluster.parentId ? groups.get(cluster.parentId) : undefined;
    const area = group?.parentId ? areas.get(group.parentId) : undefined;
    // The highest level the engine built for this cluster.
    const [id, node] =
      area && group?.parentId
        ? [group.parentId, area]
        : group && cluster.parentId
          ? [cluster.parentId, group]
          : [clusterId, cluster];
    out.set(turnId, { id, label: node.label || "Unnamed intent" });
  }
  return out;
}

/** The catalog version each turn ran on: the first of its steps' events that carries one. A turn that sent none is absent. */
/**
 * The calls of each of these turns that failed, its calls in all, and the
 * time a failure wasted: the failed call itself and the wait before the next
 * step (the agent reading the error and trying again).
 */
export async function loadFailedCalls(
  projectId: string,
  turnIds: readonly string[],
  db: PageDb = getDb(),
): Promise<Map<string, { failed: number; calls: number; wastedMs: number }>> {
  const out = new Map<string, { failed: number; calls: number; wastedMs: number }>();
  for (const ids of chunks([...new Set(turnIds)])) {
    const result = await db.execute<{
      turn_id: string;
      failed: string | number;
      calls: string | number;
      wasted_ms: string | number | null;
    }>(sql`
      select turn_id,
             count(*) filter (where outcome = 'error') as failed,
             count(*) as calls,
             sum(case when outcome = 'error' then coalesce(took_ms, 0) + coalesce(next_gap, 0) else 0 end) as wasted_ms
        from (
          select turn_id, outcome, took_ms, lead(gap_ms) over (partition by turn_id order by ordinal) as next_gap
            from trace_turn_steps
           where turn_id in (${uuids(ids)}) and project_id = ${projectId}::uuid and kind = 'invoke'
        ) steps
       group by turn_id
    `);
    for (const row of result.rows)
      out.set(row.turn_id, {
        failed: Number(row.failed),
        calls: Number(row.calls),
        wastedMs: Number(row.wasted_ms ?? 0),
      });
  }
  return out;
}

/** When each of these turns started and ended, from the outcome rows. */
export async function loadTurnTimes(
  projectId: string,
  turnIds: readonly string[],
  db: PageDb = getDb(),
): Promise<Map<string, { startedAt: Date; endedAt: Date }>> {
  const out = new Map<string, { startedAt: Date; endedAt: Date }>();
  for (const ids of chunks([...new Set(turnIds)])) {
    const rows = await db
      .select({
        turnId: traceTurnOutcomes.turnId,
        startedAt: traceTurnOutcomes.startedAt,
        endedAt: traceTurnOutcomes.endedAt,
      })
      .from(traceTurnOutcomes)
      .where(
        and(eq(traceTurnOutcomes.projectId, projectId), inArray(traceTurnOutcomes.turnId, ids)),
      );
    for (const row of rows) out.set(row.turnId, { startedAt: row.startedAt, endedAt: row.endedAt });
  }
  return out;
}

export async function loadTurnVersions(
  projectId: string,
  turnIds: readonly string[],
  db: PageDb = getDb(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const ids of chunks([...new Set(turnIds)])) {
    const result = await db.execute<{ turn_id: string; catalog_version: string }>(sql`
      select distinct on (s.turn_id) s.turn_id, e.catalog_version
        from trace_turn_steps s
        join trace_events e on e.id = s.trace_event_id
       where s.turn_id in (${uuids(ids)}) and e.project_id = ${projectId}::uuid
         and e.catalog_version is not null and e.catalog_version <> ''
       order by s.turn_id, s.ordinal
    `);
    for (const row of result.rows) out.set(row.turn_id, row.catalog_version);
  }
  return out;
}
