import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import type {
  FusionSource,
  ModelCause,
  TurnResult,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import {
  OUTCOME_QUESTION_VERSION,
  OUTCOME_RULE_VERSION,
  TASK_RULE_VERSION,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import type { TurnAnswerRow } from "@/lib/readings/trace-signals/outcomes/questions";
import type { SessionTurn } from "@/lib/readings/trace-signals/outcomes/read";
import type {
  SessionOutcomeRowDraft,
  TurnOutcomeRowDraft,
} from "@/lib/readings/trace-signals/outcomes/rows";
import { TASK_ANSWERS, type TaskVerdict } from "@/lib/readings/trace-signals/outcomes/tasks";
import {
  traceSessionOutcomes,
  traceTaskOutcomes,
  traceTurnOutcomes,
} from "@/lib/readings/trace-signals/schema";

/**
 * The database side of an outcome reading (`run.ts`): the error messages of
 * one page's failed calls, and the replacement of the window's turn rows and
 * of their sessions' rows.
 *
 * Replacing is an upsert of the rule layer's own columns, not a delete and
 * insert: the model layer's answers and the fusion's result on the same row
 * stay. A row the reading no longer produces (a turn it stopped trusting) is
 * deleted.
 *
 * PRIVACY: error messages leave the database only for the page being read and
 * are never logged or stored. Every read is bounded by ids.
 */

export type OutcomesDb = Pick<ReturnType<typeof getDb>, "select" | "transaction" | "execute">;

const ID_CHUNK = 500;
const INSERT_CHUNK = 500;

function chunks<T>(items: readonly T[], size: number = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The error messages of these `trace_events` rows, by id: the column ingest
 * fills, else the payload's `error` (rows a replay loaded). An event that is
 * pruned or carries no message is absent.
 */
export async function loadErrorMessages(
  projectId: string,
  eventIds: readonly string[],
  db: OutcomesDb = getDb(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const ids of chunks([...new Set(eventIds)])) {
    const rows = await db
      .select({
        id: traceEvents.id,
        message: sql<
          string | null
        >`coalesce(${traceEvents.errorMessage}, ${traceEvents.payload} ->> 'error')`,
      })
      .from(traceEvents)
      .where(and(eq(traceEvents.projectId, projectId), inArray(traceEvents.id, ids)));
    for (const row of rows) if (row.message) out.set(row.id, row.message);
  }
  return out;
}

/**
 * The cause a row keeps: the rule's when the rule decided one; else a cause a
 * model was asked for stays, since the rules left it open.
 */
const RULE_DECIDED = sql.raw(`excluded.cause is not null and excluded.cause <> 'other'`);
const KEPT_CAUSE = sql`case when ${RULE_DECIDED} then excluded.cause when trace_turn_outcomes.cause_source = 'model' then trace_turn_outcomes.cause else excluded.cause end`;
const KEPT_CAUSE_SOURCE = sql`case when ${RULE_DECIDED} then excluded.cause_source when trace_turn_outcomes.cause_source = 'model' then trace_turn_outcomes.cause_source else excluded.cause_source end`;

/**
 * A turn's steps never change once it is closed, so a second reading under the
 * same rules can only differ by error messages that have been pruned since. A
 * row that read more of them is kept as it is.
 */
const READS_AS_MUCH = sql.raw(
  `excluded.errors_unread = 0 or trace_turn_outcomes.rule_version <> excluded.rule_version or trace_turn_outcomes.errors_unread >= excluded.errors_unread`,
);

/**
 * Replace the rule layer's columns for the closed turns ending in `range`
 * with `rows`, in one transaction, so a page never reads a half-written
 * window. Rows of older turns stay. Returns the sessions whose turn rows were
 * written or deleted: the ones to fold again.
 */
export async function replaceTurnOutcomes(
  projectId: string,
  range: { from: Date; to: Date },
  rows: readonly TurnOutcomeRowDraft[],
  at: Date,
  db: OutcomesDb = getDb(),
): Promise<{ written: number; sessions: string[] }> {
  return db.transaction(async (tx) => {
    const window = tx
      .select({ id: traceTurns.id })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, projectId),
          eq(traceTurns.status, "closed"),
          gte(traceTurns.endedAt, range.from),
          lt(traceTurns.endedAt, range.to),
        ),
      );
    const existing = await tx
      .select({ turnId: traceTurnOutcomes.turnId, sessionId: traceTurnOutcomes.sessionId })
      .from(traceTurnOutcomes)
      .where(
        and(eq(traceTurnOutcomes.projectId, projectId), inArray(traceTurnOutcomes.turnId, window)),
      );
    const kept = new Set(rows.map((row) => row.turnId));
    const stale = existing.filter((row) => !kept.has(row.turnId));
    for (const chunk of chunks(stale)) {
      await tx.delete(traceTurnOutcomes).where(
        and(
          eq(traceTurnOutcomes.projectId, projectId),
          inArray(
            traceTurnOutcomes.turnId,
            chunk.map((row) => row.turnId),
          ),
        ),
      );
    }
    for (const chunk of chunks(rows, INSERT_CHUNK)) {
      await tx
        .insert(traceTurnOutcomes)
        .values(
          chunk.map((row) => ({
            ...row,
            projectId,
            causeSource: row.cause ? "rule" : null,
            ruleVersion: OUTCOME_RULE_VERSION,
            readAt: at,
          })),
        )
        .onConflictDoUpdate({
          target: traceTurnOutcomes.turnId,
          set: {
            sessionId: sql`excluded.session_id`,
            startedAt: sql`excluded.started_at`,
            endedAt: sql`excluded.ended_at`,
            cause: KEPT_CAUSE,
            causeSource: KEPT_CAUSE_SOURCE,
            followed: sql`excluded.followed`,
            failures: sql`excluded.failures`,
            okCalls: sql`excluded.ok_calls`,
            failedCalls: sql`excluded.failed_calls`,
            errorsUnread: sql`excluded.errors_unread`,
            unmetSearches: sql`excluded.unmet_searches`,
            catalogListings: sql`excluded.catalog_listings`,
            ruleVersion: sql`excluded.rule_version`,
            readAt: sql`excluded.read_at`,
          },
          setWhere: READS_AS_MUCH,
        });
    }
    return {
      written: rows.length,
      sessions: [...new Set([...rows, ...stale].map((row) => row.sessionId))].sort(),
    };
  });
}

