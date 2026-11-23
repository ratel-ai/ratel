import { and, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import { otelLogs, otelSpans } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import {
  getSpanAggregates,
  type TraceQueriesDb,
  type TraceVolumeOptions,
  type TraceWindow,
} from "@/lib/synthesis/traces/queries";
import type { VolumePoint } from "@/lib/synthesis/traces/v2/volume";
import type { SessionsDb } from "./cursor";

/**
 * The aggregates behind the summary inside each Traces tab (RC-331). Each
 * reads one project and one window, in the tab's own unit: sessions, spans
 * or log records.
 *
 * Sessions count as the Sessions list counts them (RC-752): a session with a
 * real session id (a turn keyed by its own trace id has none), open or
 * closed, by its last turn's end. A trace in a session's turn (by its `otlp:`
 * key or by its steps' events, as an MCP `otlp-run:` turn holds one trace per
 * tool call) is part of that session and never a run of its own. A session is
 * failed when a turn has an error step or a span of its traces ended in an
 * error. PRIVACY: ids, counts, times and costs only.
 */

export type TabAggregateOptions = TraceWindow & TraceVolumeOptions;

export interface SessionsAggregate {
  count: number;
  failed: number;
  p50DurationMs: number | null;
  costUsd: number;
  volume: VolumePoint[];
}

export interface SpansAggregate {
  count: number;
  errorCount: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  /** OTel span kinds (SpanKind numbers), most spans first. */
  kinds: { kind: number; count: number }[];
  volume: VolumePoint[];
}

export interface LogsAggregate {
  count: number;
  /** Records per OTel SeverityNumber. */
  severities: { severityNumber: number; count: number }[];
  /** Volume; `errorCount` is error and fatal records. */
  volume: VolumePoint[];
}

const OTLP_KEY = "otlp:";
/** OTel SeverityNumber of ERROR; ERROR and FATAL run to 24. */
const ERROR_SEVERITY = 17;
const MAX_SEVERITY = 24;

/**
 * Sessions whose last activity falls in the window, by the Sessions list's
 * rule (`sessions-list.ts`): open or closed, with a real session id.
 */
export async function getSessionsAggregate(
  projectId: string,
  options: TabAggregateOptions,
  db: SessionsDb = getDb(),
): Promise<SessionsAggregate> {
  const { since, until } = options;
  const hour =
    options.volumeBucket === "hour"
      ? sql`extract(hour from at at time zone 'UTC')::int`
      : sql`null::int`;
  const inWindow = (column: SQL) =>
    sql`${column} >= ${since.toISOString()}::timestamptz and ${column} < ${until.toISOString()}::timestamptz`;
  const result = await db.execute(sql`
    with active as (
      select t.session_id from trace_turns t
      where t.project_id = ${projectId} and t.status = 'closed' and ${inWindow(sql`t.ended_at`)} and t.turn_key <> ${OTLP_KEY} || t.session_id
      union
      select t.session_id from trace_turns t
      where t.project_id = ${projectId} and t.status = 'open' and ${inWindow(sql`t.ended_at`)} and t.turn_key <> ${OTLP_KEY} || t.session_id
    ),
    turns as (
      select t.id, t.session_id, t.turn_key, t.started_at, t.ended_at, t.error_count
      from trace_turns t join active a on a.session_id = t.session_id
      where t.project_id = ${projectId}
    ),
    session_traces as (
      select u.session_id, substr(u.turn_key, ${OTLP_KEY.length + 1}) as trace_id from turns u where u.turn_key like ${`${OTLP_KEY}%`}
      union
      select u.session_id, e.trace_id from turns u
      join trace_turn_steps st on st.project_id = ${projectId} and st.turn_id = u.id
      join trace_events e on e.project_id = st.project_id and e.id = st.trace_event_id
      where e.trace_id is not null
    ),
    session_spans as (
      select p.session_id, sum(s.cost_usd)::float8 as cost, bool_or(s.status_code = 2) as failed
      from session_traces p join otel_spans s on s.project_id = ${projectId} and s.trace_id = p.trace_id
      group by p.session_id
    ),
    sessions as (
      select u.session_id, max(u.ended_at) as at,
        extract(epoch from max(u.ended_at) - min(u.started_at))::float8 * 1000 as duration_ms,
        bool_or(u.error_count > 0) as failed
      from turns u group by u.session_id
    ),
    items as (
      select s.at, s.duration_ms, (s.failed or coalesce(p.failed, false)) as failed, coalesce(p.cost, 0)::float8 as cost
      from sessions s left join session_spans p on p.session_id = s.session_id
      where ${inWindow(sql`s.at`)}
    )
    select
      (select count(*)::int from items) as count,
      (select (count(*) filter (where failed))::int from items) as failed,
      (select percentile_cont(0.5) within group (order by greatest(duration_ms, 0))::float8 from items) as p50,
      (select coalesce(sum(cost), 0)::float8 from items) as cost,
      (select coalesce(json_agg(v order by v.day, v.hour), '[]'::json) from (
        select to_char(date_trunc('day', at at time zone 'UTC'), 'YYYY-MM-DD') as day, ${hour} as hour,
          count(*)::int as count, (count(*) filter (where failed))::int as error_count
        from items group by 1, 2
      ) v) as volume`);
  const row = rowsOf<{
    count: number;
    failed: number;
    p50: number | null;
    cost: number;
    volume: unknown;
  }>(result)[0];
  return {
    count: Number(row?.count ?? 0),
    failed: Number(row?.failed ?? 0),
    p50DurationMs: row?.p50 == null ? null : Number(row.p50),
    costUsd: Number(row?.cost ?? 0),
    volume: volumePoints(row?.volume),
  };
}

/** Spans that started in the window: totals, kinds and volume. */
export async function getSpansAggregate(
  projectId: string,
  options: TabAggregateOptions,
  db: TraceQueriesDb = getDb(),
): Promise<SpansAggregate> {
  const count = sql<number>`count(*)::int`;
  const [totals, kinds] = await Promise.all([
    getSpanAggregates(
      projectId,
      { since: options.since, until: options.until, volumeBucket: options.volumeBucket },
      db,
    ),
    db
      .select({ kind: otelSpans.kind, count })
      .from(otelSpans)
      .where(
        and(
          eq(otelSpans.projectId, projectId),
          gte(otelSpans.startedAt, options.since),
          lt(otelSpans.startedAt, options.until),
        ),
      )
      .groupBy(otelSpans.kind)
      .orderBy(sql`count(*) desc`, otelSpans.kind),
  ]);
  return {
    count: totals.count,
    errorCount: totals.errorCount,
    p50DurationMs: totals.p50DurationMs,
    p95DurationMs: totals.p95DurationMs,
    kinds,
    volume: totals.volume,
  };
}

/** Log records that occurred in the window: severities and volume. */
export async function getLogsAggregate(
  projectId: string,
  options: TabAggregateOptions,
  db: TraceQueriesDb = getDb(),
): Promise<LogsAggregate> {
  const inWindow = and(
    gte(otelLogs.occurredAt, options.since),
    lt(otelLogs.occurredAt, options.until),
  );
  const count = sql<number>`count(*)::int`;
  const errorCount = sql<number>`(count(*) filter (where ${otelLogs.severityNumber} between ${ERROR_SEVERITY} and ${MAX_SEVERITY}))::int`;
  const day = sql<string>`to_char(date_trunc('day', ${otelLogs.occurredAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const hour = sql<number>`extract(hour from ${otelLogs.occurredAt} at time zone 'UTC')::int`;
  const [severities, volume] = await Promise.all([
    db
      .select({ severityNumber: otelLogs.severityNumber, count })
      .from(otelLogs)
      .where(and(eq(otelLogs.projectId, projectId), inWindow))
      .groupBy(otelLogs.severityNumber)
      .orderBy(otelLogs.severityNumber),
    options.volumeBucket === "hour"
      ? db
          .select({ day, hour, count, errorCount })
          .from(otelLogs)
          .where(and(eq(otelLogs.projectId, projectId), inWindow))
          .groupBy(day, hour)
          .orderBy(day, hour)
      : db
          .select({ day, count, errorCount })
          .from(otelLogs)
          .where(and(eq(otelLogs.projectId, projectId), inWindow))
          .groupBy(day)
          .orderBy(day),
  ]);
  return { count: severities.reduce((total, row) => total + row.count, 0), severities, volume };
}

function volumePoints(value: unknown): VolumePoint[] {
  const rows = (typeof value === "string" ? JSON.parse(value) : (value ?? [])) as {
    day: string;
    hour: number | null;
    count: number;
    error_count: number;
  }[];
  return rows.map((row) => ({
    day: row.day,
    ...(row.hour === null ? {} : { hour: Number(row.hour) }),
    count: Number(row.count),
    errorCount: Number(row.error_count),
  }));
}

function rowsOf<Row>(result: unknown): Row[] {
  return ((result as { rows?: Row[] }).rows ?? (result as Row[])) as Row[];
}
