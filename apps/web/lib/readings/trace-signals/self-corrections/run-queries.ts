import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { nodeIdOf } from "@/lib/readings/tool-explorer/units";
import { traceTopics, traceTurnTopics } from "@/lib/readings/topics/schema";
import { traceSelfCorrections } from "@/lib/readings/trace-signals/schema";
import {
  type CapturedReply,
  replyTextOf,
} from "@/lib/readings/trace-signals/self-corrections/replies";
import type { CorrectionRowDraft } from "@/lib/readings/trace-signals/self-corrections/rows";
import type { PageFacts } from "@/lib/readings/trace-signals/self-corrections/run";
import {
  OTLP_MODEL_CALL_TYPE,
  otelTraceIdOf,
} from "@/lib/readings/trace-signals/signals/otel-facts";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * The database side of a self-correction reading (`run.ts`): what one page of
 * turns needs (captured replies, empty results, the task and topic of each
 * turn, the user's words), and the replacement of the window's rows.
 *
 * Replies are read from `events` by trace: a turn's own (`otlp:<trace id>`)
 * and those its steps' events carry. New rows carry `events.trace_id`, so the
 * join is exact; rows stored before it are found by their dedupe hash, which
 * is the sha256 of their span id unless the provider's response id was set.
 * Only each call's trailing assistant messages leave the database, never its
 * input, and only text is kept from them (`replyTextOf`).
 *
 * PRIVACY: reply and ask text live in memory for the length of a page; they
 * are never logged or stored. Every read is bounded by the page's ids.
 */

export type CorrectionsDb = Pick<ReturnType<typeof getDb>, "select" | "execute" | "transaction">;

const ID_CHUNK = 500;
const INSERT_CHUNK = 500;

function chunks<T>(items: readonly T[], size: number = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const idList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

/** The messages array of a stored call, or an empty array. */
const MESSAGES = sql`case when jsonb_typeof(ev.payload -> 'messages') = 'array' then ev.payload -> 'messages' else '[]'::jsonb end`;

/**
 * A call's trailing assistant messages (as `reply`), for an `events` row
 * aliased `ev`: those after its last message that is not the assistant's.
 * `replyTextOf` reads the same text from these as from the whole array. The
 * example read (`example.ts`) uses the same query, so ranges line up.
 */
export const TRAILING_ASSISTANT = sql`
  select coalesce(jsonb_agg(m.value order by m.ord), '[]'::jsonb) as reply
  from jsonb_array_elements(${MESSAGES}) with ordinality as m(value, ord)
  where m.ord > coalesce((
    select max(n.ord) from jsonb_array_elements(${MESSAGES}) with ordinality as n(value, ord)
    where n.value ->> 'role' is distinct from 'assistant'
  ), 0)`;

export interface ReplyRow {
  id: string;
  traceId: string;
  at: Date;
  reply: unknown;
}

type RawReplyRow = {
  id: string;
  trace_id: string;
  at: string | Date;
  reply: unknown;
};

const toReplyRow = (row: RawReplyRow): ReplyRow => ({
  id: row.id,
  traceId: row.trace_id,
  at: row.at instanceof Date ? row.at : new Date(row.at),
  reply: typeof row.reply === "string" ? JSON.parse(row.reply) : row.reply,
});

/** Calls of these traces with a reply: exact by `events.trace_id`, else by the span-id dedupe hash. */
export async function loadReplyRows(
  projectId: string,
  traceIds: readonly string[],
  db: CorrectionsDb = getDb(),
): Promise<ReplyRow[]> {
  const out = new Map<string, ReplyRow>();
  for (const ids of chunks([...new Set(traceIds)].sort())) {
    const exact = await db.execute<RawReplyRow>(sql`
      select ev.id, ev.trace_id, coalesce(ev.occurred_at, ev.received_at) as at, r.reply
      from events ev
      cross join lateral (${TRAILING_ASSISTANT}) r
      where ev.project_id = ${projectId} and ev.trace_id in (${idList(ids)}) and jsonb_array_length(r.reply) > 0`);
    const hashed = await db.execute<RawReplyRow>(sql`
      select ev.id, sp.trace_id, coalesce(ev.occurred_at, ev.received_at) as at, r.reply
      from otel_spans sp
      join events ev
        on ev.project_id = sp.project_id
       and ev.dedupe_hash = encode(sha256(convert_to(sp.span_id, 'UTF8')), 'hex')
       and ev.trace_id is null
      cross join lateral (${TRAILING_ASSISTANT}) r
      where sp.project_id = ${projectId} and sp.trace_id in (${idList(ids)}) and jsonb_array_length(r.reply) > 0`);
    for (const row of [...exact.rows, ...hashed.rows])
      if (!out.has(row.id)) out.set(row.id, toReplyRow(row));
  }
  return [...out.values()];
}

/** The traces each turn ran in, by turn id: its own, and those its steps' events carry. */
export async function loadTurnTraces(
  projectId: string,
  turns: readonly Pick<SignalTurn, "id" | "lane" | "turnKey">[],
  db: CorrectionsDb = getDb(),
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const add = (turnId: string, traceId: string) =>
    out.set(turnId, (out.get(turnId) ?? new Set<string>()).add(traceId));
  for (const turn of turns) {
    const own = otelTraceIdOf(turn);
    if (own) add(turn.id, own);
  }
  for (const ids of chunks(turns.map((turn) => turn.id))) {
    const rows = await db
      .select({ turnId: traceTurnSteps.turnId, traceId: traceEvents.traceId })
      .from(traceTurnSteps)
      .innerJoin(traceEvents, eq(traceEvents.id, traceTurnSteps.traceEventId))
      .where(
        and(
          inArray(traceTurnSteps.turnId, ids),
          eq(traceEvents.projectId, projectId),
          isNotNull(traceEvents.traceId),
        ),
      )
      .groupBy(traceTurnSteps.turnId, traceEvents.traceId);
    for (const row of rows) if (row.traceId) add(row.turnId, row.traceId);
  }
  return out;
}

type TimedTurn = Pick<SignalTurn, "id" | "startedAt" | "endedAt">;

function distance(turn: TimedTurn, at: number): number {
  if (at < turn.startedAt.getTime()) return turn.startedAt.getTime() - at;
  if (at > turn.endedAt.getTime()) return at - turn.endedAt.getTime();
  return 0;
}

/**
 * Each reply to one turn: the only turn of its trace, or, when several runs
 * share a trace, the one nearest in time (ties to the earlier start). Rows
 * without reply text are dropped.
 */
export function repliesByTurn(
  rows: readonly ReplyRow[],
  turns: readonly TimedTurn[],
  traces: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, CapturedReply[]> {
  const turnsOfTrace = new Map<string, TimedTurn[]>();
  for (const turn of turns) {
    for (const traceId of traces.get(turn.id) ?? [])
      turnsOfTrace.set(traceId, [...(turnsOfTrace.get(traceId) ?? []), turn]);
  }
  const out = new Map<string, CapturedReply[]>();
  for (const row of rows) {
    const text = replyTextOf(row.reply);
    const candidates = turnsOfTrace.get(row.traceId) ?? [];
    if (!text || candidates.length === 0) continue;
    const at = row.at.getTime();
    const owner = [...candidates].sort(
      (a, b) => distance(a, at) - distance(b, at) || a.startedAt.getTime() - b.startedAt.getTime(),
    )[0]!;
    out.set(owner.id, [...(out.get(owner.id) ?? []), { eventId: row.id, at: row.at, text }]);
  }
  return out;
}

/** The ids of these tool-call events whose captured result was empty. */
export async function loadEmptyEvents(
  projectId: string,
  eventIds: readonly string[],
  db: CorrectionsDb = getDb(),
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ids of chunks([...new Set(eventIds)])) {
    const rows = await db
      .select({ id: traceEvents.id })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          inArray(traceEvents.id, ids),
          sql`${traceEvents.payload} ->> 'result_empty' = 'true'`,
        ),
      );
    for (const row of rows) out.add(row.id);
  }
  return out;
}