/**
 * Write the model layer's answers on these turns' rows: closed values only.
 * A null answer leaves its column as it is, so an answer of an earlier run
 * stays when this run could not ask. A model's cause is written only where
 * the rules left the cause open (none, or `other`); the rule layer keeps it
 * there on its next reading.
 */
export async function writeTurnAnswers(
  projectId: string,
  rows: readonly TurnAnswerRow[],
  db: OutcomesDb = getDb(),
): Promise<void> {
  for (const chunk of chunks(rows)) {
    const values = sql.join(
      chunk.map(
        (row) =>
          sql`(${row.turnId}::uuid, ${row.satisfaction}::text, ${row.reaction}::text, ${row.claimedDone}::boolean, ${row.request}::boolean, ${row.cause}::text)`,
      ),
      sql`, `,
    );
    await db.execute(sql`
      update trace_turn_outcomes as o set
        satisfaction = coalesce(v.satisfaction, o.satisfaction),
        reaction = coalesce(v.reaction, o.reaction),
        claimed_done = coalesce(v.claimed_done, o.claimed_done),
        request = coalesce(v.request, o.request),
        cause = case when v.cause is not null and (o.cause is null or o.cause = 'other' or o.cause_source = 'model') then v.cause else o.cause end,
        cause_source = case when v.cause is not null and (o.cause is null or o.cause = 'other' or o.cause_source = 'model') then 'model' else o.cause_source end,
        model_version = ${OUTCOME_QUESTION_VERSION}
      from (values ${values}) as v(turn_id, satisfaction, reaction, claimed_done, request, cause)
      where o.project_id = ${projectId} and o.turn_id = v.turn_id
    `);
  }
}

/** A turn's fused result as it is written (`fusion.ts`). */
export interface TurnResultRow {
  turnId: string;
  result: TurnResult | null;
  source: FusionSource | null;
  /** A cause the fusion found; written only where the rules left the cause open. */
  cause: ModelCause | null;
}

/**
 * Write the fused result on these turns' rows. A result a model's answers
 * were part of is kept when this reading has only the rules to go by (no
 * key, or the questions could not be asked): the trace has not changed, and
 * the answers have not been taken back.
 */
