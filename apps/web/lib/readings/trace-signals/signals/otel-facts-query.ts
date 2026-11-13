import { and, asc, eq, gte, isNotNull, lt, or, sql } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import { envNumber } from "@/lib/platform/env-number";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  createOtelFactsBuilder,
  OTEL_FACT_TYPES,
  OTLP_MODEL_CALL_TYPE,
  type OtelFactRow,
  type OtelFacts,
  type StartedBy,
} from "@/lib/readings/trace-signals/signals/otel-facts";

/**
 * The read behind {@link OtelFacts}: a project's OTLP-derived tool-call and
 * model-call rows around a run window, paged by event time.
 *
 * Index: `trace_events_project_type_time_idx` is `(project_id, type,
 * coalesce(occurred_at, received_at))`, so the read filters on exactly those
 * three (one pass per type) and adds `ingest_source = 'otlp'` as a filter. No
 * migration is needed. Only tool-call rows carrying a fact (an error, a
 * captured result or argument hash) come back; a plain successful call adds
 * nothing the ledger step does not already hold.
 *
 * Bounded: rows are paged, the payload is never read whole (only the fields
 * below), and the read stops at {@link MAX_OTEL_FACT_ROWS}, logging a warning,
 * so one runaway project cannot hold the job.
 */

const logger = getLogger("trace-signals/otel-facts");

export type OtelFactsDb = Pick<ReturnType<typeof getDb>, "select">;

/** Events of a turn ending inside the window may start a little before it. */
export const OTEL_FACTS_SLACK_MS = 60 * 60_000;
const PAGE_SIZE = 5_000;
export const MAX_OTEL_FACT_ROWS = Math.floor(envNumber("TRACE_SIGNALS_MAX_OTEL_ROWS", 1_000_000));

const eventTime = sql<Date>`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;

interface Cursor {
  atRaw: string;
  id: string;
}

type RawRow = OtelFactRow & { atRaw: string };

async function readPage(
  projectId: string,
  type: (typeof OTEL_FACT_TYPES)[number],
  range: { from: Date; to: Date; after: Cursor | null },
  db: OtelFactsDb,
): Promise<RawRow[]> {
  const keyset = range.after
    ? sql`(${eventTime}, ${traceEvents.id}) > (${range.after.atRaw}::timestamptz, ${range.after.id}::uuid)`
    : undefined;
  const carriesFact =
    type === OTLP_MODEL_CALL_TYPE
      ? undefined
      : or(
          isNotNull(traceEvents.errorMessage),
          sql`jsonb_typeof(${traceEvents.payload} -> 'result_empty') = 'boolean'`,
          sql`jsonb_typeof(${traceEvents.payload} -> 'arg_hash') = 'string'`,
          sql`jsonb_typeof(${traceEvents.payload} -> 'agent') = 'string'`,
        );
  return db
    .select({
      id: traceEvents.id,
      type: traceEvents.type,
      traceId: traceEvents.traceId,
      errorType: traceEvents.errorMessage,
      resultEmpty: sql<
        boolean | null
      >`case jsonb_typeof(${traceEvents.payload} -> 'result_empty') when 'boolean' then (${traceEvents.payload} ->> 'result_empty')::boolean end`,
      argHash: sql<string | null>`${traceEvents.payload} ->> 'arg_hash'`,
      inputTokens: traceEvents.inputTokens,
      outputTokens: traceEvents.outputTokens,
      menu: sql<
        string[] | null
      >`case jsonb_typeof(${traceEvents.payload} -> 'menu') when 'array' then ${traceEvents.payload} -> 'menu' end`,
      agent: sql<string | null>`${traceEvents.payload} ->> 'agent'`,
      startedBy: sql<StartedBy | null>`case when ${traceEvents.payload} ->> 'started_by' = 'system' then 'system' when jsonb_typeof(${traceEvents.payload} -> 'prompt') = 'string' then 'person' end`,
      atRaw: sql<string>`${eventTime}::text`,
    })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.type, type),
        gte(eventTime, range.from),
        lt(eventTime, range.to),
        eq(traceEvents.ingestSource, "otlp"),
        carriesFact,
        keyset,
      ),
    )
    .orderBy(asc(eventTime), asc(traceEvents.id))
    .limit(PAGE_SIZE);
}

function toFactRow(row: RawRow): OtelFactRow {
  return {
    id: row.id,
    type: row.type,
    traceId: row.traceId,
    errorType: row.errorType,
    resultEmpty: row.resultEmpty,
    argHash: row.argHash,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    menu: row.menu,
    agent: row.agent ?? null,
    startedBy: row.startedBy ?? null,
  };
}

/** Pages one type's rows into `add`; returns how many it read. */
async function readType(
  projectId: string,
  type: (typeof OTEL_FACT_TYPES)[number],
  range: { from: Date; to: Date },
  budget: number,
  add: (row: OtelFactRow) => void,
  db: OtelFactsDb,
): Promise<number> {
  let read = 0;
  let after: Cursor | null = null;
  while (read < budget) {
    const rows = await readPage(projectId, type, { ...range, after }, db);
    for (const row of rows.slice(0, budget - read)) add(toFactRow(row));
    read += Math.min(rows.length, budget - read);
    const last = rows.at(-1);
    if (!last || rows.length < PAGE_SIZE) break;
    after = { atRaw: last.atRaw, id: last.id };
  }
  return read;
}

/**
 * The OTel facts of a run window. Null when the read fails: the failure is
 * logged and reported, and the OTel signals are then simply not measured.
 */
export async function loadOtelFacts(
  projectId: string,
  window: { start: Date; end: Date },
  db: OtelFactsDb = getDb(),
  maxRows: number = MAX_OTEL_FACT_ROWS,
): Promise<OtelFacts | null> {
  const range = {
    from: new Date(window.start.getTime() - OTEL_FACTS_SLACK_MS),
    to: new Date(window.end.getTime() + OTEL_FACTS_SLACK_MS),
  };
  try {
    const builder = createOtelFactsBuilder();
    let read = 0;
    for (const type of OTEL_FACT_TYPES) {
      read += await readType(projectId, type, range, maxRows - read, (row) => builder.add(row), db);
    }
    if (read >= maxRows) {
      logger.warn(
        { project_id: projectId, max_rows: maxRows },
        "otel facts truncated for trace signals",
      );
    }
    return builder.finish();
  } catch (err) {
    logger.error({ err, project_id: projectId }, "otel facts unreadable for trace signals");
    reportServerException(err, "system:trace-signals", {
      project_id: projectId,
      operation: "trace_signals_load_otel_facts",
    });
    return null;
  }
}
