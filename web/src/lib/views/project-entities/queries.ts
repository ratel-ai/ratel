import { type SQL, sql } from "drizzle-orm";
import type { McpRole } from "@/lib/ingest/otlp/dimensions";
import type { getDb } from "@/lib/platform/db/client";
import type { AgentToolEntry } from "./agents-model";

/**
 * What the Agents and MCP servers pages read beyond `views/agents` and
 * `views/mcp-servers` (RP-28, the approved RP-25 design): runs and calls per
 * day for the sparklines, an agent's tools with their MCP server, the tools
 * and agents of each server, and the error text of failed calls.
 *
 * The error text is the span's `error.type` attribute, the one error field an
 * `otel_spans` row keeps (`SAFE_ATTRIBUTE_KEYS` in `lib/ingest/otlp/span-rows.ts`)
 * and the one the Traces span inspector shows. The span status message is not
 * stored, so a failed call without `error.type` has no text.
 *
 * Read budget: as the queries of `views/agents` and `views/mcp-servers`, every
 * query filters `project_id`, `agent_key` (or `mcp_server`) and a `started_at`
 * window, so Postgres reads the partial indexes
 * `otel_spans_project_agent_key_started_idx` and
 * `otel_spans_project_mcp_server_started_idx`.
 */

export interface EntityWindow {
  since: Date;
  /** Exclusive. */
  until: Date;
  environment?: string | null;
}

export interface AgentListExtras {
  /** Runs per day of the window, oldest first, by agent key (after merges). */
  daily: Map<string, number[]>;
  /** The MCP servers each agent calls. */
  mcpServers: Map<string, number>;
}

/** The calls of one agent to one MCP server. */
export interface AgentMcpCalls {
  /** The agent's key after merges; null when neither the span nor its parent names one. */
  agent: string | null;
  server: string;
  calls: number;
  errors: number;
}

export interface McpServerExtras {
  /** Calls per day of the window, oldest first. */
  daily: number[];
  /** Tool names without the server prefix, busiest first. */
  tools: string[];
  /** Agent keys that call the server, busiest first. */
  agents: string[];
  /** The newest failed call's tool and `error.type`; null with no failure or no text. */
  lastError: { tool: string; message: string } | null;
}

export interface McpToolErrors {
  /** The most frequent `error.type` of the tool's failed calls, and how many carried it. */
  topError: { message: string; count: number } | null;
  /** Agent keys that call the tool, busiest first. */
  callers: string[];
}

export interface McpRecentError {
  tool: string;
  /** `error.type`; null when the span kept none. */
  message: string | null;
  agent: string | null;
  at: Date;
  traceId: string;
}

export interface McpServerDetailExtras {
  /** The median call latency, beside the p95 `views/mcp-servers` reads. */
  p50Ms: number;
  tools: Map<string, McpToolErrors>;
  /** The newest failed calls, newest first. */
  recent: McpRecentError[];
}

type ReadDb = Pick<ReturnType<typeof getDb>, "execute">;

const DAY_MS = 86_400_000;
const MAX_ROWS = 5_000;
const MAX_TOOLS = 200;
const RECENT_ERRORS = 10;

const IS_ERROR = sql`(s.status_code = 2 or s.attributes ? 'error.type')`;
const ERROR_TEXT = sql`nullif(s.attributes ->> 'error.type', '')`;
const MCP_ENVIRONMENT = sql`coalesce(s.attributes ->> 'deployment.environment.name', s.attributes ->> 'deployment.environment')`;
const AGENT_TOOL_NAME = sql`coalesce(nullif(s.attributes ->> 'gen_ai.tool.name', ''), regexp_replace(s.name, '^execute_tool ?', ''))`;
const MCP_TOOL_NAME = sql`coalesce(s.attributes ->> 'gen_ai.tool.name', regexp_replace(s.name, '^(MCP send )?tools/call ?', ''))`;
/** The calling agent: the span's own, else its parent's (a provided call is the server's span). */
const CALLING_AGENT = sql`coalesce(s.agent_key, s.caller_agent_key, p.agent_key, p.caller_agent_key)`;
const PARENT_JOIN = sql`left join lateral (
      select parent.agent_key, parent.caller_agent_key
      from otel_spans parent
      where parent.project_id = s.project_id and parent.trace_id = s.trace_id and parent.span_id = s.parent_span_id
      limit 1
    ) p on s.parent_span_id is not null`;

