import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { GEN_AI } from "@/lib/ingest/otlp/constants";
import { buildTraceContentView } from "@/lib/ingest/otlp/content-view";
import { OTLP_MODEL_CALL } from "@/lib/ingest/otlp/derive-model-calls";
import { events, otelSpans } from "@/lib/ingest/otlp/schema";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import { replyTextOf } from "@/lib/readings/trace-signals/self-corrections/replies";

/**
 * A model call's own reply: its last message, when the assistant wrote text in
 * it. Not every trailing assistant message: where the person's messages were
 * redacted out of the input, earlier replies sit right before it with nothing
 * between, and they are not this call's words.
 */
export function finalReplyOf(messages: unknown): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  return replyTextOf([messages[messages.length - 1]]);
}

import {
  OTLP_TURN_PREFIX,
  type SessionMessage,
} from "@/lib/readings/trace-signals/outcomes/model-read";

/**
 * The captured text the model layer reads (`model-read.ts`): the messages
 * people sent, the agent's replies and its search queries.
 *
 * PRIVACY: every read is bounded by the ids of one run's turns, and what is
 * read is handed to the caller to build questions from and drop. Nothing
 * here stores or logs text.
 */

export type TextDb = Pick<ReturnType<typeof getDb>, "select">;

const CHUNK = 500;
/** How far before the window a session's earlier message is still read as the exchange before a turn. */
const BEFORE_MS = 24 * 60 * 60 * 1000;
/** How far after the window a person's next message is still read. */
const AFTER_MS = 60 * 60 * 1000;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/**
 * The messages people sent in these sessions around `range`, as SDK turn
 * scopes recorded them (`turn_start.user_message`), oldest first. A turn
 * scope with no message, or no turn id, is left out.
 */
export async function loadSessionMessages(
  projectId: string,
  sessionIds: readonly string[],
  range: { from: Date; to: Date },
  db: TextDb = getDb(),
): Promise<SessionMessage[]> {
  const from = new Date(range.from.getTime() - BEFORE_MS);
  const to = new Date(range.to.getTime() + AFTER_MS);
  const at = sql<Date>`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
  const out: SessionMessage[] = [];
  for (const ids of chunks([...new Set(sessionIds)])) {
    const rows = await db
      .select({
        sessionId: traceEvents.sessionId,
        turnId: sql<
          string | null
        >`coalesce(${traceEvents.turnId}, ${traceEvents.payload} ->> 'turn_id')`,
        traceId: traceEvents.traceId,
        text: sql<string | null>`${traceEvents.payload} ->> 'user_message'`,
        at: at.mapWith((value: string | Date) => new Date(value)),
      })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          eq(traceEvents.type, "turn_start"),
          inArray(traceEvents.sessionId, ids),
          sql`${at} >= ${from} and ${at} <= ${to}`,
          sql`coalesce(${traceEvents.payload} ->> 'user_message', '') <> ''`,
        ),
      )
      .orderBy(asc(at));
    for (const row of rows) {
      const text = row.text?.trim();
      if (!row.sessionId || !row.turnId || !text) continue;
      out.push({
        sessionId: row.sessionId,
        turnId: row.turnId,
        traceId: row.traceId,
        text,
        at: row.at,
      });
    }
  }
  return out;
}

/**
 * The prompts of these sessions' OTel runs around `range`, oldest first: each
 * trace's first model call that carries one (`payload.prompt`, the ask as
 * Topics reads it), under the run's ledger key (`otlp:<trace id>`).
 */
export async function loadOtlpSessionPrompts(
  projectId: string,
  sessionIds: readonly string[],
  range: { from: Date; to: Date },
  db: TextDb = getDb(),
): Promise<SessionMessage[]> {
  const from = new Date(range.from.getTime() - BEFORE_MS);
  const to = new Date(range.to.getTime() + AFTER_MS);
  const at = sql<Date>`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
  const out: SessionMessage[] = [];
  for (const ids of chunks([...new Set(sessionIds)])) {
    const rows = await db
      .select({
        sessionId: traceEvents.sessionId,
        traceId: traceEvents.traceId,
        text: sql<string | null>`${traceEvents.payload} ->> 'prompt'`,
        at: at.mapWith((value: string | Date) => new Date(value)),
      })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          eq(traceEvents.type, OTLP_MODEL_CALL),
          inArray(traceEvents.sessionId, ids),
          sql`${at} >= ${from} and ${at} <= ${to}`,
          sql`coalesce(${traceEvents.payload} ->> 'prompt', '') <> ''`,
        ),
      )
      .orderBy(asc(at));
    const seen = new Set<string>();
    for (const row of rows) {
      const text = row.text?.trim();
      if (!row.sessionId || !row.traceId || !text || seen.has(row.traceId)) continue;
      seen.add(row.traceId);
      out.push({
        sessionId: row.sessionId,
        turnId: `${OTLP_TURN_PREFIX}${row.traceId}`,
        traceId: row.traceId,
        text,
        at: row.at,
      });
    }
  }
  return out;
}

