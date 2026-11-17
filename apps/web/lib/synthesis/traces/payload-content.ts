import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import { OTLP_MODEL_CALL } from "@/lib/ingest/otlp/derive-model-calls";
import { events } from "@/lib/ingest/otlp/schema";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  messageText,
  type TraceContentView,
  type TraceMessageView,
  type TraceToolCallView,
  toolResults,
} from "./content-view";

/**
 * A trace's captured content read from `events.payload` (RC-393). OTLP ingest
 * strips message content from `otel_spans.attributes` by design and keeps it
 * in each model call's ADR-0013 payload, joined by the trace id. The pages and
 * the MCP tools read the spans first and fall back to this when the spans
 * carry none.
 *
 * PRIVACY: message text is read only for one trace (or one ask per run) the
 * caller may already see; nothing here logs it.
 */

export type PayloadDb = Pick<ReturnType<typeof getDb>, "select" | "selectDistinctOn">;

/** One model call's stored payload. */
export interface PayloadCall {
  eventId: string;
  spanId: string | null;
  occurredAt: Date;
  latencyMs: number | null;
  payload: CloudEvent;
}

export interface PayloadContent {
  view: TraceContentView;
  /** What the person asked: from the payload, else the prompt ingest derived into `trace_events`. */
  ask: string | null;
}

export const PAYLOAD_CONTENT_FLAG = "cloud-payload-content" as const;

/** Calls read per trace. Every call repeats the history, so the first ones and the latest ones tell the whole run. */
const MAX_CALLS = 200;
const FIRST_CALLS = 20;
const ID_CHUNK = 500;

const EVENT_TIME = sql`coalesce(${events.occurredAt}, ${events.receivedAt})`;
/** A user message with text in an ADR-0013 payload, tested in the database. */
const HAS_USER_TEXT = sql<boolean>`jsonb_path_exists(${events.payload}, '$.messages[*] ? (@.role == "user" && ((@.content.type() == "string" && @.content != "") || exists(@.content[*] ? (@.type == "text" && @.text != ""))))')`;
const DERIVED_PROMPT = sql<string>`btrim(${traceEvents.payload} ->> 'prompt')`;
const logger = getLogger("traces/payload-content");

/** The trace's payload content, or null when it has neither stored calls nor a derived ask. */
export async function loadPayloadContent(
  projectId: string,
  traceId: string,
  db: PayloadDb = getDb(),
): Promise<PayloadContent | null> {
  const inTrace = and(
    eq(events.projectId, projectId),
    eq(events.traceId, traceId),
    isNotNull(events.payload),
  );
  const ids = await db
    .select({ id: events.id })
    .from(events)
    .where(inTrace)
    .orderBy(EVENT_TIME, asc(events.id));
  const picked =
    ids.length > MAX_CALLS
      ? [...ids.slice(0, FIRST_CALLS), ...ids.slice(ids.length - (MAX_CALLS - FIRST_CALLS))]
      : ids;
  const rows =
    picked.length > 0
      ? await db
          .select({
            eventId: events.id,
            spanId: events.spanId,
            occurredAt: EVENT_TIME.mapWith(events.occurredAt),
            latencyMs: events.latencyMs,
            payload: events.payload,
          })
          .from(events)
          .where(
            and(
              inTrace,
              inArray(
                events.id,
                picked.map((row) => row.id),
              ),
            ),
          )
      : [];
  const calls = rows.flatMap((row): PayloadCall[] =>
    row.payload ? [{ ...row, payload: row.payload }] : [],
  );
  const content = buildPayloadContent(calls);
  const ask = content.ask ?? (await derivedAsks(projectId, [traceId], db)).get(traceId) ?? null;
  if (calls.length === 0 && ask === null) return null;
  return { view: content.view, ask };
}

/** The content view and the ask of a trace's calls, in event time order. */
export function buildPayloadContent(calls: readonly PayloadCall[]): PayloadContent {
  const ordered = [...calls].sort(
    (left, right) =>
      left.occurredAt.getTime() - right.occurredAt.getTime() ||
      compare(left.eventId, right.eventId),
  );
  // Every call repeats the history: keep each message once, where it first
  // appeared, so the view sent to the page grows with the run, not with calls × history.
  const messages: TraceMessageView[] = [];
  const seenMessages = new Set<string>();
  const keep = (message: TraceMessageView) => {
    const key = `${message.role}\u0000${message.text}`;
    if (seenMessages.has(key)) return;
    seenMessages.add(key);
    messages.push(message);
  };
  const toolCalls: TraceToolCallView[] = [];
  const seenToolCalls = new Set<string>();
  const results = toolResults(ordered.flatMap((call) => callMessages(call.payload)));

  for (const call of ordered) {
    const id = call.spanId ?? call.eventId;
    const system = call.payload.system?.trim();
    if (system) keep({ id: `${id}:system`, role: "system", text: system });
    for (const [index, message] of callMessages(call.payload).entries()) {
      const text = messageText(message);
      if (text) keep({ id: `${id}:${index}`, role: message.role, text });
      if (message.role !== "assistant" || typeof message.content === "string") continue;
      for (const block of message.content) {
        if (block.type !== "tool_call") continue;
        const callId = block.id || `${id}:${index}:${block.name}`;
        if (seenToolCalls.has(callId)) continue;
        seenToolCalls.add(callId);
        toolCalls.push({
          id: callId,
          name: block.name,
          arguments: block.arguments ?? null,
          result: block.id ? (results.get(block.id) ?? null) : null,
          spanId: call.spanId ?? "",
          durationMs: call.latencyMs ?? 0,
          statusCode: 0,
        });
      }
    }
  }

  const ask =
    ordered.map((call) => lastUserText(callInput(call.payload))).find((text) => text !== null) ??
    null;
  return {
    view: { messages, toolCalls, contentCaptured: messages.length > 0 || toolCalls.length > 0 },
    ask,
  };
}

