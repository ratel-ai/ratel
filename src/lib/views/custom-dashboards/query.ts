import { type SQL, sql } from "drizzle-orm";
import type { Pivot } from "@/lib/ingest/pivots/model";
import { listPivots, type PivotsDb } from "@/lib/ingest/pivots/store";
import { getDb } from "@/lib/platform/db/client";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import { traceFilterCondition } from "@/lib/synthesis/traces/trace-filters";
import {
  METRIC_PIVOT_PRESET,
  parseWidgetSpec,
  pivotKeyOf,
  RETENTION_DAYS,
  topNOf,
  type WidgetGroupBy,
  type WidgetMetric,
  type WidgetSpec,
  type WidgetSpecError,
} from "./spec";

/** The most day groups a widget reads: the dates the longest range touches. */
export const DAY_GROUP_LIMIT = RETENTION_DAYS + 1;

/**
 * The one query path of custom dashboards (RC-887): a widget spec in, rows
 * out, over `otel_trace_summaries` only. The SQL is built from fixed fragments
 * chosen by the whitelisted spec fields. Every other value (the project, the
 * window, filter values, pivot keys, the top N) is a bound parameter.
 */

export interface WidgetGroup {
  /** The group's value. null: traces with no value for it ("not set"). */
  key: string | null;
  value: number | null;
  runs: number;
}

export type WidgetResult =
  | { kind: "total"; value: number | null; runs: number }
  | {
      kind: "groups";
      groupBy: WidgetGroupBy;
      groups: WidgetGroup[];
      /** Every group past the top N, merged; null when nothing was cut. */
      other: { value: number | null; runs: number } | null;
    }
  /** The metric or the group-by needs a pivot the project has not configured. Not an error. */
  | { kind: "pivot_missing"; pivot: string }
  | { kind: "invalid"; error: WidgetSpecError };

/** The pool, or a connection bound to a statement timeout (lib/db/statement-timeout.ts). */
export type WidgetQueryDb = Pick<BoundReadDb, "execute" | "select">;

export interface WidgetQueryOptions {
  db?: WidgetQueryDb;
  now?: Date;
  /** The project's pivots, when the caller has them already. */
  pivots?: readonly Pick<Pivot, "key" | "presetId">[];
}

/** A built query: the SQL, or why the project cannot answer it. */
export type BuiltWidgetQuery = { ok: true; query: SQL } | { ok: false; pivot: string };

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The group of traces with no value. Ingest keeps no empty pivot value, and an
 * empty service or environment reads as not set too.
 */
const NOT_SET = "";

/**
 * Run a widget spec for a project. The spec is checked again here (a stored
 * spec is untrusted input). A pivot the project no longer has reads
 * `pivot_missing`.
 */
export async function runWidgetQuery(
  projectId: string,
  input: unknown,
  options: WidgetQueryOptions = {},
): Promise<WidgetResult> {
  const parsed = parseWidgetSpec(input);
  if (!parsed.ok) return { kind: "invalid", error: parsed.error };
  const spec = parsed.spec;
  const db = options.db ?? getDb();
  // listPivots only selects; it takes the pool type, which a bound connection matches for that.
  const pivots = options.pivots ?? (await listPivots(projectId, db as PivotsDb));
  const built = buildWidgetQuery(projectId, spec, pivots, options.now ?? new Date());
  if (!built.ok) return { kind: "pivot_missing", pivot: built.pivot };

  const result = await db.execute(built.query);
  const rows = ((result as unknown as { rows?: unknown[] }).rows ??
    (result as unknown as unknown[])) as Array<{
    other: boolean;
    key: string | null;
    value: number | string | null;
    runs: number | string;
  }>;

  if (spec.groupBy === null) {
    const row = rows[0];
    return { kind: "total", value: toNumber(row?.value ?? null), runs: Number(row?.runs ?? 0) };
  }
  const groups: WidgetGroup[] = [];
  let other: { value: number | null; runs: number } | null = null;
  for (const row of rows) {
    const runs = Number(row.runs);
    const value = toNumber(row.value);
    if (row.other) other = { value, runs };
    else groups.push({ key: row.key === NOT_SET ? null : row.key, value, runs });
  }
  return { kind: "groups", groupBy: spec.groupBy, groups, other };
}

/**
 * The SQL of a valid spec. Exported for the tests that check no spec value
 * reaches the query text.
 */
