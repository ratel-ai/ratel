import { sql } from "drizzle-orm";
import { toOtelLogRows } from "@/lib/ingest/otlp/log-rows";
import { decodeLogExport, MAX_LOG_RECORDS } from "@/lib/ingest/otlp/logs-export";
import { decodeTraceExport, MAX_SPANS } from "@/lib/ingest/otlp/traces-export";
import type { Envelope } from "@/lib/ingest/queue/envelope";
import type { EnvelopeHandler } from "@/lib/ingest/queue/port/envelope-queue";
import { readOtlpExport } from "@/lib/ingest/queue/process";
import { deterministicEventId, parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import { MAX_BATCH_EVENTS, parseRuntimeEventsBody } from "@/lib/ingest/trace-events/route-handler";
import type { getDb } from "@/lib/platform/db/client";

/**
 * Envelopes that were accepted before, through processing again (a private tool publishes them to a
 * topic of their own). FILL stores what is missing and leaves what is there. REBUILD first removes what
 * the envelopes of the range made.
 *
 * Outside `lib`, because it wires modules of every layer, as `ingest-consumer.ts` does.
 */
export type ReplayDb = Pick<ReturnType<typeof getDb>, "execute">;

/** What a range of envelopes stored, by the ids its rows have whichever parser made them. */
export interface ReplayRange {
  /** Per project. */
  traceIds: Map<string, Set<string>>;
  /** `<trace>/<span>` of every envelope that is replayed, those around the range too. */
  spans: Map<string, Set<string>>;
  logIds: Map<string, Set<string>>;
  eventIds: Map<string, Set<string>>;
  envelopeIds: Map<string, Set<string>>;
}

export function emptyRange(): ReplayRange {
  return {
    traceIds: new Map(),
    spans: new Map(),
    logIds: new Map(),
    eventIds: new Map(),
    envelopeIds: new Map(),
  };
}

function add(map: Map<string, Set<string>>, projectId: string, ids: Iterable<string>): void {
  const set = map.get(projectId) ?? new Set();
  for (const id of ids) set.add(id);
  map.set(projectId, set);
}

const spanKey = (traceId: string, spanId: string) => `${traceId}/${spanId}`;

/**
 * An envelope that does not decode stored nothing, and is left to the consumer. Of one around the range
 * (`isMargin`) only its spans count: they can be stored again.
 */
export function addToRange(range: ReplayRange, envelope: Envelope, isMargin = false): void {
  const { projectId } = envelope;
  if (envelope.signal === "traces") {
    const spans = spansOf(envelope);
    add(
      range.spans,
      projectId,
      spans.map((span) => spanKey(span.traceId, span.spanId)),
    );
    if (!isMargin) add(range.traceIds, projectId, traceIdsIn(spans));
  }
  if (isMargin) return;
  add(range.envelopeIds, projectId, [envelope.id]);
  switch (envelope.signal) {
    case "traces":
      return;
    case "logs": {
      const read = readOtlpExport(envelope, {
        decode: decodeLogExport,
        limit: `${MAX_LOG_RECORDS} log records`,
      });
      if (!read.ok) return;
      const { records } = read.decoded;
      const { rows } = toOtelLogRows(projectId, records, new Date(envelope.receivedAt));
      add(
        range.logIds,
        projectId,
        rows.flatMap((row) => (row.id ? [row.id] : [])),
      );
      return;
    }
    case "events": {
      const events = parseRuntimeEventsBody(envelope.body);
      if (!events || events.length > MAX_BATCH_EVENTS) return;
      add(
        range.eventIds,
        projectId,
        parseTraceEvents(events).valid.map((event) =>
          deterministicEventId(projectId, event.clientEventId),
        ),
      );
      return;
    }
  }
}

function spansOf(envelope: Envelope): { traceId: string; spanId: string }[] {
  if (envelope.signal !== "traces") return [];
  const read = readOtlpExport(envelope, { decode: decodeTraceExport, limit: `${MAX_SPANS} spans` });
  return read.ok ? read.decoded.spans : [];
}

const traceIdsIn = (spans: { traceId: string }[]) => [
  ...new Set(spans.map((span) => span.traceId).filter(Boolean)),
];

export function traceIdsOf(envelope: Envelope): string[] {
  return traceIdsIn(spansOf(envelope));
}

const CHUNK = 500;

/**
 * Takes the traces out of a REBUILD that have a stored span no replayed envelope holds: stored before
 * their organization was on a topic, or while this runs. Removing them would lose that span. They are
 * filled instead. Returns how many.
 */
export async function keepPartialTraces(db: ReplayDb, range: ReplayRange): Promise<number> {
  let kept = 0;
  for (const [projectId, ids] of range.traceIds) {
    const held = range.spans.get(projectId) ?? new Set();
    for (const traceIds of chunks(new Set(ids))) {
      const { rows } = (await db.execute(sql`
        select trace_id, span_id from otel_spans
        where project_id = ${projectId} and trace_id = any(${textArray(traceIds)})`)) as unknown as {
        rows: { trace_id: string; span_id: string }[];
      };
      for (const row of rows) {
        if (held.has(spanKey(row.trace_id, row.span_id))) continue;
        if (ids.delete(row.trace_id)) kept += 1;
      }
    }
  }
  return kept;
}

/**
 * Run it with `keepPartialTraces` in one repeatable read: a span that comes meanwhile is not seen, and
 * stays. Removes the range's rows and what was derived from them: spans and their calls, the events lifted from
 * spans, the trace's summary and turns, log records, runtime events and the raw captures. What a removed
 * runtime event had counted in `tool_usage_counters` is taken back, because storing it again counts it
 * again. Readings that jobs make over the whole window (intents, health) follow when those jobs run.
 */
export async function removeRange(db: ReplayDb, range: ReplayRange): Promise<void> {
  for (const [projectId, ids] of range.traceIds) {
    for (const traceIds of chunks(ids)) {
      const list = textArray(traceIds);
      await db.execute(sql`
        delete from trace_turns where project_id = ${projectId} and id in (
          select s.turn_id from trace_turn_steps s join trace_events e on e.id = s.trace_event_id
          where e.project_id = ${projectId} and e.trace_id = any(${list}) and e.ingest_source = 'otlp')`);
      await db.execute(sql`
        delete from trace_events
        where project_id = ${projectId} and trace_id = any(${list}) and ingest_source = 'otlp'`);
      for (const table of ["events", "otel_spans", "otel_trace_summaries"]) {
        await db.execute(sql`
          delete from ${sql.identifier(table)}
          where project_id = ${projectId} and trace_id = any(${list})`);
      }
    }
  }
  for (const [projectId, ids] of range.logIds) {
    for (const logIds of chunks(ids)) {
      await db.execute(sql`
        delete from otel_logs where project_id = ${projectId} and id = any(${uuidArray(logIds)})`);
    }
  }
  for (const [projectId, ids] of range.eventIds) {
    for (const eventIds of chunks(ids)) {
      await removeRuntimeEvents(db, projectId, eventIds);
    }
  }
  for (const [projectId, ids] of range.envelopeIds) {
    for (const envelopeIds of chunks(ids)) {
      await db.execute(sql`
        delete from otlp_raw_exports
        where project_id = ${projectId} and id = any(${uuidArray(envelopeIds)})`);
    }
  }
}

async function removeRuntimeEvents(
  db: ReplayDb,
  projectId: string,
  eventIds: string[],
): Promise<void> {
  const list = uuidArray(eventIds);
  await db.execute(sql`
    delete from trace_turns where project_id = ${projectId} and id in (
      select s.turn_id from trace_turn_steps s where s.trace_event_id = any(${list}))`);
  // The types consolidation counts: a tool call's end, well or badly.
  await db.execute(sql`
    with gone as (
      delete from trace_events
      where project_id = ${projectId} and id = any(${list}) and ingest_source = 'runtime'
      returning source_id, tool_id, type, took_ms
    ), counted as (
      select source_id, tool_id, count(*) as calls,
        count(*) filter (where type = 'invoke_error') as errors,
        coalesce(sum(took_ms), 0) as took
      from gone
      where source_id is not null and tool_id is not null
        and type in ('invoke_end', 'invoke_error')
      group by 1, 2
    )
    update tool_usage_counters c set calls = greatest(0, c.calls - n.calls),
      errors = greatest(0, c.errors - n.errors),
      total_duration_ms = greatest(0, c.total_duration_ms - n.took)
    from counted n
    where c.project_id = ${projectId} and c.source_id = n.source_id and c.tool_id = n.tool_id`);
}

function* chunks(ids: Set<string>): Generator<string[]> {
  const all = [...ids];
  for (let i = 0; i < all.length; i += CHUNK) yield all.slice(i, i + CHUNK);
}

const textArray = (ids: string[]) =>
  sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;

const uuidArray = (ids: string[]) =>
  sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;

/**
 * Around a REBUILD: an envelope from outside the range is stored again only when it belongs to a removed
 * trace, so that a trace that began before the range is whole again.
 */
export function rebuildHandler(
  handler: EnvelopeHandler,
  range: ReplayRange,
  isMargin: (envelope: Envelope) => boolean,
): EnvelopeHandler {
  return async (envelope, delivery) => {
    if (isMargin(envelope)) {
      const removed = range.traceIds.get(envelope.projectId);
      if (!removed || !traceIdsOf(envelope).some((id) => removed.has(id))) {
        return { outcome: "ack" };
      }
    }
    return handler(envelope, delivery);
  };
}
