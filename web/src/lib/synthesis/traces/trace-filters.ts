import { type SQL, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import type { TraceFacetValue } from "@/lib/synthesis/traces/queries";
import { resolveTraceRange } from "@/lib/synthesis/traces/view";

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
  /** End users of the trace (`end_user_id`). */
  users?: readonly string[];
  /** Sessions of the trace (`session_id`). */
  sessions?: readonly string[];
  /**
   * Tasks (Agent health workflow ids) the trace ran in: a run of the task (`trace_turns.workflow_id`)
   * is the trace's `otlp:<trace id>` turn, or holds an event of the trace, as a scorer of tasks reads
   * them (`views/scorers/traces.ts#taskTraces`).
   */
  tasks?: readonly string[];
  /** "failed": any span reported an error; "ok": none did. */
  status?: "failed" | "ok";
  minCostUsd?: number;
  minTokens?: number;
  /**
   * Indexed trace properties (ADR-0012), by name: one of the values of each name. A name that is
   * not indexed has no stored values, so it keeps no trace: `runQuery` refuses it first.
   */
  properties?: Readonly<Record<string, readonly string[]>>;
  /**
   * Indexed trace properties the trace has no value of. A group-by's "no value" group is this
   * filter; like `properties`, a name that is not indexed is refused first.
   */
  withoutProperties?: readonly string[];
  /**
   * The trace has no end user, no session, or ran in no task: the "no value" group of a group-by
   * of the kinds (RTL-398).
   */
  without?: readonly ("user" | "session" | "task")[];
  /** More clauses that must match too, also on the same property. */
  and?: readonly TraceFilter[];
}

export type TraceFilterFacetKey = "model" | "tool" | "service" | "environment";
/** The facets `cloud-project-entities` adds (RC-790). */
export type TraceEntityFacetKey = "agent" | "server";
/** `agent` and `server` are present only when the entity filters are on. */
export type TraceFilterFacets = Record<TraceFilterFacetKey, TraceFacetValue[]> &
  Partial<Record<TraceEntityFacetKey, TraceFacetValue[]>>;

export interface TraceFilterFacetOptions {
  /** `cloud-project-entities`: also read the agent and MCP server values. Off, the query is as before. */
  entities?: boolean;
}

export interface TraceFilterWindow {
  since?: Date;
  until?: Date;
}

/** How a turn of the OTLP lane names its trace: `otlp:<trace id>`. */
const OTLP_KEY = "otlp:";
/** Values offered per property: the most frequent in the window. */
export const TRACE_FILTER_FACET_LIMIT = 50;
export const EMPTY_TRACE_FILTER_FACETS: TraceFilterFacets = {
  model: [],
  tool: [],
  service: [],
  environment: [],
};
const FACET_KEYS: readonly TraceFilterFacetKey[] = ["model", "tool", "service", "environment"];
const ENTITY_FACET_KEYS: readonly TraceEntityFacetKey[] = ["agent", "server"];

/**
 * The rollup condition for a filter on the summary row aliased `s` of the project, or null when it
 * filters nothing (so callers leave their query exactly as it was). The project bounds the task
 * runs a task filter reads; the caller bounds `s` to it.
 */
export function traceFilterCondition(
  projectId: string,
  filter: TraceFilter | undefined,
): SQL | null {
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
    oneOf(sql`s.end_user_id`, filter.users),
    oneOf(sql`s.session_id`, filter.sessions),
    inTasks(projectId, filter.tasks),
    filter.status === "failed"
      ? sql`s.has_error`
      : filter.status === "ok"
        ? sql`not s.has_error`
        : null,
    minCostUsd !== null ? sql`s.cost_usd >= ${minCostUsd}` : null,
    minTokens !== null ? sql`s.input_tokens + s.output_tokens >= ${minTokens}` : null,
    ...Object.entries(filter.properties ?? {}).map(([name, values]) => propertyIn(name, values)),
    ...cleanValues(filter.withoutProperties).map(
      // A row with no properties at all (null) has none of them either.
      (name) => sql`(s.properties ->> ${name}::text) is null`,
    ),
    ...[...new Set(filter.without ?? [])].map((field) =>
      field === "user"
        ? sql`s.end_user_id is null`
        : field === "session"
          ? sql`s.session_id is null`
          : sql`cardinality(${traceTasks(sql`s`)}) = 0`,
    ),
    ...(filter.and ?? []).map((clause) => traceFilterCondition(projectId, clause)),
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
  const condition = traceFilterCondition(projectId, filter);
  if (!condition) return null;
  return sql`exists (select 1 from otel_trace_summaries s
    where s.project_id = ${projectId} and s.trace_id = ${traceId} and ${condition})`;
}