/** The days of the window: one sparkline point each. */
export function windowDays(window: EntityWindow): number {
  return Math.max(1, Math.ceil((window.until.getTime() - window.since.getTime()) / DAY_MS));
}

/** Runs per day and MCP servers per agent, for the list. Merged keys read as their target. */
export async function listAgentExtras(
  projectId: string,
  window: EntityWindow,
  merges: ReadonlyMap<string, string>,
  db: ReadDb,
): Promise<AgentListExtras> {
  const [daily, servers] = await Promise.all([
    db.execute(agentDailyRunsQuery(projectId, window, merges)).then(rowsOf<DailyRow>),
    db.execute(agentMcpServerCountsQuery(projectId, window, merges)).then(rowsOf<CountRow>),
  ]);
  return {
    daily: series(daily, windowDays(window)),
    mcpServers: new Map(servers.map((row) => [row.key, Number(row.count)])),
  };
}

/** Who calls which MCP server, busiest first. Merged keys read as their target. */
export async function listAgentMcpCalls(
  projectId: string,
  window: EntityWindow,
  merges: ReadonlyMap<string, string>,
  db: ReadDb,
): Promise<AgentMcpCalls[]> {
  return rowsOf<AgentMcpCallsRow>(
    await db.execute(agentMcpCallsQuery(projectId, window, merges)),
  ).map((row) => ({ ...row, calls: Number(row.calls), errors: Number(row.errors) }));
}

/** One agent's tools with the MCP server each belongs to and the newest error text. */
export async function listAgentTools(
  projectId: string,
  sources: readonly string[],
  window: EntityWindow,
  db: ReadDb,
): Promise<AgentToolEntry[]> {
  const rows = rowsOf<AgentToolRow>(await db.execute(agentToolsQuery(projectId, sources, window)));
  return rows.map((row) => {
    const calls = Number(row.calls);
    const errors = Number(row.errors);
    return {
      tool: row.tool,
      server: row.server,
      calls,
      errors,
      errorRate: calls > 0 ? errors / calls : 0,
      p95Ms: Math.round(Number(row.p95_ms ?? 0) * 100) / 100,
      lastError: row.last_error,
    };
  });
}

/** Per server and side (`<key>|<role>`): calls per day, tools, calling agents and the newest error. */
export async function listMcpServerExtras(
  projectId: string,
  window: EntityWindow,
  db: ReadDb,
): Promise<Map<string, McpServerExtras>> {
  const [daily, reach, errors] = await Promise.all([
    db.execute(mcpDailyCallsQuery(projectId, window)).then(rowsOf<DailyRow & { role: McpRole }>),
    db.execute(mcpReachQuery(projectId, window)).then(rowsOf<ReachRow>),
    db.execute(mcpLastErrorsQuery(projectId, window)).then(rowsOf<LastErrorRow>),
  ]);
  const days = series(
    daily.map((row) => ({ ...row, key: mcpServerId(row.key, row.role) })),
    windowDays(window),
  );
  const out = new Map<string, McpServerExtras>();
  const entry = (id: string) => {
    let found = out.get(id);
    if (!found) {
      found = {
        daily: days.get(id) ?? new Array(windowDays(window)).fill(0),
        tools: [],
        agents: [],
        lastError: null,
      };
      out.set(id, found);
    }
    return found;
  };
  for (const [id, values] of days) entry(id).daily = values;
  const byServer = groupReach(reach, (row) => mcpServerId(row.key, row.role));
  for (const [id, rows] of byServer) {
    entry(id).tools = busiest(rows, (row) => row.tool);
    entry(id).agents = busiest(rows, (row) => row.agent);
  }
  for (const row of errors) {
    if (row.message)
      entry(mcpServerId(row.key, row.role)).lastError = { tool: row.tool, message: row.message };
  }
  return out;
}