export async function writeTurnResults(
  projectId: string,
  rows: readonly TurnResultRow[],
  db: OutcomesDb = getDb(),
): Promise<void> {
  for (const chunk of chunks(rows)) {
    const values = sql.join(
      chunk.map(
        (row) =>
          sql`(${row.turnId}::uuid, ${row.result}::text, ${row.source}::text, ${row.cause}::text)`,
      ),
      sql`, `,
    );
    await db.execute(sql`
      update trace_turn_outcomes as o set
        result = case when o.result_source = 'model' and v.source is distinct from 'model' then o.result else v.result end,
        result_source = case when o.result_source = 'model' and v.source is distinct from 'model' then o.result_source else v.source end,
        cause = case when v.cause is not null and (o.cause is null or o.cause = 'other' or o.cause_source = 'model') then v.cause else o.cause end,
        cause_source = case when v.cause is not null and (o.cause is null or o.cause = 'other' or o.cause_source = 'model') then 'model' else o.cause_source end
      from (values ${values}) as v(turn_id, result, source, cause)
      where o.project_id = ${projectId} and o.turn_id = v.turn_id
    `);
  }
}

/** Every stored turn row of these sessions, as the session fold reads them, by session id. */
export async function loadSessionTurns(
  projectId: string,
  sessionIds: readonly string[],
  db: OutcomesDb = getDb(),
): Promise<Map<string, SessionTurn[]>> {
  const out = new Map<string, SessionTurn[]>();
  for (const ids of chunks([...new Set(sessionIds)])) {
    const rows = await db
      .select({
        sessionId: traceTurnOutcomes.sessionId,
        turnId: traceTurnOutcomes.turnId,
        startedAt: traceTurnOutcomes.startedAt,
        endedAt: traceTurnOutcomes.endedAt,
        okCalls: traceTurnOutcomes.okCalls,
        failedCalls: traceTurnOutcomes.failedCalls,
        streaks: sql<number>`jsonb_array_length(${traceTurnOutcomes.failures})`.mapWith(Number),
        unmetSearches: traceTurnOutcomes.unmetSearches,
        catalogListings: traceTurnOutcomes.catalogListings,
        result: traceTurnOutcomes.result,
        resultSource: traceTurnOutcomes.resultSource,
        satisfaction: traceTurnOutcomes.satisfaction,
        reaction: traceTurnOutcomes.reaction,
        cause: traceTurnOutcomes.cause,
        request: traceTurnOutcomes.request,
        replyReaction: traceTurnOutcomes.replyReaction,
        replyReactionSource: traceTurnOutcomes.replyReactionSource,
        searches: traceTurns.searchCount,
      })
      .from(traceTurnOutcomes)
      .leftJoin(traceTurns, eq(traceTurns.id, traceTurnOutcomes.turnId))
      .where(
        and(eq(traceTurnOutcomes.projectId, projectId), inArray(traceTurnOutcomes.sessionId, ids)),
      );
    for (const { sessionId, searches, ...turn } of rows)
      out.set(sessionId, [...(out.get(sessionId) ?? []), { ...turn, searches: searches ?? 0 }]);
  }
  return out;
}

/**
 * Replace these sessions' rows with `rows`, in one transaction: the rule
 * layer's fold and the fusion's outcome, both read again from the session's
 * turn rows. A session among `sessionIds` with no row in `rows` loses its
 * row: its turns are gone, or sessions are no longer trusted.
 */
export async function replaceSessionOutcomes(
  projectId: string,
  sessionIds: readonly string[],
  rows: readonly SessionOutcomeRowDraft[],
  at: Date,
  db: OutcomesDb = getDb(),
): Promise<number> {
  const kept = new Set(rows.map((row) => row.sessionId));
  const gone = [...new Set(sessionIds)].filter((id) => !kept.has(id));
  return db.transaction(async (tx) => {
    for (const ids of chunks(gone)) {
      await tx
        .delete(traceSessionOutcomes)
        .where(
          and(
            eq(traceSessionOutcomes.projectId, projectId),
            inArray(traceSessionOutcomes.sessionId, ids),
          ),
        );
    }
    for (const chunk of chunks(rows, INSERT_CHUNK)) {
      await tx
        .insert(traceSessionOutcomes)
        .values(
          chunk.map((row) => ({
            ...row,
            projectId,
            ruleVersion: OUTCOME_RULE_VERSION,
            readAt: at,
          })),
        )
        .onConflictDoUpdate({
          target: [traceSessionOutcomes.projectId, traceSessionOutcomes.sessionId],
          set: {
            outcome: sql`excluded.outcome`,
            outcomeSource: sql`excluded.outcome_source`,
            frictionCount: sql`excluded.friction_count`,
            turnCount: sql`excluded.turn_count`,
            firstTurnId: sql`excluded.first_turn_id`,
            lastTurnId: sql`excluded.last_turn_id`,
            startedAt: sql`excluded.started_at`,
            endedAt: sql`excluded.ended_at`,
            openRequest: sql`excluded.open_request`,
            unmetSearches: sql`excluded.unmet_searches`,
            catalogListings: sql`excluded.catalog_listings`,
            ruleVersion: sql`excluded.rule_version`,
            readAt: sql`excluded.read_at`,
          },
        });
    }
    return rows.length;
  });
}