/** Each turn's task and topic, by turn id. */
export async function loadPlacements(
  projectId: string,
  turnIds: readonly string[],
  db: CorrectionsDb = getDb(),
): Promise<{ workflows: Map<string, string>; topics: Map<string, string> }> {
  const workflows = new Map<string, string>();
  const topics = new Map<string, string>();
  for (const ids of chunks(turnIds)) {
    const rows = await db
      .select({
        id: traceTurns.id,
        workflowId: traceTurns.workflowId,
        topicId: traceTurnTopics.topicId,
      })
      .from(traceTurns)
      .leftJoin(
        traceTurnTopics,
        and(eq(traceTurnTopics.turnId, traceTurns.id), eq(traceTurnTopics.verdict, "topic")),
      )
      .where(and(eq(traceTurns.projectId, projectId), inArray(traceTurns.id, ids)));
    for (const row of rows) {
      if (row.workflowId) workflows.set(row.id, row.workflowId);
      if (row.topicId) topics.set(row.id, row.topicId);
    }
  }
  return { workflows, topics };
}

/** The user's words that opened each trace: its first model call's captured prompt, by trace id. */
export async function loadAsks(
  projectId: string,
  traceIds: readonly string[],
  db: CorrectionsDb = getDb(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const ids of chunks([...new Set(traceIds)].sort())) {
    const rows = await db.execute<{ trace_id: string; prompt: string }>(sql`
      select distinct on (e.trace_id) e.trace_id, e.payload ->> 'prompt' as prompt
      from trace_events e
      where e.project_id = ${projectId}
        and e.type = ${OTLP_MODEL_CALL_TYPE}
        and e.trace_id in (${idList(ids)})
        and jsonb_typeof(e.payload -> 'prompt') = 'string'
      order by e.trace_id, coalesce(e.occurred_at, e.received_at), e.id`);
    for (const row of rows.rows) if (row.prompt) out.set(row.trace_id, row.prompt);
  }
  return out;
}