/** One server side's p50, its tools' top error and callers, and its newest failed calls. */
export async function getMcpServerDetailExtras(
  projectId: string,
  ref: { key: string; role: McpRole },
  window: EntityWindow,
  db: ReadDb,
): Promise<McpServerDetailExtras> {
  const [latency, reach, top, recent] = await Promise.all([
    db
      .execute(mcpServerP50Query(projectId, ref, window))
      .then(rowsOf<{ p50_ms: number | string | null }>),
    db.execute(mcpReachQuery(projectId, window, ref)).then(rowsOf<ReachRow>),
    db.execute(mcpTopErrorsQuery(projectId, ref, window)).then(rowsOf<TopErrorRow>),
    db.execute(mcpRecentErrorsQuery(projectId, ref, window)).then(rowsOf<RecentErrorRow>),
  ]);
  const tools = new Map<string, McpToolErrors>();
  for (const [tool, rows] of groupReach(reach, (row) => row.tool)) {
    tools.set(tool, { topError: null, callers: busiest(rows, (row) => row.agent) });
  }
  for (const row of top) {
    const found = tools.get(row.tool) ?? { topError: null, callers: [] };
    tools.set(row.tool, { ...found, topError: { message: row.message, count: Number(row.count) } });
  }
  return {
    p50Ms: Math.round(Number(latency[0]?.p50_ms ?? 0) * 100) / 100,
    tools,
    recent: recent.map((row) => ({
      tool: row.tool,
      message: row.message,
      agent: row.agent,
      at: new Date(row.started_at),
      traceId: row.trace_id,
    })),
  };
}

/** The extras' map key for a server side. */
export function mcpServerId(key: string, role: string): string {
  return `${key}|${role}`;
}

// — Queries, exported for the read-budget test ————————————————————————————————

/** Runs (agent × trace) per agent and day; a run's day is its first span's. */
export function agentDailyRunsQuery(
  projectId: string,
  window: EntityWindow,
  merges: ReadonlyMap<string, string> = new Map(),
): SQL {
  const merge = mergeJoin(merges);
  return sql`
    with runs as (
      select ${merge.key} as agent_key, s.trace_id, min(s.started_at) as started_at
      from otel_spans s${merge.join}
      where ${agentSpans(projectId, window)}
      group by 1, s.trace_id
    )
    select r.agent_key as key, ${dayOf(sql`r.started_at`, window)} as day, count(*)::int as count
    from runs r
    group by 1, 2
    order by 1, 2
    limit ${MAX_ROWS}
  `;
}

/** How many MCP servers each agent calls (its client-side MCP spans). */
export function agentMcpServerCountsQuery(
  projectId: string,
  window: EntityWindow,
  merges: ReadonlyMap<string, string> = new Map(),
): SQL {
  const merge = mergeJoin(merges);
  return sql`
    select ${merge.key} as key, count(distinct s.mcp_server)::int as count
    from otel_spans s${merge.join}
    where ${agentSpans(projectId, window)} and s.mcp_server is not null and s.mcp_role = 'consumed'
    group by 1
    order by 1
    limit ${MAX_ROWS}
  `;
}

/**
 * Calls and errors per (calling agent, MCP server): a call that both sides recorded counts once,
 * and a call that one side recorded counts too. Only spans of the project and the window are read.
 *
 * Each server span pairs with at most one client span, and the reverse. Two known callers that
 * differ never pair. In this order:
 * 1. A client span and the earliest server span under it.
 * 2. In a cluster, the server spans and the client spans of one known caller.
 * 3. The server spans of a known caller that are left, and the client spans of no known caller.
 * 4. The server spans of no known caller, and any client span that is left.
 * What is left is a call of its own. A pair is its known caller's, when one side knows it. A
 * cluster is the spans of one trace, server and tool whose times overlap, also through a third.
 * Steps 2 to 4 need numbers only: a known caller has `greatest(clients, servers)` calls.
 *
 * A pair has the client's status, but the server's in step 3. Failed spans pair with failed ones
 * first. The limits: two records with no parent link, in two traces or with clocks too far apart
 * to overlap, cannot be matched and count as two calls. Two calls in one cluster, each recorded by
 * the other side only, cannot be told from one call and count as one.
 */
