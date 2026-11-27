import { sql } from "drizzle-orm";
import {
  GROUP_LIMITS,
  type GroupBy,
  isGrouped,
  propertyOf,
  type Query,
} from "@/lib/contracts/query";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { groupQuery } from "@/lib/synthesis/metrics/group-query";
import {
  type MetricsDb,
  type QueryResult,
  rowsOf,
  runnableQuery,
} from "@/lib/synthesis/metrics/query";
import { createRqlGate, type RqlGate } from "@/lib/synthesis/rql/domain/gate";
import { withClause } from "@/lib/synthesis/traces/trace-filter-clauses";
import {
  type TraceFilter,
  traceFilterCondition,
  traceTasks,
} from "@/lib/synthesis/traces/trace-filters";

/**
 * A group-by of the Flow, Step flow, Funnel and Map kinds (RTL-398): one small result per value of
 * a trace property, a task, a user or a session, for the values of the most traces. Each one is the
 * same query with one more filter, the value's: no other query engine. The traces without a value
 * are one group (`value` null). It costs one query of the values, then one query per value: the
 * values are capped (`GROUP_LIMITS.max`), and the small queries of one project wait for a place in
 * a gate of this process (`GROUP_QUERIES_PER_PROJECT`), whatever widget, page or tool asks.
 */

/**
 * The small queries of one project that run at the same time, in this process. They read the
 * primary pool under the read timeout, not the RQL pool: this gate is apart from RQL's gates.
 */
export const GROUP_QUERIES_PER_PROJECT = 2;
/** How long a small query waits for a place before its value shows no numbers. */
const GROUP_WAIT_MS = 60_000;

/** The values of the most traces in the window, under the filters, and how many there are. */
export interface GroupValues {
  values: { value: string | null; traces: number }[];
  /** Every value of the window, the one of no value too. */
  distinct: number;
}

/** One value's small result. Null when its read failed or found no place in time. */
export interface QueryGroup {
  /** Null: the traces without a value. */
  value: string | null;
  /** The traces of the value in the window, under the filters. */
  traces: number;
  result: QueryResult | null;
}

export interface GroupedResult {
  kind: "grouped";
  by: GroupBy;
  /** The most traces first. */
  groups: QueryGroup[];
  /** The values not drawn. */
  leftOut: number;
}

export interface GroupedDeps {
  /** The values of the query: `topGroupValues` under a timeout. */
  values(): Promise<GroupValues>;
  /** One value's query, under a timeout of its own. */
  run(query: Query): Promise<QueryResult | null>;
  /** The places of the small queries: this process's by default. */
  gate?: RqlGate;
}

/** The gate of every small query of this process. */
const groupGate = createRqlGate(GROUP_QUERIES_PER_PROJECT);

/** The small result of each value of the most traces, and how many values are left out. */
export async function runGrouped(
  projectId: string,
  query: Query,
  { values, run, gate = groupGate }: GroupedDeps,
): Promise<GroupedResult> {
  if (!isGrouped(query)) throw new Error("the query has no group-by");
  const limit = query.groupLimit ?? GROUP_LIMITS.default;
  const top = await values();
  const shown = top.values.slice(0, limit);
  const groups = await Promise.all(
    shown.map(async ({ value, traces }) => {
      const leave = await gate.wait(projectId, GROUP_WAIT_MS);
      if (!leave) return { value, traces, result: null };
      try {
        return { value, traces, result: await run(groupQuery(query, value)) };
      } catch {
        return { value, traces, result: null };
      } finally {
        leave();
      }
    }),
  );
  return { kind: "grouped", by: query.groupBy, groups, leftOut: top.distinct - shown.length };
}

/**
 * One bounded query on the trace summaries of the project: the values of the group-by in the
 * window, under the query's filter and the page's, the most traces first, and their count. A task
 * is each task the trace ran in; a trace in none is the group of no value.
 */
export async function topGroupValues(
  projectId: string,
  query: Query,
  scope: QueryScope,
  db: MetricsDb,
): Promise<GroupValues> {
  const checked = await runnableQuery(projectId, query, scope, db);
  if (!isGrouped(checked)) throw new Error("the query has no group-by");
  const { scorer: _, ...own } = checked.filters as TraceFilter & { scorer?: unknown };
  const condition = traceFilterCondition(projectId, withClause<TraceFilter>(own, scope.filter));
  const property = propertyOf(checked.groupBy);
  const time = scope.by === "known" ? sql`s.updated_at` : sql`s.started_at`;
  const { join, value } =
    property !== undefined
      ? { join: sql``, value: sql`(s.properties ->> ${property}::text)` }
      : checked.groupBy === "task"
        ? {
            join: sql`left join lateral unnest(${traceTasks(sql`s`)}) g(v) on true`,
            value: sql`g.v`,
          }
        : {
            join: sql``,
            value: checked.groupBy === "user" ? sql`s.end_user_id` : sql`s.session_id`,
          };
  const rows = rowsOf<{ value: string | null; traces: number; value_count: number }>(
    await db.execute(sql`
      with counted as (
        select ${value} as value, count(*)::int as traces
        from otel_trace_summaries s ${join}
        where s.project_id = ${projectId}
          and ${time} >= ${scope.since.toISOString()}::timestamptz
          and ${time} < ${scope.until.toISOString()}::timestamptz
          ${condition ? sql`and ${condition}` : sql``}
        group by 1
      )
      select value, traces, (count(*) over ())::int as value_count
      from counted
      order by traces desc, value collate "C" nulls last
      limit ${checked.groupLimit ?? GROUP_LIMITS.default}`),
  );
  return {
    values: rows.map(({ value, traces }) => ({ value, traces: Number(traces) })),
    distinct: Number(rows[0]?.value_count ?? 0),
  };
}
