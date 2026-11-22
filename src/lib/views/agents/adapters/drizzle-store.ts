import { type SQL, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import { detectionOf, weakestSource } from "@/lib/views/entities/detection";
import {
  type AgentOverride,
  applyOverrideChange,
  canonicalKey,
  displayNameOf,
  isEmptyOverride,
  type OverrideView,
  overrideView,
  sourceKeys,
} from "../domain/overrides";
import {
  AGENTS_NAV_WINDOW_DAYS,
  type AgentHandoff,
  type AgentReadOptions,
  type AgentRow,
  type AgentToolStat,
  type AgentWindow,
  rateOf,
  roundMs,
  roundUsd,
} from "../domain/types";
import type { AgentOverrideStore, AgentStore } from "../ports/store";

/**
 * The Agents page's reads over Postgres (RC-775).
 *
 * Read budget: every span query filters `project_id`, `agent_key is not null`
 * (or one agent) and a `started_at` window, so Postgres reads the partial
 * index `otel_spans_project_agent_key_started_idx` and never a span with no
 * agent. The environment filter is a probe of `otel_trace_summaries` by its
 * primary key. `tests/drizzle-store.integration.test.ts` pins each plan.
 *
 * Overrides (RC-776) apply here, at read time: a merged key reads as its
 * target inside the SQL (so runs and percentiles are exact), then names and
 * hidden flags decorate the rows. Stored spans are never rewritten.
 */

type ReadDb = Pick<ReturnType<typeof getDb>, "execute">;
type WriteDb = Pick<ReturnType<typeof getDb>, "transaction">;

const DAY_MS = 86_400_000;
const MAX_AGENTS = 200;
const MAX_TOOLS = 200;
const MAX_SERVERS = 100;
const MAX_HANDOFFS = 500;
const MAX_ENVIRONMENTS = 50;

const IS_ERROR = sql`(s.status_code = 2 or s.attributes ? 'error.type')`;
const TOOL_NAME = sql`coalesce(nullif(s.attributes ->> 'gen_ai.tool.name', ''), regexp_replace(s.name, '^execute_tool ?', ''))`;

export function createDrizzleAgentStore(db: ReadDb): AgentStore {
  const listOverrides = async (projectId: string): Promise<AgentOverride[]> =>
    rowsOf<OverrideRow>(await db.execute(overridesQuery(projectId))).map(toOverride);
  const listAgentEnvironments = async (projectId: string, window: AgentWindow) =>
    rowsOf<{ environment: string }>(
      await db.execute(agentEnvironmentsQuery(projectId, window)),
    ).map((row) => row.environment);
  const readHandoffs = async (
    projectId: string,
    window: AgentWindow,
    view: OverrideView,
    sources?: readonly string[],
  ) =>
    rowsOf<HandoffRow>(
      await db.execute(handoffsQuery(projectId, window, { merges: view.merges, sources })),
    ).map((row) => toHandoff(row, view));
  const visible = (view: OverrideView, options: AgentReadOptions) => (key: string) =>
    options.showHidden === true || !view.hidden.has(key);

  return {
    listOverrides,
    listAgentEnvironments,
    async listHandoffs(projectId, window, options = {}) {
      const view = overrideView(await listOverrides(projectId));
      const shown = visible(view, options);
      return (await readHandoffs(projectId, window, view)).filter(
        (edge) => shown(edge.from) && shown(edge.to),
      );
    },
    async listAgents(projectId, window, options = {}) {
      const view = overrideView(await listOverrides(projectId));
      const [stats, environments] = await Promise.all([
        db
          .execute(agentStatsQuery(projectId, window, { merges: view.merges }))
          .then((result) => rowsOf<StatsRow>(result)),
        listAgentEnvironments(projectId, window),
      ]);
      const shown = visible(view, options);
      return {
        agents: stats.map((row) => toAgentRow(row, view)).filter((row) => shown(row.key)),
        environments,
      };
    },
    async getAgent(projectId, requested, window) {
      const view = overrideView(await listOverrides(projectId));
      const key = canonicalKey(view, requested);
      const sources = sourceKeys(view, key);
      const [agent] = rowsOf<StatsRow>(
        await db.execute(agentStatsQuery(projectId, window, { merges: view.merges, sources })),
      ).map((row) => toAgentRow(row, view));
      if (!agent) return null;
      const [tools, servers, handoffs] = await Promise.all([
        db
          .execute(agentToolsQuery(projectId, sources, window))
          .then((result) => rowsOf<ToolRow>(result)),
        db
          .execute(agentMcpServersQuery(projectId, sources, window))
          .then((result) => rowsOf<ServerRow>(result)),
        readHandoffs(projectId, window, view, sources),
      ]);
      return {
        agent,
        tools: tools.map(toToolStat),
        mcpServers: servers.map((row) => ({
          server: row.server,
          calls: Number(row.calls),
          errors: Number(row.errors),
        })),
        callers: handoffs.filter((edge) => edge.to === key),
        callees: handoffs.filter((edge) => edge.from === key),
      };
    },
    async projectsWithAgents(projectIds, now) {
      if (projectIds.length === 0) return [];
      return rowsOf<{ id: string }>(await db.execute(projectsWithAgentsQuery(projectIds, now))).map(
        (row) => row.id,
      );
    },
  };
}

/**
 * The override writes (RC-776). One change at a time, checked against the
 * project's other overrides under a per-project transaction lock, so two
 * concurrent merges cannot make a chain.
 */
export function createDrizzleAgentOverrideStore(db: WriteDb): AgentOverrideStore {
  return {
    changeOverride(projectId, change, actor) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`agent_overrides:${projectId}`}))`,
        );
        const current = rowsOf<OverrideRow>(await tx.execute(overridesQuery(projectId))).map(
          toOverride,
        );
        const result = applyOverrideChange(current, change);
        if (!result.ok) return result;
        const { override } = result;
        if (isEmptyOverride(override)) {
          await tx.execute(
            sql`delete from agent_overrides where project_id = ${projectId} and agent_key = ${override.agentKey}`,
          );
        } else {
          await tx.execute(sql`
            insert into agent_overrides (project_id, agent_key, display_name, hidden, merged_into, updated_by, updated_at)
            values (${projectId}, ${override.agentKey}, ${override.displayName}, ${override.hidden}, ${override.mergedInto}, ${actor}, now())
            on conflict (project_id, agent_key) do update set
              display_name = excluded.display_name, hidden = excluded.hidden, merged_into = excluded.merged_into,
              updated_by = excluded.updated_by, updated_at = excluded.updated_at
          `);
        }
        return result;
      });
    },
  };
}

// — Queries, exported for the read-budget test ————————————————————————————————

/** How the overrides shape a read: merged keys read as their target; `sources` narrows to one agent's keys. */
export interface AgentQueryScope {
  merges?: ReadonlyMap<string, string>;
  sources?: readonly string[];
}

/**
 * One row per agent (after merges): runs (agent × trace), errors, cost, p95 run
 * latency, first and last seen, and the weakest detection source of its spans
 * (RC-779; `from_service`: a heuristic span took its key from `service.name`).
 */
export function agentStatsQuery(
  projectId: string,
  window: AgentWindow,
  scope: AgentQueryScope = {},
): SQL {
  const merge = mergeJoin(scope.merges, sql`s.agent_key`, "m");
  return sql`
    with runs as (
      select ${merge.key} as agent_key, s.trace_id,
        bool_or(${IS_ERROR}) as failed,
        sum(s.cost_usd) as cost_usd,
        extract(epoch from max(s.ended_at) - min(s.started_at)) * 1000 as duration_ms,
        min(s.started_at) as first_seen_at,
        max(s.started_at) as last_seen_at,
        ${weakestSource(sql`s.agent_source`)} as agent_source,
        bool_or(s.agent_source = 'heuristic' and s.agent_key = s.service_name) as from_service
      from otel_spans s${merge.join}
      where ${agentSpans(projectId, window, scope.sources)}
      group by 1, s.trace_id
    )
    select r.agent_key as key,
      count(*)::int as calls,
      count(*) filter (where r.failed)::int as errors,
      coalesce(sum(r.cost_usd), 0)::float8 as cost_usd,
      percentile_cont(0.95) within group (order by r.duration_ms)::float8 as p95_ms,
      min(r.first_seen_at) as first_seen_at,
      max(r.last_seen_at) as last_seen_at,
      ${weakestSource(sql`r.agent_source`)} as agent_source,
      coalesce(bool_or(r.from_service), false) as from_service
    from runs r
    group by r.agent_key
    order by calls desc, r.agent_key
    limit ${MAX_AGENTS}
  `;
}

/** The environments of the window's traces that ran an agent, unfiltered. */
export function agentEnvironmentsQuery(projectId: string, window: AgentWindow): SQL {
  return sql`
    select distinct t.environment
    from otel_trace_summaries t
    where t.project_id = ${projectId}
      and t.started_at >= ${window.since.toISOString()}::timestamptz and t.started_at < ${window.until.toISOString()}::timestamptz
      and t.environment is not null and t.agents <> '{}'::text[]
    order by t.environment
    limit ${MAX_ENVIRONMENTS}
  `;
}

/** The agent's tool spans per tool: `gen_ai.tool.name`, else the span name less its `execute_tool`. */
export function agentToolsQuery(
  projectId: string,
  sources: readonly string[],
  window: AgentWindow,
): SQL {
  return sql`
    select ${TOOL_NAME} as tool,
      count(*)::int as calls,
      count(*) filter (where ${IS_ERROR})::int as errors,
      percentile_cont(0.95) within group (order by s.duration_ms)::float8 as p95_ms
    from otel_spans s
    where ${agentSpans(projectId, window, sources)} and s.span_class = 'tool'
    group by 1
    order by calls desc, tool
    limit ${MAX_TOOLS}
  `;
}

/** The MCP servers the agent calls: its client-side MCP spans. */
export function agentMcpServersQuery(
  projectId: string,
  sources: readonly string[],
  window: AgentWindow,
): SQL {
  return sql`
    select s.mcp_server as server,
      count(*)::int as calls,
      count(*) filter (where ${IS_ERROR})::int as errors
    from otel_spans s
    where ${agentSpans(projectId, window, sources)} and s.mcp_server is not null and s.mcp_role = 'consumed'
    group by s.mcp_server
    order by calls desc, server
    limit ${MAX_SERVERS}
  `;
}

/**
 * One edge per (caller, callee) after merges: its `invoke_agent` spans, else
 * (a handoff named only by attributes) the traces it happened in. A merge that
 * joins both ends leaves no edge. With `sources`, only the edges into or out
 * of that agent's keys.
 */
export function handoffsQuery(
  projectId: string,
  window: AgentWindow,
  scope: AgentQueryScope = {},
): SQL {
  const touching = scope.sources
    ? sql` and (s.agent_key in ${inList(scope.sources)} or s.caller_agent_key in ${inList(scope.sources)})`
    : sql``;
  const to = mergeJoin(scope.merges, sql`s.agent_key`, "mt");
  const from = mergeJoin(scope.merges, sql`s.caller_agent_key`, "mf");
  return sql`
    select e.from_key, e.to_key, case when e.invocations > 0 then e.invocations else e.traces end as count
    from (
      select ${from.key} as from_key, ${to.key} as to_key,
        count(*) filter (where s.operation_name = 'invoke_agent')::int as invocations,
        count(distinct s.trace_id)::int as traces
      from otel_spans s${to.join}${from.join}
      where ${agentSpans(projectId, window)} and s.caller_agent_key is not null${touching}
      group by 1, 2
    ) e
    where e.from_key <> e.to_key
    order by count desc, e.from_key, e.to_key
    limit ${MAX_HANDOFFS}
  `;
}

/**
 * The projects with multi-agent data since {@link AGENTS_NAV_WINDOW_DAYS}
 * days before `now`: one span whose agent is not the `service.name` fallback,
 * or two agent keys. A few index probes per project.
 */
export function projectsWithAgentsQuery(projectIds: readonly string[], now: Date): SQL {
  const since = sql`${new Date(now.getTime() - AGENTS_NAV_WINDOW_DAYS * DAY_MS).toISOString()}::timestamptz`;
  const ids = sql.join(
    projectIds.map((id) => sql`(${id}::uuid)`),
    sql`, `,
  );
  return sql`
    select p.id::text as id
    from (values ${ids}) as p(id)
    where exists (
      select 1 from otel_spans s
      where s.project_id = p.id and s.agent_key is not null and s.started_at >= ${since}
        and (s.agent_source is distinct from 'heuristic' or s.service_name is null or s.agent_key <> s.service_name)
    ) or exists (
      select 1
      from (
        select s.agent_key from otel_spans s
        where s.project_id = p.id and s.agent_key is not null and s.started_at >= ${since}
        limit 1
      ) first_agent
      where exists (
        select 1 from otel_spans s
        where s.project_id = p.id and s.agent_key is not null and s.started_at >= ${since} and s.agent_key <> first_agent.agent_key
      )
    )
  `;
}

// — Helpers ——————————————————————————————————————————————————————————————————

interface StatsRow {
  key: string;
  calls: number | string;
  errors: number | string;
  cost_usd: number | string | null;
  p95_ms: number | string | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  agent_source: string | null;
  from_service: boolean | null;
}

interface ToolRow {
  tool: string;
  calls: number | string;
  errors: number | string;
  p95_ms: number | string;
}

interface ServerRow {
  server: string;
  calls: number | string;
  errors: number | string;
}

interface OverrideRow {
  agent_key: string;
  display_name: string | null;
  hidden: boolean;
  merged_into: string | null;
}

interface HandoffRow {
  from_key: string;
  to_key: string;
  count: number | string;
}

/** The project's agent overrides, at most a few hundred rows: one primary-key range read. */
export function overridesQuery(projectId: string): SQL {
  return sql`
    select agent_key, display_name, hidden, merged_into
    from agent_overrides
    where project_id = ${projectId}
    order by agent_key
  `;
}

/** The window's agent spans: one agent's keys when `sources` is set, else every agent's; one environment's traces when set. */
function agentSpans(projectId: string, window: AgentWindow, sources?: readonly string[]): SQL {
  const agent = sources ? sql`s.agent_key in ${inList(sources)}` : sql`s.agent_key is not null`;
  // The summary side is bounded too: a trace starts at most a day before its spans in the window.
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

/** A key column read through the merges: a left join on the merge pairs, none with no merge. */
function mergeJoin(
  merges: ReadonlyMap<string, string> | undefined,
  column: SQL,
  alias: string,
): { key: SQL; join: SQL } {
  if (!merges || merges.size === 0) return { key: column, join: sql`` };
  const pairs = sql.join(
    [...merges].map(([source, target]) => sql`(${source}, ${target})`),
    sql`, `,
  );
  const name = sql.raw(alias);
  return {
    key: sql`coalesce(${name}.to_key, ${column})`,
    join: sql` left join (values ${pairs}) as ${name}(from_key, to_key) on ${name}.from_key = ${column}`,
  };
}

function inList(values: readonly string[]): SQL {
  return sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

function toOverride(row: OverrideRow): AgentOverride {
  return {
    agentKey: row.agent_key,
    displayName: row.display_name,
    hidden: row.hidden,
    mergedInto: row.merged_into,
  };
}

function toAgentRow(row: StatsRow, view: OverrideView): AgentRow {
  const calls = Number(row.calls);
  const errors = Number(row.errors);
  return {
    key: row.key,
    displayName: displayNameOf(view, row.key),
    hidden: view.hidden.has(row.key),
    mergedKeys: sourceKeys(view, row.key).slice(1),
    calls,
    errors,
    errorRate: rateOf(errors, calls),
    costUsd: roundUsd(row.cost_usd),
    p95Ms: roundMs(row.p95_ms),
    firstSeenAt: new Date(row.first_seen_at),
    lastSeenAt: new Date(row.last_seen_at),
    detection: detectionOf("agent", row.agent_source, { fromService: row.from_service === true }),
  };
}

function toToolStat(row: ToolRow): AgentToolStat {
  const calls = Number(row.calls);
  const errors = Number(row.errors);
  return {
    tool: row.tool,
    calls,
    errors,
    errorRate: rateOf(errors, calls),
    p95Ms: roundMs(row.p95_ms),
  };
}

function toHandoff(row: HandoffRow, view: OverrideView): AgentHandoff {
  return {
    from: row.from_key,
    to: row.to_key,
    fromName: displayNameOf(view, row.from_key),
    toName: displayNameOf(view, row.to_key),
    count: Number(row.count),
  };
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: unknown[] }).rows ?? (result as unknown[])) as T[];
}