export function agentMcpCallsQuery(
  projectId: string,
  window: EntityWindow,
  merges: ReadonlyMap<string, string> = new Map(),
): SQL {
  const merge = mergeJoin(merges, sql`c.agent`);
  return sql`
    with spans as (
      select ${CALLING_AGENT} as agent, s.mcp_server as server, s.mcp_role as role,
        s.trace_id, s.span_id, s.parent_span_id, s.started_at, s.ended_at,
        s.name, s.attributes ->> 'gen_ai.tool.name' as tool_name, ${IS_ERROR} as failed
      from otel_spans s
      left join lateral (
        select parent.agent_key, parent.caller_agent_key
        from otel_spans parent
        where s.agent_key is null and s.caller_agent_key is null
          and parent.project_id = s.project_id and parent.trace_id = s.trace_id
          and parent.span_id = s.parent_span_id
        limit 1
      ) p on true
      where ${serverSpans(projectId, window)}
    ), calls as materialized (
      select c.*, min(c.role) over trace_server <> max(c.role) over trace_server as both_sides
      from (
        select ${merge.key} as agent, c.server collate "C" as server, c.role,
          c.trace_id collate "C" as trace_id, c.span_id, c.parent_span_id,
          c.started_at, c.ended_at, c.name, c.tool_name, c.failed
        from spans c${merge.join}
      ) c
      window trace_server as (partition by c.trace_id, c.server)
    ), linked as (
      select distinct on (c.trace_id, c.span_id) c.trace_id, c.span_id as client_id,
        p.span_id as server_id, coalesce(c.agent, p.agent) as agent, c.server, c.failed
      from calls p
      join calls c on c.trace_id = p.trace_id and c.span_id = p.parent_span_id
      where p.role = 'provided' and c.role = 'consumed' and c.server = p.server
        and (c.agent is null or c.agent = p.agent)
      order by c.trace_id, c.span_id, p.started_at, p.span_id
    ), unlinked as materialized (
      select calls.*, coalesce(
          nullif(tool_name, ''), regexp_replace(name, '^(execute_tool|(MCP send )?tools/call) ?', '')
        ) collate "C" as raw_tool
      from calls
      left join (
        select trace_id, client_id as span_id from linked
        union all
        select trace_id, server_id from linked
      ) pairs using (trace_id, span_id)
      where both_sides and pairs.span_id is null
    ), named as materialized (
      select unlinked.*, ${withoutServerPrefix(sql`raw_tool`, sql`server`)} as tool
      from unlinked
    ), clustered as (
      select starts.*,
        count(*) filter (where starts_cluster) over (
          partition by trace_id, server, tool order by started_at, span_id
        ) as cluster
      from (
        select named.*,
          started_at > max(ended_at) over (
            partition by trace_id, server, tool order by started_at, span_id
            rows between unbounded preceding and 1 preceding
          ) as starts_cluster
        from named
      ) starts
    ), callers as (
      select trace_id, server, tool, cluster, agent, clients, servers,
        client_errors, server_errors,
        greatest(servers - clients, 0) as servers_left,
        greatest(clients - servers, 0) as clients_left,
        least(greatest(servers - clients, 0), greatest(server_errors - client_errors, 0))
          as servers_left_errors,
        least(greatest(clients - servers, 0), greatest(client_errors - server_errors, 0))
          as clients_left_errors
      from (
        select trace_id, server, tool, cluster, agent,
          count(*) filter (where role = 'consumed') as clients,
          count(*) filter (where role = 'provided') as servers,
          count(*) filter (where role = 'consumed' and failed) as client_errors,
          count(*) filter (where role = 'provided' and failed) as server_errors
        from clustered
        group by 1, 2, 3, 4, 5
      ) sides
    ), unknown as (
      select u.server, u.servers, u.server_errors, u.client_errors,
        coalesce(k.clients_left, 0) as known_clients,
        coalesce(k.clients_left_errors, 0) as known_client_errors,
        coalesce(k.servers_left_errors, 0) as known_server_errors,
        least(u.clients, coalesce(k.servers_left, 0)) as given,
        u.clients - least(u.clients, coalesce(k.servers_left, 0)) as clients
      from callers u
      left join (
        select trace_id, server, tool, cluster, sum(clients_left) as clients_left,
          sum(servers_left) as servers_left, sum(clients_left_errors) as clients_left_errors,
          sum(servers_left_errors) as servers_left_errors
        from callers
        where agent is not null
        group by 1, 2, 3, 4
      ) k using (trace_id, server, tool, cluster)
      where u.agent is null
    ), unknown_kept as (
      select unknown.*, greatest(servers - known_clients - clients, 0) as servers_left,
        client_errors - greatest(
          least(given, client_errors, known_server_errors), client_errors - clients
        ) as kept_errors
      from unknown
    ), counted as (
      select agent, server, count(*) as calls, count(*) filter (where failed) as errors
      from calls
      where not both_sides
      group by 1, 2
      union all
      select agent, server, count(*), count(*) filter (where failed)
      from linked
      group by 1, 2
      union all
      select agent, server, sum(greatest(clients, servers)),
        sum(client_errors + servers_left_errors)
      from callers
      where agent is not null
      group by 1, 2
      union all
      select null, server, sum(clients + servers_left),
        sum(kept_errors + least(
          servers_left, greatest(server_errors - known_client_errors - kept_errors, 0)
        ))
      from unknown_kept
      group by 2
    )
    select agent, server, sum(calls)::int as calls, sum(errors)::int as errors
    from counted
    group by 1, 2
    having sum(calls) > 0
    order by calls desc, 1, 2
    limit ${MAX_ROWS}
  `;
}

