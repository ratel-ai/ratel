import { type SQL, sql } from "drizzle-orm";
import type { McpRole } from "@/lib/ingest/otlp/dimensions";
import { getDb } from "@/lib/platform/db/client";

/**
 * The MCP servers of a project as entities (RC-777): each server a project
 * provides or consumes, read from the entity dimensions ingest writes on
 * `otel_spans` (RC-772: `mcp_server`, `mcp_role`, `mcp_session_id`).
 *
 * Read budget: every query filters `project_id`, `mcp_server is not null` (or
 * one server) and a `started_at` window, so Postgres reads the partial index
 * `otel_spans_project_mcp_server_started_idx` and never the spans that are no
 * MCP call. `queries.integration.test.ts` pins each plan.
 *
 * A server's provided and consumed sides are two rows: they count the same
 * calls from two processes, so their sums would count each call twice.
 */

export interface McpServerWindow {
  since: Date;
  /** Exclusive. */
  until: Date;
  /** Narrows the stats to one `deployment.environment(.name)`; the servers stay the same entities. */
  environment?: string | null;
}

export interface McpServerRef {
  key: string;
  /** Absent: the role with the most calls in the window. */
  role?: McpRole;
}

export interface McpServerRow {
  key: string;
  role: McpRole;
  /** The key: the span's `service.name` (provided) or the server named by the client (consumed). */
  displayName: string;
  /** The server's `service.version`, on the provided side only: a client span's version is the agent's. */
  version: string | null;
  calls: number;
  /** Calls with an error status or an `error.type` (a tool result with `isError`). */
  errors: number;
  errorRate: number;
  p95Ms: number;
  /** Distinct `mcp.session.id`; a call with no session counts its trace as the session. */
  sessions: number;
  /** Within the window. */
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface McpServerList {
  servers: McpServerRow[];
  /** Every environment the window's MCP calls ran in, whatever the filter. */
  environments: string[];
}

export interface McpToolStat {
  tool: string;
  calls: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
}

export interface McpValueCount {
  value: string;
  calls: number;
}

export interface McpCallingAgent {
  /** Null: no span of the call names an agent. */
  agent: string | null;
  calls: number;
}

export interface McpServerDetail {
  server: McpServerRow;
  /** The roles the server has in the window, busiest first. */
  roles: McpRole[];
  tools: McpToolStat[];
  agents: McpCallingAgent[];
  /**
   * The MCP protocol versions and transports (stdio | http) in use, from the
   * client facts ingest derives (`mcp_protocol_version`, `mcp_transport`,
   * RC-773). Absent (not empty) when no span of the window has them.
   */
  protocolVersions?: McpValueCount[];
  transports?: McpValueCount[];
}

type ReadDb = Pick<ReturnType<typeof getDb>, "execute">;

/** How far back the navigation looks for an MCP span. */
export const MCP_NAV_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const MAX_SERVERS = 200;
const MAX_TOOLS = 200;
const MAX_AGENTS = 50;
const MAX_ENVIRONMENTS = 50;
const MAX_FACET_VALUES = 20;

const ENVIRONMENT = sql`coalesce(s.attributes ->> 'deployment.environment.name', s.attributes ->> 'deployment.environment')`;
const IS_ERROR = sql`(s.status_code = 2 or s.attributes ? 'error.type')`;

/** The project's MCP servers in the window, busiest first. */
export async function listMcpServers(
  projectId: string,
  window: McpServerWindow,
  db: ReadDb = getDb(),
): Promise<McpServerList> {
  const [stats, environments] = await Promise.all([
    db.execute(mcpServerStatsQuery(projectId, window)).then((result) => rowsOf<StatsRow>(result)),
    listMcpEnvironments(projectId, window, db),
  ]);
  return { servers: stats.map(toServerRow), environments };
}

/** Every environment the window's MCP calls ran in; the window's `environment` is ignored. */
export async function listMcpEnvironments(
  projectId: string,
  window: McpServerWindow,
  db: ReadDb = getDb(),
): Promise<string[]> {
  return rowsOf<{ environment: string }>(
    await db.execute(mcpEnvironmentsQuery(projectId, window)),
  ).map((row) => row.environment);
}

/** One server's stats, tools, calling agents and (when kept) protocol versions and transports; null with no call in the window. */
export async function getMcpServer(
  projectId: string,
  ref: McpServerRef,
  window: McpServerWindow,
  db: ReadDb = getDb(),
): Promise<McpServerDetail | null> {
  const roles = rowsOf<StatsRow>(
    await db.execute(mcpServerStatsQuery(projectId, window, { key: ref.key })),
  ).map(toServerRow);
  const server = ref.role ? roles.find((row) => row.role === ref.role) : roles[0];
  if (!server) return null;
  const target = { key: server.key, role: server.role };
  const [tools, facets, agents] = await Promise.all([
    db.execute(mcpToolsQuery(projectId, target, window)).then((result) => rowsOf<ToolRow>(result)),
    db
      .execute(mcpFacetsQuery(projectId, target, window))
      .then((result) => rowsOf<FacetRow>(result)),
    db
      .execute(mcpAgentsQuery(projectId, target, window))
      .then((result) => rowsOf<AgentRow>(result)),
  ]);
  const facet = (name: FacetRow["facet"]) =>
    facets
      .filter((row) => row.facet === name)
      .map((row) => ({ value: row.value, calls: Number(row.calls) }));
  const protocolVersions = facet("protocol");
  const transports = facet("transport");
  return {
    server,
    roles: roles.map((row) => row.role),
    tools: tools.map(toToolStat),
    agents: agents.map((row) => ({ agent: row.agent, calls: Number(row.calls) })),
    ...(protocolVersions.length > 0 ? { protocolVersions } : {}),
    ...(transports.length > 0 ? { transports } : {}),
  };
}

/** Whether the project has an MCP span in the last {@link MCP_NAV_WINDOW_DAYS} days: one index probe. */
export async function hasMcpSpans(
  projectId: string,
  db: ReadDb = getDb(),
  now: Date = new Date(),
): Promise<boolean> {
  return (await projectsWithMcpSpans([projectId], db, now)).length > 0;
}

/** Of these projects, the ones {@link hasMcpSpans} is true for, in one round trip: one index probe each. */
export async function projectsWithMcpSpans(
  projectIds: readonly string[],
  db: ReadDb = getDb(),
  now: Date = new Date(),
): Promise<string[]> {
  if (projectIds.length === 0) return [];
  const rows = rowsOf<{ id: string }>(await db.execute(hasMcpSpansQuery(projectIds, now)));
  return rows.map((row) => row.id);
}

// — Queries, exported for the read-budget test ————————————————————————————————

/** One row per (server, role): calls, errors, p95, sessions, first and last seen. */
export function mcpServerStatsQuery(
  projectId: string,
  window: McpServerWindow,
  only: McpServerRef = { key: "" },
): SQL {
  return sql`
    select s.mcp_server as key, s.mcp_role as role,
      count(*)::int as calls,
      count(*) filter (where ${IS_ERROR})::int as errors,
      percentile_cont(0.95) within group (order by s.duration_ms)::float8 as p95_ms,
      count(distinct coalesce(s.mcp_session_id, 'trace:' || s.trace_id))::int as sessions,
      min(s.started_at) as first_seen_at,
      max(s.started_at) as last_seen_at,
      (array_agg(s.attributes ->> 'service.version' order by s.started_at desc)
        filter (where s.mcp_role = 'provided' and s.attributes ? 'service.version'))[1] as version
    from otel_spans s
    where ${serverSpans(projectId, window, only)}
    group by s.mcp_server, s.mcp_role
    order by calls desc, s.mcp_server, s.mcp_role
    limit ${MAX_SERVERS}
  `;
}

/** The environments of the window's MCP calls, unfiltered. */
export function mcpEnvironmentsQuery(projectId: string, window: McpServerWindow): SQL {
  return sql`
    select distinct ${ENVIRONMENT} as environment
    from otel_spans s
    where ${serverSpans(projectId, { since: window.since, until: window.until }, { key: "" })}
      and ${ENVIRONMENT} is not null
    order by environment
    limit ${MAX_ENVIRONMENTS}
  `;
}

/** Per tool: `gen_ai.tool.name` (else the span name less its `tools/call`), less a `<server>__` or `mcp__<server>__` prefix. */
export function mcpToolsQuery(
  projectId: string,
  ref: Required<McpServerRef>,
  window: McpServerWindow,
): SQL {
  const raw = sql`coalesce(s.attributes ->> 'gen_ai.tool.name', regexp_replace(s.name, '^(MCP send )?tools/call ?', ''))`;
  const prefixed = `${ref.key}__`;
  const claude = `mcp__${ref.key}__`;
  return sql`
    with c as (
      select
        case
          when starts_with(t.raw, ${claude}) then substr(t.raw, ${claude.length + 1})
          when starts_with(t.raw, ${prefixed}) then substr(t.raw, ${prefixed.length + 1})
          else t.raw
        end as tool,
        s.duration_ms, ${IS_ERROR} as failed
      from otel_spans s
      cross join lateral (select ${raw} as raw) t
      where ${serverSpans(projectId, window, ref)}
    )
    select coalesce(nullif(c.tool, ''), '(unnamed)') as tool,
      count(*)::int as calls,
      count(*) filter (where c.failed)::int as errors,
      percentile_cont(0.5) within group (order by c.duration_ms)::float8 as p50_ms,
      percentile_cont(0.95) within group (order by c.duration_ms)::float8 as p95_ms
    from c
    group by 1
    order by calls desc, tool
    limit ${MAX_TOOLS}
  `;
}

/** `mcp_protocol_version` and `mcp_transport` values (RC-773), one scan for both. */
export function mcpFacetsQuery(
  projectId: string,
  ref: Required<McpServerRef>,
  window: McpServerWindow,
): SQL {
  return sql`
    select f.facet, f.value, count(*)::int as calls
    from otel_spans s
    cross join lateral (values
      ('protocol', s.mcp_protocol_version),
      ('transport', s.mcp_transport)
    ) as f(facet, value)
    where ${serverSpans(projectId, window, ref)} and f.value is not null
    group by f.facet, f.value
    order by f.facet, calls desc, f.value
    limit ${MAX_FACET_VALUES * 2}
  `;
}

/**
 * The agents that call the server. A consumed call names its agent on its own
 * span. A provided call is the server's span, which names none: its parent,
 * the caller's client span (exported by the agent), does.
 */
export function mcpAgentsQuery(
  projectId: string,
  ref: Required<McpServerRef>,
  window: McpServerWindow,
): SQL {
  return sql`
    select coalesce(s.agent_key, s.caller_agent_key, p.agent_key, p.caller_agent_key) as agent, count(*)::int as calls
    from otel_spans s
    left join lateral (
      select parent.agent_key, parent.caller_agent_key
      from otel_spans parent
      where parent.project_id = s.project_id and parent.trace_id = s.trace_id and parent.span_id = s.parent_span_id
      limit 1
    ) p on s.parent_span_id is not null
    where ${serverSpans(projectId, window, ref)}
    group by 1
    order by calls desc, agent nulls last
    limit ${MAX_AGENTS}
  `;
}

/** The projects with an MCP span since {@link MCP_NAV_WINDOW_DAYS} days before `now`. */
export function hasMcpSpansQuery(projectIds: readonly string[], now: Date): SQL {
  const since = new Date(now.getTime() - MCP_NAV_WINDOW_DAYS * DAY_MS);
  const ids = sql.join(
    projectIds.map((id) => sql`(${id}::uuid)`),
    sql`, `,
  );
  return sql`
    select p.id::text as id
    from (values ${ids}) as p(id)
    where exists (
      select 1 from otel_spans s
      where s.project_id = p.id and s.mcp_server is not null and s.started_at >= ${since.toISOString()}::timestamptz
    )
  `;
}

// — Helpers ——————————————————————————————————————————————————————————————————

interface StatsRow {
  key: string;
  role: McpRole;
  calls: number | string;
  errors: number | string;
  p95_ms: number | string;
  sessions: number | string;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  version: string | null;
}

interface ToolRow {
  tool: string;
  calls: number | string;
  errors: number | string;
  p50_ms: number | string;
  p95_ms: number | string;
}

interface FacetRow {
  facet: "protocol" | "transport";
  value: string;
  calls: number | string;
}

interface AgentRow {
  agent: string | null;
  calls: number | string;
}

/** The spans of the window's MCP calls: one server (and role) when `only.key` is set, else every server. */
function serverSpans(projectId: string, window: McpServerWindow, only: McpServerRef): SQL {
  const server = only.key ? sql`s.mcp_server = ${only.key}` : sql`s.mcp_server is not null`;
  const role = only.key && only.role ? sql` and s.mcp_role = ${only.role}` : sql``;
  const environment = window.environment ? sql` and ${ENVIRONMENT} = ${window.environment}` : sql``;
  return sql`s.project_id = ${projectId} and ${server}${role}
    and s.started_at >= ${window.since.toISOString()}::timestamptz and s.started_at < ${window.until.toISOString()}::timestamptz${environment}`;
}

function toServerRow(row: StatsRow): McpServerRow {
  const calls = Number(row.calls);
  const errors = Number(row.errors);
  return {
    key: row.key,
    role: row.role,
    displayName: row.key,
    version: row.version ?? null,
    calls,
    errors,
    errorRate: calls > 0 ? errors / calls : 0,
    p95Ms: ms(row.p95_ms),
    sessions: Number(row.sessions),
    firstSeenAt: new Date(row.first_seen_at),
    lastSeenAt: new Date(row.last_seen_at),
  };
}

function toToolStat(row: ToolRow): McpToolStat {
  const calls = Number(row.calls);
  const errors = Number(row.errors);
  return {
    tool: row.tool,
    calls,
    errors,
    errorRate: calls > 0 ? errors / calls : 0,
    p50Ms: ms(row.p50_ms),
    p95Ms: ms(row.p95_ms),
  };
}

/** A latency to the hundredth of a millisecond: percentile_cont's float noise is not a reading. */
function ms(value: number | string): number {
  return Math.round(Number(value) * 100) / 100;
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: unknown[] }).rows ?? (result as unknown[])) as T[];
}