/** One `trace_task_outcomes` row, minus its project and version. */
export interface TaskOutcomeRowDraft {
  taskId: string;
  sessionId: string;
  turnIds: string[];
  startedAt: Date;
  endedAt: Date;
  goalSource: string;
  tier: string;
  result: string;
  reason: string | null;
  cause: string | null;
  checked: boolean;
  resultSource: string;
  answer: string | null;
  answerProbability: number | null;
}

/** The task question's stored answers of these sessions' tasks, by task id: a fold the question did not reach reuses them. */
export async function loadTaskVerdicts(
  projectId: string,
  sessionIds: readonly string[],
  db: OutcomesDb = getDb(),
): Promise<Map<string, TaskVerdict>> {
  const out = new Map<string, TaskVerdict>();
  for (const ids of chunks([...new Set(sessionIds)])) {
    const rows = await db
      .select({
        taskId: traceTaskOutcomes.taskId,
        answer: traceTaskOutcomes.answer,
        probability: traceTaskOutcomes.answerProbability,
      })
      .from(traceTaskOutcomes)
      .where(
        and(eq(traceTaskOutcomes.projectId, projectId), inArray(traceTaskOutcomes.sessionId, ids)),
      );
    for (const row of rows) {
      const answer = TASK_ANSWERS.find((known) => known === row.answer);
      if (answer) out.set(row.taskId, { answer, probability: row.probability });
    }
  }
  return out;
}

/** Replace these sessions' task rows with `rows`, in one transaction. */
export async function replaceTaskOutcomes(
  projectId: string,
  sessionIds: readonly string[],
  rows: readonly TaskOutcomeRowDraft[],
  at: Date,
  db: OutcomesDb = getDb(),
): Promise<number> {
  return db.transaction(async (tx) => {
    for (const ids of chunks([...new Set(sessionIds)])) {
      await tx
        .delete(traceTaskOutcomes)
        .where(
          and(
            eq(traceTaskOutcomes.projectId, projectId),
            inArray(traceTaskOutcomes.sessionId, ids),
          ),
        );
    }
    for (const chunk of chunks(rows, INSERT_CHUNK)) {
      await tx
        .insert(traceTaskOutcomes)
        .values(
          chunk.map((row) => ({ ...row, projectId, ruleVersion: TASK_RULE_VERSION, readAt: at })),
        );
    }
    return rows.length;
  });
}

/** One turn's reaction inferred from the agent's next reply; null clears it. */
export interface ReplyReactionRow {
  turnId: string;
  reaction: string | null;
  source: "rule" | "model" | null;
}

/**
 * Writes the inferred reactions on the turns' rows: every turn read gets its
 * value, or null. A model's reading is kept when this reading has only the
 * rules to go by, as `writeTurnResults` keeps a model's result.
 */
export async function writeReplyReactions(
  projectId: string,
  rows: readonly ReplyReactionRow[],
  db: OutcomesDb = getDb(),
): Promise<void> {
  if (rows.length === 0) return;
  await db.transaction(async (tx) => {
    for (const chunk of chunks(rows, INSERT_CHUNK)) {
      const values = sql.join(
        chunk.map((row) => sql`(${row.turnId}::uuid, ${row.reaction}::text, ${row.source}::text)`),
        sql`, `,
      );
      await tx.execute(sql`
        update trace_turn_outcomes as o
           set reply_reaction = case when o.reply_reaction_source = 'model' and v.source is distinct from 'model' then o.reply_reaction else v.reaction end,
               reply_reaction_source = case when o.reply_reaction_source = 'model' and v.source is distinct from 'model' then o.reply_reaction_source else v.source end
          from (values ${values}) as v(turn_id, reaction, source)
         where o.project_id = ${projectId}::uuid and o.turn_id = v.turn_id
      `);
    }
  });
}