/** The agent's tool spans per (tool, MCP server), the `mcp__<server>__` prefix dropped. */
export function agentToolsQuery(
  projectId: string,
  sources: readonly string[],
  window: EntityWindow,
): SQL {
  return sql`
    with t as (
      select ${AGENT_TOOL_NAME} as raw, s.mcp_server as server, s.duration_ms, s.started_at,
        ${IS_ERROR} as failed, ${ERROR_TEXT} as error_text
      from otel_spans s
      where ${agentSpans(projectId, window, sources)} and s.span_class = 'tool'
    )
    select ${withoutServerPrefix(sql`t.raw`, sql`t.server`)} as tool, t.server,
      count(*)::int as calls,
      count(*) filter (where t.failed)::int as errors,
      percentile_cont(0.95) within group (order by t.duration_ms)::float8 as p95_ms,
      (array_agg(t.error_text order by t.started_at desc) filter (where t.failed and t.error_text is not null))[1] as last_error
    from t
    group by 1, 2
    order by calls desc, tool
    limit ${MAX_TOOLS}
  `;
}

/** Calls per server side and day. */
export function mcpDailyCallsQuery(projectId: string, window: EntityWindow): SQL {
  return sql`
    select s.mcp_server as key, s.mcp_role as role, ${dayOf(sql`s.started_at`, window)} as day, count(*)::int as count
    from otel_spans s
    where ${serverSpans(projectId, window)}
    group by 1, 2, 3
    order by 1, 2, 3
    limit ${MAX_ROWS}
  `;
}

