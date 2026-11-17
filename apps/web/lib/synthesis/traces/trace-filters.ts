import { type SQL, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import type { TraceFacetValue } from "@/lib/synthesis/traces/queries";
import { resolveTraceRange } from "@/lib/synthesis/traces/view";

/**
 * Property filters on the Sessions and Turns lists (RC-505, behind
 * `cloud-traces-filters`). Every filter and every facet value reads the
 * per-trace rollup `otel_trace_summaries`, never `otel_spans`: models and
 * tools match on its GIN-indexed arrays, the rest on its columns.
 *
 * Values of one property are alternatives (OR); properties combine (AND).
 */
export interface TraceFilter {
  models?: readonly string[];
  tools?: readonly string[];
  services?: readonly string[];
  environments?: readonly string[];
  /** "failed": any span reported an error; "ok": none did. */
  status?: "failed" | "ok";
  minCostUsd?: number;
  minTokens?: number;
}

export type TraceFilterFacetKey = "model" | "tool" | "service" | "environment";
export type TraceFilterFacets = Record<TraceFilterFacetKey, TraceFacetValue[]>;

export interface TraceFilterWindow {
  since?: Date;
  until?: Date;
}

/** Values offered per property: the most frequent in the window. */
export const TRACE_FILTER_FACET_LIMIT = 50;
export const EMPTY_TRACE_FILTER_FACETS: TraceFilterFacets = {
  model: [],
  tool: [],
  service: [],
  environment: [],
};
const FACET_KEYS: readonly TraceFilterFacetKey[] = ["model", "tool", "service", "environment"];

/**
 * The rollup condition for a filter on the summary row aliased `s`, or null
 * when it filters nothing (so callers leave their query exactly as it was).
 */
export function traceFilterCondition(filter: TraceFilter | undefined): SQL | null {
  if (!filter) return null;
  const minCostUsd = atLeast(filter.minCostUsd);
  const minTokens = atLeast(filter.minTokens);
  const parts = [
    anyOf(sql`s.models`, filter.models),
    anyOf(sql`s.tools`, filter.tools),
    oneOf(sql`s.service_name`, filter.services),
    oneOf(sql`s.environment`, filter.environments),
    filter.status === "failed"
      ? sql`s.has_error`
      : filter.status === "ok"
        ? sql`not s.has_error`
        : null,
    minCostUsd !== null ? sql`s.cost_usd >= ${minCostUsd}` : null,
    minTokens !== null ? sql`s.input_tokens + s.output_tokens >= ${minTokens}` : null,
  ].filter((part): part is SQL => part !== null);
  return parts.length > 0 ? sql.join(parts, sql` and `) : null;
}

/**
 * Whether the project's trace `traceId` matches, or null when the filter is
 * empty: a primary-key probe of its summary row. It has no window of its own,
 * so a filtered list keeps exactly the traces the unfiltered list picks in its
 * window, including a trace whose summary starts before it.
 */
export function traceFilterMatch(
  projectId: string,
  filter: TraceFilter | undefined,
  traceId: SQL,
): SQL | null {
  const condition = traceFilterCondition(filter);
  if (!condition) return null;
  return sql`exists (select 1 from otel_trace_summaries s
    where s.project_id = ${projectId} and s.trace_id = ${traceId} and ${condition})`;
}

/** Each property's values in the window, most traces first: one query on the rollup. */
export async function getTraceFilterFacets(
  projectId: string,
  window: TraceFilterWindow,
  db: Pick<ReturnType<typeof getDb>, "execute"> = getDb(),
  limit = TRACE_FILTER_FACET_LIMIT,
): Promise<TraceFilterFacets> {
  const result = await db.execute(traceFacetsQuery(projectId, window, limit));
  const rows = ((result as unknown as { rows?: unknown[] }).rows ??
    (result as unknown as unknown[])) as Array<{
    facet: TraceFilterFacetKey;
    value: string;
    count: number | string;
  }>;
  const facets = Object.fromEntries(
    FACET_KEYS.map((key) => [key, [] as TraceFacetValue[]]),
  ) as TraceFilterFacets;
  for (const row of rows) facets[row.facet]?.push({ value: row.value, count: Number(row.count) });
  return facets;
}

/**
 * The window of the Sessions facet values. Sessions have no time window of
 * their own, so they take the Turns tab's default range: the two bars then
 * offer the same values, and the facet query never reads the whole retained
 * rollup.
 */
export function defaultTraceFilterFacetWindow(now: Date): TraceFilterWindow {
  const { since, until } = resolveTraceRange({}, now);
  return { since, until };
}

/** The facet query: the window's rollup rows once, then each property's top values. */
export function traceFacetsQuery(projectId: string, window: TraceFilterWindow, limit: number): SQL {
  return sql`
    with w as (
      select s.models, s.tools, s.service_name, s.environment
      from otel_trace_summaries s
      where s.project_id = ${projectId}
        ${window.since ? sql`and s.started_at >= ${window.since.toISOString()}::timestamptz` : sql``}
        ${window.until ? sql`and s.started_at < ${window.until.toISOString()}::timestamptz` : sql``}
    ),
    counted as (
      select 'model' as facet, v as value, count(*)::int as count from w, unnest(w.models) v group by v
      union all
      select 'tool', v, count(*)::int from w, unnest(w.tools) v group by v
      union all
      select 'service', w.service_name, count(*)::int from w where w.service_name is not null group by w.service_name
      union all
      select 'environment', w.environment, count(*)::int from w where w.environment is not null group by w.environment
    ),
    ranked as (
      select facet, value, count, row_number() over (partition by facet order by count desc, value collate "C") as rank
      from counted
    )
    select facet, value, count from ranked where rank <= ${limit} order by facet, rank`;
}

function anyOf(column: SQL, values: readonly string[] | undefined): SQL | null {
  const list = cleanValues(values);
  return list.length > 0 ? sql`${column} && ${textArray(list)}` : null;
}

function oneOf(column: SQL, values: readonly string[] | undefined): SQL | null {
  const list = cleanValues(values);
  return list.length > 0 ? sql`${column} = any(${textArray(list)})` : null;
}

function textArray(values: readonly string[]): SQL {
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

function cleanValues(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function atLeast(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}
