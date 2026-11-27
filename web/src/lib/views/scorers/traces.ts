import { type SQL, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { traceFilterCondition } from "@/lib/synthesis/traces/trace-filters";
import type { ScorerDb } from "./store";
import type { ScorerTarget, ScorerTrace } from "./types";

type SummaryRow = {
  trace_id: string;
  started_at: string | Date;
  duration_ms: number | string;
  cost_usd: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  has_error: boolean;
  models: string[];
  tools: string[];
  agents: string[];
  mcp_servers: string[];
  service_name: string | null;
  environment: string | null;
  attributes: Record<string, unknown> | null;
};

const OTLP_KEY = "otlp:";

/** These traces as a scorer reads them, in the order of their ids. Unknown ids are left out. */
export async function loadScorerTraces(
  projectId: string,
  traceIds: readonly string[],
  db: Pick<ScorerDb, "execute"> = getDb(),
): Promise<ScorerTrace[]> {
  if (traceIds.length === 0) return [];
  const ids = sql.join(
    traceIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return readTraces(
    sql`s.project_id = ${projectId} and s.trace_id in (${ids}) order by s.trace_id`,
    db,
  );
}

/** The newest traces a scorer takes, newest first. */
export async function latestMatchingTraces(
  projectId: string,
  target: ScorerTarget,
  limit: number,
  db: Pick<ScorerDb, "execute"> = getDb(),
): Promise<ScorerTrace[]> {
  return readTraces(
    sql`s.project_id = ${projectId} and ${targetCondition(projectId, target)}
      order by s.started_at desc, s.trace_id limit ${limit}`,
    db,
  );
}

/** How many traces that started at or after `since` a scorer takes. */
export async function countMatchingTraces(
  projectId: string,
  target: ScorerTarget,
  since: Date,
  db: Pick<ScorerDb, "execute"> = getDb(),
): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`select count(*)::int as n from otel_trace_summaries s
      where s.project_id = ${projectId} and s.started_at >= ${since.toISOString()}::timestamptz
        and ${targetCondition(projectId, target)}`),
  );
  return Number(row?.n ?? 0);
}

/** Whether a scorer takes the summary row `s` of this project. */
export function targetCondition(projectId: string, { filter, tasks }: ScorerTarget): SQL {
  const condition = traceFilterCondition(projectId, filter) ?? sql`true`;
  if (tasks === null) return condition;
  if (tasks.length === 0) return sql`false`;
  return sql`(${condition} and s.trace_id in (${taskTraces(projectId, tasks)}))`;
}

export function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? result) as T[];
}

/**
 * The traces of these tasks' turns. A turn's trace is its `otlp:<trace id>` key, and every trace its
 * steps' events carry (a runtime-lane turn), as in the Sessions list (`synthesis/traces/v2`).
 */
export function taskTraces(projectId: string, taskIds: readonly string[]): SQL {
  const ids = sql.join(
    taskIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`
    select substr(t.turn_key, ${OTLP_KEY.length + 1}) from trace_turns t
    where t.project_id = ${projectId} and t.workflow_id in (${ids})
      and t.turn_key like ${`${OTLP_KEY}%`}
    union
    select e.trace_id from trace_turns t
    join trace_turn_steps st on st.project_id = t.project_id and st.turn_id = t.id
    join trace_events e on e.project_id = st.project_id and e.id = st.trace_event_id
    where t.project_id = ${projectId} and t.workflow_id in (${ids}) and e.trace_id is not null`;
}

/** The summary rows with the attributes of each trace's representative span (the root). */
async function readTraces(condition: SQL, db: Pick<ScorerDb, "execute">): Promise<ScorerTrace[]> {
  const rows = rowsOf<SummaryRow>(
    await db.execute(sql`
      select s.trace_id, s.started_at, s.duration_ms, s.cost_usd, s.input_tokens, s.output_tokens,
        s.has_error, s.models, s.tools, s.agents, s.mcp_servers, s.service_name, s.environment,
        root.attributes
      from otel_trace_summaries s
      left join lateral (
        select o.attributes from otel_spans o
        where o.project_id = s.project_id and o.trace_id = s.trace_id
        order by (o.parent_span_id is null) desc, o.started_at, o.span_id
        limit 1
      ) root on true
      where ${condition}`),
  );
  return rows.map((row) => ({
    traceId: row.trace_id,
    startedAt: new Date(row.started_at),
    durationMs: Number(row.duration_ms),
    costUsd: Number(row.cost_usd),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    error: row.has_error,
    models: row.models,
    tools: row.tools,
    agents: row.agents,
    mcpServers: row.mcp_servers,
    service: row.service_name,
    environment: row.environment,
    attributes: row.attributes ?? {},
  }));
}