export function buildWidgetQuery(
  projectId: string,
  spec: WidgetSpec,
  pivots: readonly Pick<Pivot, "key" | "presetId">[],
  now: Date,
): BuiltWidgetQuery {
  const metric = metricExpression(spec.metric, pivots);
  if (!metric.ok) return metric;
  const pivotKey = pivotKeyOf(spec.groupBy);
  if (pivotKey !== null && !pivots.some((pivot) => pivot.key === pivotKey))
    return { ok: false, pivot: pivotKey };

  const since = new Date(now.getTime() - spec.rangeDays * DAY_MS).toISOString();
  const condition = traceFilterCondition(spec.filter);
  const where = sql`s.project_id = ${projectId}
      and s.started_at >= ${since}::timestamptz
      and s.started_at < ${now.toISOString()}::timestamptz
      ${condition ? sql`and ${condition}` : sql``}`;

  // `base` reads each summary row once, down to its group value `g` and the metric's input `x`.
  const group = spec.groupBy === null ? null : groupSource(spec.groupBy);
  const base = sql`select ${group ? group.key : sql`null::text`} as g, ${metric.input} as x
      from otel_trace_summaries s${group ? group.from : sql``}
      where ${where}`;

  if (spec.groupBy === null) {
    return {
      ok: true,
      query: sql`select false as other, null::text as key, ${metric.aggregate} as value, count(*)::int as runs
    from (${base}) b`,
    };
  }

  if (spec.groupBy === "day") {
    // A time series: one group per day of the range, in day order, no Other, no top N. The cap is the range:
    // a rolling window of N days touches N + 1 UTC dates, so the longest range takes RETENTION_DAYS + 1 rows.
    return {
      ok: true,
      query: sql`select false as other, b.g as key, ${metric.aggregate} as value, count(*)::int as runs
    from (${base}) b
    group by b.g
    order by b.g
    limit ${DAY_GROUP_LIMIT}`,
    };
  }

  return {
    ok: true,
    query: sql`with base as materialized (${base}),
    top as (
      select b.g from base b group by b.g order by count(*) desc, b.g collate "C" limit ${topNOf(spec)}
    )
    select t.g is null as other, t.g as key, ${metric.aggregate} as value, count(*)::int as runs
    from base b left join top t on t.g = b.g
    group by t.g
    order by (t.g is null), count(*) desc, t.g collate "C"`,
  };
}

/**
 * A metric in two fragments: `input`, read off each summary row aliased `s`,
 * and `aggregate`, over the rows aliased `b` whose input is `b.x`.
 */
interface MetricFragments {
  input: SQL;
  aggregate: SQL;
}

function metricExpression(
  metric: WidgetMetric,
  pivots: readonly Pick<Pivot, "key" | "presetId">[],
): ({ ok: true } & MetricFragments) | { ok: false; pivot: string } {
  switch (metric) {
    case "runs":
      return { ok: true, input: sql`null::int`, aggregate: sql`count(*)::float8` };
    case "error_rate":
      return {
        ok: true,
        input: sql`s.has_error`,
        aggregate: sql`avg(case when b.x then 1 else 0 end)::float8`,
      };
    case "p50":
      return {
        ok: true,
        input: sql`s.duration_ms`,
        aggregate: sql`percentile_cont(0.5) within group (order by b.x)::float8`,
      };
    case "p95":
      return {
        ok: true,
        input: sql`s.duration_ms`,
        aggregate: sql`percentile_cont(0.95) within group (order by b.x)::float8`,
      };
    case "tokens":
      return {
        ok: true,
        input: sql`s.input_tokens + s.output_tokens`,
        aggregate: sql`coalesce(sum(b.x), 0)::float8`,
      };
    case "cost":
      return { ok: true, input: sql`s.cost_usd`, aggregate: sql`coalesce(sum(b.x), 0)::float8` };
    case "sessions":
    case "distinct_users": {
      const preset = METRIC_PIVOT_PRESET[metric];
      const pivot = pivots.find((candidate) => candidate.presetId === preset);
      if (!pivot) return { ok: false, pivot: preset };
      return {
        ok: true,
        input: sql`s.dims ->> ${pivot.key}`,
        aggregate: sql`count(distinct b.x)::float8`,
      };
    }
  }
}

/** The group value of a summary row, and the join that yields it (an unnest for the array columns). */
function groupSource(groupBy: WidgetGroupBy): { key: SQL; from: SQL } {
  switch (groupBy) {
    case "day":
      return { key: sql`to_char(s.started_at at time zone 'UTC', 'YYYY-MM-DD')`, from: sql`` };
    case "model":
      return { key: sql`g.value`, from: sql` cross join lateral unnest(s.models) as g(value)` };
    case "tool":
      return { key: sql`g.value`, from: sql` cross join lateral unnest(s.tools) as g(value)` };
    case "service":
      return { key: sql`coalesce(s.service_name, ${NOT_SET})`, from: sql`` };
    case "environment":
      return { key: sql`coalesce(s.environment, ${NOT_SET})`, from: sql`` };
    default: {
      const key = pivotKeyOf(groupBy);
      return { key: sql`coalesce(s.dims ->> ${key}, ${NOT_SET})`, from: sql`` };
    }
  }
}

function toNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}