/**
 * Each run's ask for the runs list: the last user message going into its
 * first model call that has one, else the prompt ingest derived. Runs with
 * neither are left out.
 */
export async function listCapturedAsks(
  projectId: string,
  traceIds: readonly string[],
  db: PayloadDb = getDb(),
): Promise<Map<string, string>> {
  const ids = [...new Set(traceIds)];
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const rows = await db
      .selectDistinctOn([events.traceId], { traceId: events.traceId, payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.projectId, projectId),
          inArray(events.traceId, ids.slice(i, i + ID_CHUNK)),
          HAS_USER_TEXT,
        ),
      )
      .orderBy(events.traceId, EVENT_TIME, asc(events.id));
    for (const row of rows) {
      const ask = row.traceId && row.payload ? lastUserText(callInput(row.payload)) : null;
      if (ask) out.set(row.traceId as string, ask);
    }
  }
  const missing = ids.filter((id) => !out.has(id));
  for (const [traceId, ask] of await derivedAsks(projectId, missing, db)) out.set(traceId, ask);
  return out;
}

/**
 * Whether payload content (`cloud-payload-content`) is on for whoever asks
 * about this project.
 *
 * Owned (ADR-0030): upstream decides it in the project's organization through its flag service
 * (on at 100%) and retires it in #402, reading the payload for everyone. Here that end state
 * lands at once: always on. The name and arguments stay upstream's.
 */
export async function payloadContentEnabledForActor(
  _projectId: string,
  _actor: string,
): Promise<boolean> {
  return true;
}

/**
 * {@link loadPayloadContent} for a reader who is not the API route: null when
 * the flag is off for `actor`, and null, logged and reported, when the read
 * fails. The payload is an extra; the trace still reads from its spans.
 */
export async function loadPayloadContentForActor(
  projectId: string,
  traceId: string,
  actor: string,
  operation: string,
): Promise<PayloadContent | null> {
  try {
    if (!(await payloadContentEnabledForActor(projectId, actor))) return null;
    return await withStatementTimeout((db) => loadPayloadContent(projectId, traceId, db), {
      operation,
    });
  } catch (err) {
    logger.error(
      { err, project_id: projectId, trace_id: traceId, operation },
      "trace payload load failed",
    );
    reportServerException(err, `project:${projectId}`, { operation, project_id: projectId });
    return null;
  }
}

/** The first prompt ingest derived into `trace_events` for each run. */
async function derivedAsks(
  projectId: string,
  traceIds: readonly string[],
  db: PayloadDb,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < traceIds.length; i += ID_CHUNK) {
    const rows = await db
      .selectDistinctOn([traceEvents.traceId], {
        traceId: traceEvents.traceId,
        prompt: DERIVED_PROMPT,
      })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          inArray(traceEvents.traceId, traceIds.slice(i, i + ID_CHUNK)),
          eq(traceEvents.type, OTLP_MODEL_CALL),
          sql`${DERIVED_PROMPT} <> ''`,
        ),
      )
      .orderBy(
        traceEvents.traceId,
        sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`,
      );
    for (const row of rows) if (row.traceId && row.prompt) out.set(row.traceId, row.prompt);
  }
  return out;
}

/** The call's messages; a row stored before `input_message_count` keeps its reply in `output` alone. */
function callMessages(payload: CloudEvent): CloudMessage[] {
  const messages = payload.messages ?? [];
  return payload.input_message_count === undefined
    ? [...messages, ...(payload.output ?? [])]
    : messages;
}

function callInput(payload: CloudEvent): CloudMessage[] {
  const messages = payload.messages ?? [];
  return payload.input_message_count === undefined
    ? messages
    : messages.slice(0, payload.input_message_count);
}

function lastUserText(messages: readonly CloudMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = messageText(message);
    if (text) return text;
  }
  return null;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
