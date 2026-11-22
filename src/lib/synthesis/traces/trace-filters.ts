import { type SQL, sql } from "drizzle-orm";
import { isPivotKey } from "@/lib/ingest/pivots/model";
import { getDb } from "@/lib/platform/db/client";
import type { TraceFacetValue } from "@/lib/synthesis/traces/queries";
import { resolveTraceRange } from "@/lib/synthesis/traces/view";
import { TRACE_FILTER_FACET_LIMIT } from "./facet-limit";

export { TRACE_FILTER_FACET_LIMIT };

/**
 * Property filters on the Sessions and Turns lists (RC-505). Every filter and every facet value reads the
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
  /** Agents of the trace's spans (`agent_key`), behind `cloud-project-entities` (RC-790). */
  agents?: readonly string[];
  /** MCP servers of the trace's spans (`mcp_server`), behind `cloud-project-entities` (RC-790). */
  mcpServers?: readonly string[];
  /** Harnesses that called the trace's MCP server spans (`harness`), behind `cloud-project-entities` (RC-778). */
  harnesses?: readonly string[];
  /** Countries of those callers (`geo_country`), behind `cloud-project-entities` (RC-778). */
  countries?: readonly string[];
  /**
   * Pivot values by pivot key, behind `cloud-pivots` (RC-885): matched on the
   * rollup's `dims`. Values of one pivot are alternatives; pivots combine (AND).
   */
  pivots?: Readonly<Record<string, readonly string[]>>;
  /** "failed": any span reported an error; "ok": none did. */
  status?: "failed" | "ok";
  minCostUsd?: number;
  minTokens?: number;
}

export type TraceFilterFacetKey = "model" | "tool" | "service" | "environment";
/** The facets `cloud-project-entities` adds (RC-790). */
export type TraceEntityFacetKey = "agent" | "server" | "harness" | "country";
/**
 * `agent` and `server` are present only when the entity filters are on.
 * `pivots` (by pivot key) only when pivot keys were asked for.
 */
export type TraceFilterFacets = Record<TraceFilterFacetKey, TraceFacetValue[]> &
  Partial<Record<TraceEntityFacetKey, TraceFacetValue[]>> & {
    pivots?: Record<string, TraceFacetValue[]>;
  };

export interface TraceFilterFacetOptions {
  /** `cloud-project-entities`: also read the agent and MCP server values. Off, the query is as before. */
  entities?: boolean;
  /** `cloud-pivots` (RC-885): the configured pivot keys whose values to read. None, the query is as before. */
  pivots?: readonly string[];
}

export interface TraceFilterWindow {
  since?: Date;
  until?: Date;
}

export const EMPTY_TRACE_FILTER_FACETS: TraceFilterFacets = {
  model: [],
  tool: [],
  service: [],
  environment: [],
};
const FACET_KEYS: readonly TraceFilterFacetKey[] = ["model", "tool", "service", "environment"];
const ENTITY_FACET_KEYS: readonly TraceEntityFacetKey[] = ["agent", "server", "harness", "country"];
/** The facet name of a pivot's values in the facet query: `pivot:<key>`. */
const PIVOT_FACET_PREFIX = "pivot:";

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
    anyOf(sql`s.agents`, filter.agents),
    anyOf(sql`s.mcp_servers`, filter.mcpServers),
    anyOf(sql`s.harnesses`, filter.harnesses),
    anyOf(sql`s.countries`, filter.countries),
    ...pivotConditions(filter.pivots),
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
  options: TraceFilterFacetOptions = {},
): Promise<TraceFilterFacets> {
  const result = await db.execute(traceFacetsQuery(projectId, window, limit, options));
  const rows = ((result as unknown as { rows?: unknown[] }).rows ??
    (result as unknown as unknown[])) as Array<{
    facet: string;
    value: string;
    count: number | string;
  }>;
  const keys = options.entities ? [...FACET_KEYS, ...ENTITY_FACET_KEYS] : FACET_KEYS;
  const facets = Object.fromEntries(
    keys.map((key) => [key, [] as TraceFacetValue[]]),
  ) as unknown as TraceFilterFacets;
  const pivotKeys = facetPivotKeys(options.pivots);
  if (pivotKeys.length > 0)
    facets.pivots = Object.fromEntries(pivotKeys.map((key) => [key, [] as TraceFacetValue[]]));
  for (const row of rows) {
    const value = { value: row.value, count: Number(row.count) };
    if (row.facet.startsWith(PIVOT_FACET_PREFIX))
      facets.pivots?.[row.facet.slice(PIVOT_FACET_PREFIX.length)]?.push(value);
    else facets[row.facet as TraceFilterFacetKey | TraceEntityFacetKey]?.push(value);
  }
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
export function traceFacetsQuery(
  projectId: string,
  window: TraceFilterWindow,
  limit: number,
  { entities = false, pivots }: TraceFilterFacetOptions = {},
): SQL {
  const pivotKeys = facetPivotKeys(pivots);
  const withPivots = pivotKeys.length > 0;
  return sql`
    with w as (
      select s.models, s.tools, s.service_name, s.environment${entities ? sql`, s.agents, s.mcp_servers, s.harnesses, s.countries` : sql``}${withPivots ? sql`, s.dims` : sql``}
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
      ${
        entities
          ? sql`union all
      select 'agent', v, count(*)::int from w, unnest(w.agents) v group by v
      union all
      select 'server', v, count(*)::int from w, unnest(w.mcp_servers) v group by v
      union all
      select 'harness', v, count(*)::int from w, unnest(w.harnesses) v group by v
      union all
      select 'country', v, count(*)::int from w, unnest(w.countries) v group by v`
          : sql``
      }${
        withPivots
          ? sql`
      union all
      select 'pivot:' || k, v, count(*)::int from w, jsonb_each_text(w.dims) d(k, v)
      where k = any(${textArray(pivotKeys)}) group by k, v`
          : sql``
      }
    ),
    ranked as (
      select facet, value, count, row_number() over (partition by facet order by count desc, value collate "C") as rank
      from counted
    )
    select facet, value, count from ranked where rank <= ${limit} order by facet, rank`;
}

/** One condition per pivot: `dims @> {"key": value}` per value, OR'd. Keys no pivot can have are ignored. */
function pivotConditions(pivots: TraceFilter["pivots"]): SQL[] {
  if (!pivots) return [];
  const conditions: SQL[] = [];
  for (const [key, values] of Object.entries(pivots)) {
    if (!isPivotKey(key)) continue;
    const list = cleanValues(values);
    if (list.length === 0) continue;
    const alternatives = list.map(
      (value) => sql`s.dims @> ${JSON.stringify({ [key]: value })}::jsonb`,
    );
    conditions.push(sql`(${sql.join(alternatives, sql` or `)})`);
  }
  return conditions;
}

function facetPivotKeys(keys: readonly string[] | undefined): string[] {
  return [...new Set((keys ?? []).filter(isPivotKey))];
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