/**
 * The agent's final reply of each of these traces: the reply of the last model
 * call that wrote any text. Content capture keeps a model call whole in
 * `events.payload.messages` (the input, then the output), while ingest strips
 * the same text from `otel_spans` (RC-449), so the calls are read first and a
 * span's output attribute is only the fallback for a trace with no stored
 * call. A trace with no captured output is absent.
 */
export async function loadReplies(
  projectId: string,
  traceIds: readonly string[],
  db: TextDb = getDb(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const ids of chunks([...new Set(traceIds)])) {
    const calls = await db
      .select({ traceId: events.traceId, messages: sql<unknown>`${events.payload} -> 'messages'` })
      .from(events)
      .where(and(eq(events.projectId, projectId), inArray(events.traceId, ids)))
      .orderBy(asc(sql`coalesce(${events.occurredAt}, ${events.receivedAt})`), asc(events.id));
    for (const call of calls) {
      const reply = call.traceId ? finalReplyOf(call.messages) : null;
      // Oldest first, so the last call that wrote text is the one kept.
      if (reply && call.traceId) out.set(call.traceId, reply);
    }
    const missing = ids.filter((id) => !out.has(id));
    if (missing.length === 0) continue;
    const rows = await db
      .select({
        traceId: otelSpans.traceId,
        spanId: otelSpans.spanId,
        output: sql<unknown>`${otelSpans.attributes} -> ${GEN_AI.outputMessages}`,
      })
      .from(otelSpans)
      .where(
        and(
          eq(otelSpans.projectId, projectId),
          inArray(otelSpans.traceId, missing),
          sql`jsonb_exists(${otelSpans.attributes}, ${GEN_AI.outputMessages})`,
        ),
      )
      .orderBy(asc(otelSpans.endedAt));
    for (const row of rows) {
      const view = buildTraceContentView([
        {
          spanId: row.spanId,
          name: "",
          spanClass: "llm",
          durationMs: 0,
          statusCode: 0,
          attributes: { [GEN_AI.outputMessages]: row.output },
        },
      ]);
      const reply = view.messages.findLast(
        (message) => message.role === "assistant" && message.text.trim() !== "",
      );
      if (reply) out.set(row.traceId, reply.text);
    }
  }
  return out;
}

/** The query text of these search events, by event id; an event with none is absent. */
export async function loadSearchQueries(
  projectId: string,
  eventIds: readonly string[],
  db: TextDb = getDb(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const ids of chunks([...new Set(eventIds)])) {
    const rows = await db
      .select({ id: traceEvents.id, query: traceEvents.query })
      .from(traceEvents)
      .where(and(eq(traceEvents.projectId, projectId), inArray(traceEvents.id, ids)));
    for (const row of rows) if (row.query?.trim()) out.set(row.id, row.query);
  }
  return out;
}

/**
 * The agent's reply in each of these turns, by turn id: the reply of the trace
 * the turn's first steps belong to (`loadReplies`). A turn whose trace has no
 * captured output is absent.
 */