/** Calls per server side, tool and calling agent: the list's Tools and Agents, the detail's Callers. */
export function mcpReachQuery(
  projectId: string,
  window: EntityWindow,
  only?: { key: string; role: McpRole },
): SQL {
  return sql`
    select s.mcp_server as key, s.mcp_role as role,
      ${withoutServerPrefix(MCP_TOOL_NAME, sql`s.mcp_server`)} as tool,
      ${CALLING_AGENT} as agent,
      count(*)::int as calls
    from otel_spans s
    ${PARENT_JOIN}
    where ${serverSpans(projectId, window, only)}
    group by 1, 2, 3, 4
    order by calls desc, 1, 2, 3
    limit ${MAX_ROWS}
  `;
}

/** One server side's median call latency. */
export function mcpServerP50Query(
  projectId: string,
  ref: { key: string; role: McpRole },
  window: EntityWindow,
): SQL {
  return sql`
    select percentile_cont(0.5) within group (order by s.duration_ms)::float8 as p50_ms
    from otel_spans s
    where ${serverSpans(projectId, window, ref)}
  `;
}

/** Each server side's newest failed call: its tool and `error.type`. */
export function mcpLastErrorsQuery(projectId: string, window: EntityWindow): SQL {
  return sql`
    select distinct on (s.mcp_server, s.mcp_role) s.mcp_server as key, s.mcp_role as role,
      ${withoutServerPrefix(MCP_TOOL_NAME, sql`s.mcp_server`)} as tool, ${ERROR_TEXT} as message
    from otel_spans s
    where ${serverSpans(projectId, window)} and ${IS_ERROR}
    order by s.mcp_server, s.mcp_role, s.started_at desc
  `;
}

/** Per tool of one server side, its most frequent `error.type` and how many failed calls carried it. */
export function mcpTopErrorsQuery(
  projectId: string,
  ref: { key: string; role: McpRole },
  window: EntityWindow,
): SQL {
  return sql`
    select distinct on (e.tool) e.tool, e.message, e.count
    from (
      select ${withoutServerPrefix(MCP_TOOL_NAME, sql`s.mcp_server`)} as tool, ${ERROR_TEXT} as message,
        count(*)::int as count, max(s.started_at) as last_at
      from otel_spans s
      where ${serverSpans(projectId, window, ref)} and ${IS_ERROR} and ${ERROR_TEXT} is not null
      group by 1, 2
    ) e
    order by e.tool, e.count desc, e.last_at desc
    limit ${MAX_TOOLS}
  `;
}

/** One server side's newest failed calls. */
export function mcpRecentErrorsQuery(
  projectId: string,
  ref: { key: string; role: McpRole },
  window: EntityWindow,
): SQL {
  return sql`
    select ${withoutServerPrefix(MCP_TOOL_NAME, sql`s.mcp_server`)} as tool, ${ERROR_TEXT} as message,
      ${CALLING_AGENT} as agent, s.started_at, s.trace_id
    from otel_spans s
    ${PARENT_JOIN}
    where ${serverSpans(projectId, window, ref)} and ${IS_ERROR}
    order by s.started_at desc, s.span_id
    limit ${RECENT_ERRORS}
  `;
}

// — Helpers ——————————————————————————————————————————————————————————————————

interface DailyRow {
  key: string;
  day: number | string;
  count: number | string;
}

interface CountRow {
  key: string;
  count: number | string;
}

interface AgentMcpCallsRow {
  agent: string | null;
  server: string;
  calls: number | string;
  errors: number | string;
}

interface AgentToolRow {
  tool: string;
  server: string | null;
  calls: number | string;
  errors: number | string;
  p95_ms: number | string | null;
  last_error: string | null;
}

interface ReachRow {
  key: string;
  role: McpRole;
  tool: string;
  agent: string | null;
  calls: number | string;
}

interface LastErrorRow {
  key: string;
  role: McpRole;
  tool: string;
  message: string | null;
}

interface TopErrorRow {
  tool: string;
  message: string;
  count: number | string;
}

interface RecentErrorRow {
  tool: string;
  message: string | null;
  agent: string | null;
  started_at: Date | string;
  trace_id: string;
}

