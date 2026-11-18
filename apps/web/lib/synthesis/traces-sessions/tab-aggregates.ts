import { and, eq, gte, lt, sql } from "drizzle-orm";
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
 * Sessions count as the Sessions list counts them: a session by its last
 * closed turn's end, and a run in no closed turn by its first top-level span's
 * start. A session is failed when a turn has an error step or a span of its
 * runs ended in an error. PRIVACY: ids, counts, times and costs only.
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

/** Sessions and runs with no session whose activity falls in the window. */
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
  const result = await db.execute(sql`
    with active as (
      select distinct t.session_id from trace_turns t
      where t.project_id = ${projectId} and t.status = 'closed' and t.ended_at >= ${since.toISOString()}::timestamptz and t.ended_at < ${until.toISOString()}::timestamptz
    ),
    turns as (
      select t.session_id, t.started_at, t.ended_at, t.error_count,
        case when t.turn_key like ${`${OTLP_KEY}%`} then substr(t.turn_key, ${OTLP_KEY.length + 1}) end as trace_id
      from trace_turns t join active a on a.session_id = t.session_id
      where t.project_id = ${projectId} and t.status = 'closed'
    ),
    session_spans as (
      select u.session_id, sum(s.cost_usd)::float8 as cost, bool_or(s.status_code = 2) as failed
      from turns u join otel_spans s on s.project_id = ${projectId} and s.trace_id = u.trace_id
      group by u.session_id
    ),
    sessions as (
      select max(u.ended_at) as at,
        extract(epoch from max(u.ended_at) - min(u.started_at))::float8 * 1000 as duration_ms,
        (bool_or(u.error_count > 0) or coalesce(bool_or(p.failed), false)) as failed,
        coalesce(max(p.cost), 0)::float8 as cost
      from turns u left join session_spans p on p.session_id = u.session_id
      group by u.session_id
    ),
    roots as (
      select r.trace_id, r.started_at, r.ended_at from otel_spans r
      where r.project_id = ${projectId} and r.parent_span_id is null
        and r.started_at >= ${since.toISOString()}::timestamptz and r.started_at < ${until.toISOString()}::timestamptz
        and not exists (
          select 1 from otel_spans e
          where e.project_id = r.project_id and e.trace_id = r.trace_id and e.parent_span_id is null and (e.started_at, e.span_id) < (r.started_at, r.span_id)
        )
        and not exists (
          select 1 from trace_turns k where k.project_id = r.project_id and k.turn_key = ${OTLP_KEY} || r.trace_id and k.status = 'closed'
        )
    ),
    runs as (
      select o.started_at as at,
        extract(epoch from o.ended_at - o.started_at)::float8 * 1000 as duration_ms,
        exists (select 1 from otel_spans s where s.project_id = ${projectId} and s.trace_id = o.trace_id and s.status_code = 2) as failed,
        (select coalesce(sum(s.cost_usd), 0)::float8 from otel_spans s where s.project_id = ${projectId} and s.trace_id = o.trace_id) as cost
      from roots o
    ),
    items as (
      select at, duration_ms, failed, cost from sessions
      union all
      select at, duration_ms, failed, cost from runs
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