export async function loadTurnReplies(
  projectId: string,
  turns: ReadonlyArray<readonly [string, readonly string[]]>,
  db: TextDb = getDb(),
): Promise<Map<string, string>> {
  const eventIds = [...new Set(turns.flatMap(([, ids]) => ids))];
  const traceOf = new Map<string, string>();
  for (const ids of chunks(eventIds)) {
    const rows = await db
      .select({ id: traceEvents.id, traceId: traceEvents.traceId })
      .from(traceEvents)
      .where(and(eq(traceEvents.projectId, projectId), inArray(traceEvents.id, ids)));
    for (const row of rows) if (row.traceId) traceOf.set(row.id, row.traceId);
  }
  const turnTrace = new Map<string, string>();
  for (const [turnId, ids] of turns) {
    const trace = ids.map((id) => traceOf.get(id)).find((id) => id !== undefined);
    if (trace) turnTrace.set(turnId, trace);
  }
  const replies =
    turnTrace.size > 0
      ? await loadReplies(projectId, [...new Set(turnTrace.values())], db)
      : new Map<string, string>();
  const out = new Map<string, string>();
  for (const [turnId, trace] of turnTrace) {
    const reply = replies.get(trace);
    if (reply) out.set(turnId, reply);
  }
  return out;
}

/**
 * The agent's reply in the turn scope after each of these turns, by turn id,
 * where the SDK reports turn scopes (`turn_start`): the scopes of the turn's
 * session in order, and the reply of the trace of the scope after the turn's
 * own. A scope with no call (a "thanks" the agent answered) has no turn of its
 * own, but its reply is still the one after the turn before it. A turn whose
 * session reports no scopes is absent. A turn of a session that does, with
 * nothing to read, maps to "": it is its session's last, its next scope
 * carries the person's own message (their words are read instead,
 * `model-read.ts`, never guessed from the reply), or no reply was captured.
 */
export async function loadNextScopeReplies(
  projectId: string,
  turns: ReadonlyArray<readonly [turnId: string, sessionId: string, eventIds: readonly string[]]>,
  db: TextDb = getDb(),
): Promise<Map<string, string>> {
  const eventIds = [...new Set(turns.flatMap(([, , ids]) => ids))];
  const traceOf = new Map<string, string>();
  for (const ids of chunks(eventIds)) {
    const rows = await db
      .select({ id: traceEvents.id, traceId: traceEvents.traceId })
      .from(traceEvents)
      .where(and(eq(traceEvents.projectId, projectId), inArray(traceEvents.id, ids)));
    for (const row of rows) if (row.traceId) traceOf.set(row.id, row.traceId);
  }
  const scopes = new Map<string, string[]>();
  const worded = new Set<string>();
  for (const ids of chunks([...new Set(turns.map(([, sessionId]) => sessionId))])) {
    const rows = await db
      .select({
        sessionId: traceEvents.sessionId,
        traceId: traceEvents.traceId,
        worded: sql<boolean>`coalesce(${traceEvents.payload} ->> 'user_message', '') <> ''`,
      })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          eq(traceEvents.type, "turn_start"),
          inArray(traceEvents.sessionId, ids),
        ),
      )
      .orderBy(
        asc(sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`),
        asc(traceEvents.id),
      );
    for (const row of rows) {
      if (!row.sessionId || !row.traceId) continue;
      if (row.worded) worded.add(row.traceId);
      const list = scopes.get(row.sessionId) ?? [];
      // A scope reported twice keeps its first place.
      if (!list.includes(row.traceId)) list.push(row.traceId);
      scopes.set(row.sessionId, list);
    }
  }
  const nextTrace = new Map<string, string>();
  const scoped = new Set<string>();
  for (const [turnId, sessionId, ids] of turns) {
    const trace = ids.map((id) => traceOf.get(id)).find((id) => id !== undefined);
    const list = scopes.get(sessionId);
    if (!trace || !list || !list.includes(trace)) continue;
    scoped.add(turnId);
    const next = list[list.indexOf(trace) + 1];
    if (next && !worded.has(next)) nextTrace.set(turnId, next);
  }
  const replies =
    nextTrace.size > 0
      ? await loadReplies(projectId, [...new Set(nextTrace.values())], db)
      : new Map<string, string>();
  const out = new Map<string, string>();
  for (const turnId of scoped) out.set(turnId, replies.get(nextTrace.get(turnId) ?? "") ?? "");
  return out;
}