/**
 * The ids of the tasks the trace of the summary row `alias` ran in, sorted: the same runs as the
 * task filter, read per row, as the column `tasks` of the RQL views (migration 0065) reads them. A
 * row with no summary (a score whose trace is gone) has none.
 */
export function traceTasks(alias: SQL): SQL {
  return sql`array(
    select x.workflow_id from (
      select tt.workflow_id from trace_turns tt
      where tt.project_id = ${alias}.project_id and tt.turn_key = ${OTLP_KEY}::text || ${alias}.trace_id
        and tt.workflow_id is not null
      union
      select tt.workflow_id from trace_events e
      join trace_turn_steps st on st.project_id = e.project_id and st.trace_event_id = e.id
      join trace_turns tt on tt.project_id = st.project_id and tt.id = st.turn_id
      where e.project_id = ${alias}.project_id and e.trace_id = ${alias}.trace_id
        and tt.workflow_id is not null
    ) x order by x.workflow_id)::text[]`;
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
    facet: TraceFilterFacetKey | TraceEntityFacetKey;
    value: string;
    count: number | string;
  }>;
  const keys = options.entities ? [...FACET_KEYS, ...ENTITY_FACET_KEYS] : FACET_KEYS;
  const facets = Object.fromEntries(
    keys.map((key) => [key, [] as TraceFacetValue[]]),
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
export function traceFacetsQuery(
  projectId: string,
  window: TraceFilterWindow,
  limit: number,
  { entities = false }: TraceFilterFacetOptions = {},
): SQL {
  return sql`
    with w as (
      select s.models, s.tools, s.service_name, s.environment${entities ? sql`, s.agents, s.mcp_servers` : sql``}
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
      select 'server', v, count(*)::int from w, unnest(w.mcp_servers) v group by v`
          : sql``
      }
    ),
    ranked as (
      select facet, value, count, row_number() over (partition by facet order by count desc, value collate "C") as rank
      from counted
    )
    select facet, value, count from ranked where rank <= ${limit} order by facet, rank`;
}

/** One of the values of a property: a containment the GIN index of `properties` answers. */
function propertyIn(name: string, values: readonly string[]): SQL | null {
  const list = cleanValues(values);
  if (list.length === 0) return null;
  const each = list.map(
    (value) => sql`s.properties @> jsonb_build_object(${name}::text, ${value}::text)`,
  );
  return each.length === 1 ? each[0] : sql`(${sql.join(each, sql` or `)})`;
}

/**
 * The trace ran in one of the tasks: a semi-join on the project's runs of those tasks, by the
 * `trace_turns` index of (project, task). The same runs as `views/scorers/traces.ts#taskTraces`.
 */
function inTasks(projectId: string, tasks: readonly string[] | undefined): SQL | null {
  const list = cleanValues(tasks);
  if (list.length === 0) return null;
  return sql`s.trace_id in (
    select substr(t.turn_key, ${OTLP_KEY.length + 1}) from trace_turns t
    where t.project_id = ${projectId} and t.workflow_id = any(${textArray(list)})
      and t.turn_key like ${`${OTLP_KEY}%`}
    union
    select e.trace_id from trace_turns t
    join trace_turn_steps st on st.project_id = t.project_id and st.turn_id = t.id
    join trace_events e on e.project_id = st.project_id and e.id = st.trace_event_id
    where t.project_id = ${projectId} and t.workflow_id = any(${textArray(list)})
      and e.trace_id is not null)`;
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
