import { type SQL, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";

/**
 * The Overview group-by of one pivot (RC-886, flag `cloud-pivots`): per
 * value of the pivot in a window, the runs, the error rate, the p50 duration
 * and the cost, read from `otel_trace_summaries.dims`. The top values by runs
 * have a row each; the rest fold into one "Other" row, and runs with no value
 * into one "(none)" row.
 */

export type PivotGroupKind = "value" | "other" | "none";

export interface PivotGroupRow {
  kind: PivotGroupKind;
  /** The pivot value; null for "Other" and "(none)". */
  value: string | null;
  runs: number;
  /** Failed runs over runs, 0 to 1. */
  errorRate: number;
  p50Ms: number;
  costUsd: number;
}

export interface PivotGroupBy {
  /** The top values by runs, then "Other", then "(none)". Rows with no runs are left out. */
  rows: PivotGroupRow[];
  totalRuns: number;
}

export interface PivotGroupWindow {
  since: Date;
  until: Date;
}

/** Values with a row of their own; the rest are "Other". */
export const PIVOT_GROUP_LIMIT = 50;

const KIND_ORDER: Readonly<Record<PivotGroupKind, number>> = { value: 0, other: 1, none: 2 };

type GroupByDb = Pick<ReturnType<typeof getDb>, "execute">;

/** The group-by of `pivotKey` for the project's runs that start in the window. */
export async function getPivotGroupBy(
  projectId: string,
  pivotKey: string,
  window: PivotGroupWindow,
  db: GroupByDb,
  limit = PIVOT_GROUP_LIMIT,
): Promise<PivotGroupBy> {
  const result = await db.execute(pivotGroupByQuery(projectId, pivotKey, window, limit));
  const raw = ((result as unknown as { rows?: unknown[] }).rows ??
    (result as unknown as unknown[])) as Array<{
    kind: PivotGroupKind;
    value: string | null;
    runs: number | string;
    errors: number | string;
    p50_ms: number | string | null;
    cost_usd: number | string | null;
  }>;
  const rows = raw.map((row): PivotGroupRow => {
    const runs = Number(row.runs);
    return {
      kind: row.kind,
      value: row.kind === "value" ? row.value : null,
      runs,
      errorRate: runs > 0 ? Number(row.errors) / runs : 0,
      p50Ms: Number(row.p50_ms ?? 0),
      costUsd: Number(row.cost_usd ?? 0),
    };
  });
  rows.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.runs - a.runs || compareValues(a.value, b.value),
  );
  return { rows, totalRuns: rows.reduce((sum, row) => sum + row.runs, 0) };
}

/**
 * One scan of the window's summary rows (the `project_id, started_at` index),
 * kept as `w` and read twice: once to rank the values by runs, once to fold
 * every run into its value's bucket (1 to `limit`), "Other" (`limit + 1`) or
 * "(none)" (`limit + 2`), so the p50 of "Other" is over its own runs. The
 * aggregate sorts on the small integer bucket, not on the value text: on 1.2M
 * rows that is ~30% faster (RC-886, measured in the PR).
 */
export function pivotGroupByQuery(
  projectId: string,
  pivotKey: string,
  window: PivotGroupWindow,
  limit: number,
): SQL {
  return sql`
    with w as (
      select s.dims ->> ${pivotKey} as value, s.has_error, s.duration_ms, s.cost_usd
      from otel_trace_summaries s
      where s.project_id = ${projectId}
        and s.started_at >= ${window.since.toISOString()}::timestamptz
        and s.started_at < ${window.until.toISOString()}::timestamptz
    ),
    top as (
      select value, row_number() over (order by count(*) desc, value collate "C")::int as bucket
      from w where value is not null group by value order by bucket limit ${limit}
    ),
    grouped as (
      select case when w.value is null then ${limit + 2}::int else coalesce(top.bucket, ${limit + 1}::int) end as bucket,
        count(*)::int as runs,
        count(*) filter (where w.has_error)::int as errors,
        percentile_cont(0.5) within group (order by w.duration_ms) as p50_ms,
        coalesce(sum(w.cost_usd), 0)::float8 as cost_usd
      from w left join top on top.value = w.value
      group by 1
    )
    select case when g.bucket = ${limit + 2}::int then 'none' when g.bucket = ${limit + 1}::int then 'other' else 'value' end as kind,
      top.value, g.runs, g.errors, g.p50_ms, g.cost_usd
    from grouped g left join top on top.bucket = g.bucket`;
}

function compareValues(a: string | null, b: string | null): number {
  return (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;
}