/** The window's agent spans (every agent's, or `sources`'); one environment's traces when set, as `views/agents` reads it. */
function agentSpans(projectId: string, window: EntityWindow, sources?: readonly string[]): SQL {
  const agent = sources ? sql`s.agent_key in ${inList(sources)}` : sql`s.agent_key is not null`;
  const environment = window.environment
    ? sql` and exists (
        select 1 from otel_trace_summaries t
        where t.project_id = s.project_id and t.trace_id = s.trace_id and t.environment = ${window.environment}
          and t.started_at >= ${new Date(window.since.getTime() - DAY_MS).toISOString()}::timestamptz
          and t.started_at < ${window.until.toISOString()}::timestamptz
      )`
    : sql``;
  return sql`s.project_id = ${projectId} and ${agent}
    and s.started_at >= ${window.since.toISOString()}::timestamptz and s.started_at < ${window.until.toISOString()}::timestamptz${environment}`;
}

/** The window's MCP spans (one server side's when `only` is set); one environment's when set, as `views/mcp-servers` reads it. */
function serverSpans(
  projectId: string,
  window: EntityWindow,
  only?: { key: string; role: McpRole },
): SQL {
  const server = only
    ? sql`s.mcp_server = ${only.key} and s.mcp_role = ${only.role}`
    : sql`s.mcp_server is not null`;
  const environment = window.environment
    ? sql` and ${MCP_ENVIRONMENT} = ${window.environment}`
    : sql``;
  return sql`s.project_id = ${projectId} and ${server}
    and s.started_at >= ${window.since.toISOString()}::timestamptz and s.started_at < ${window.until.toISOString()}::timestamptz${environment}`;
}

/** A tool name less a `mcp__<server>__` or `<server>__` prefix. */
function withoutServerPrefix(raw: SQL, server: SQL): SQL {
  return sql`coalesce(nullif(case
      when ${server} is null then ${raw}
      when starts_with(${raw}, 'mcp__' || ${server} || '__') then substr(${raw}, length(${server}) + 8)
      when starts_with(${raw}, ${server} || '__') then substr(${raw}, length(${server}) + 3)
      else ${raw}
    end, ''), '(unnamed)')`;
}

/** The window day (0 = the first) a timestamp falls in. */
function dayOf(column: SQL, window: EntityWindow): SQL {
  return sql`floor(extract(epoch from (${column} - ${window.since.toISOString()}::timestamptz)) / 86400)::int`;
}

/** The agent key read through the merges, as `views/agents` reads it. */
function mergeJoin(
  merges: ReadonlyMap<string, string>,
  column: SQL = sql`s.agent_key`,
): { key: SQL; join: SQL } {
  if (merges.size === 0) return { key: column, join: sql`` };
  const pairs = sql.join(
    [...merges].map(([source, target]) => sql`(${source}, ${target})`),
    sql`, `,
  );
  return {
    key: sql`coalesce(m.to_key, ${column})`,
    join: sql` left join (values ${pairs}) as m(from_key, to_key) on m.from_key = ${column}`,
  };
}

function inList(values: readonly string[]): SQL {
  return sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

function series(rows: readonly DailyRow[], days: number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const row of rows) {
    const day = Number(row.day);
    if (day < 0 || day >= days) continue;
    const values = out.get(row.key) ?? new Array(days).fill(0);
    values[day] += Number(row.count);
    out.set(row.key, values);
  }
  return out;
}

function groupReach(
  rows: readonly ReachRow[],
  by: (row: ReachRow) => string,
): Map<string, ReachRow[]> {
  const out = new Map<string, ReachRow[]>();
  for (const row of rows) out.set(by(row), [...(out.get(by(row)) ?? []), row]);
  return out;
}

/** The distinct values of `pick`, busiest first; nulls dropped. */
function busiest(rows: readonly ReachRow[], pick: (row: ReachRow) => string | null): string[] {
  const calls = new Map<string, number>();
  for (const row of rows) {
    const value = pick(row);
    if (value !== null) calls.set(value, (calls.get(value) ?? 0) + Number(row.calls));
  }
  return [...calls].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: unknown[] }).rows ?? (result as unknown[])) as T[];
}