/** Everything one page of read turns needs beyond its steps. */
export async function loadCorrectionPageFacts(
  projectId: string,
  turns: readonly SignalTurn[],
  db: CorrectionsDb = getDb(),
): Promise<PageFacts> {
  const placements = await loadPlacements(
    projectId,
    turns.map((turn) => turn.id),
    db,
  );
  const traces = await loadTurnTraces(projectId, turns, db);
  const traceIds = [...new Set([...traces.values()].flatMap((ids) => [...ids]))];
  const replies = repliesByTurn(await loadReplyRows(projectId, traceIds, db), turns, traces);
  const callEvents = turns.flatMap((turn) =>
    turn.steps
      .filter((step) => nodeIdOf(step) !== null)
      .flatMap((step) => [
        step.traceEventId,
        ...(step.endTraceEventId ? [step.endTraceEventId] : []),
      ]),
  );
  const emptyEvents =
    callEvents.length > 0 ? await loadEmptyEvents(projectId, callEvents, db) : new Set<string>();
  const own = turns.flatMap((turn) => {
    const traceId = otelTraceIdOf(turn);
    return traceId ? [{ turnId: turn.id, traceId }] : [];
  });
  const prompts =
    own.length > 0
      ? await loadAsks(
          projectId,
          own.map((entry) => entry.traceId),
          db,
        )
      : new Map<string, string>();
  const asks = new Map(
    own.flatMap(({ turnId, traceId }) =>
      prompts.has(traceId) ? [[turnId, prompts.get(traceId)!] as const] : [],
    ),
  );
  return { replies, emptyEvents, workflows: placements.workflows, topics: placements.topics, asks };
}

/** Topic names by id, retired ones included (old rows may point at them). */
export async function loadTopicNames(
  projectId: string,
  db: CorrectionsDb = getDb(),
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: traceTopics.topicId, name: traceTopics.name })
    .from(traceTopics)
    .where(eq(traceTopics.projectId, projectId));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * Replace the rows of the closed turns ending in `range` with `rows`, in one
 * transaction, so a page never reads a half-written window. Rows of older
 * turns stay: they are the history the page's trend compares against.
 */
export async function replaceSelfCorrections(
  projectId: string,
  range: { from: Date; to: Date },
  rows: readonly CorrectionRowDraft[],
  db: CorrectionsDb = getDb(),
): Promise<number> {
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
    await tx
      .delete(traceSelfCorrections)
      .where(
        and(
          eq(traceSelfCorrections.projectId, projectId),
          inArray(traceSelfCorrections.turnId, window),
        ),
      );
    for (const chunk of chunks(rows, INSERT_CHUNK)) {
      await tx.insert(traceSelfCorrections).values(chunk.map((row) => ({ ...row, projectId })));
    }
    return rows.length;
  });
}
