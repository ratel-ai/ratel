import { type SQL, sql } from "drizzle-orm";
import type { QueryFilters, StepFlowNode } from "@/lib/contracts/query";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { type MetricsDb, rowsOf } from "@/lib/synthesis/metrics/query";
import { TOOL_NAME } from "@/lib/synthesis/traces/summary-refresh";
import { withClause } from "@/lib/synthesis/traces/trace-filter-clauses";
import { type TraceFilter, traceFilterCondition } from "@/lib/synthesis/traces/trace-filters";

/** What a trace did, in order: the tools, skills, agents, MCP servers and models it went through. */

export type StepKind = StepFlowNode;

export interface TraceStep {
  kind: StepKind;
  name: string;
  /** Its span ended in an error. */
  failed?: boolean;
  /** How long its span took. Null for a skill without a span. */
  durationMs?: number | null;
}

/** The traces a flow or a funnel was read from. */
export interface TraceSample {
  /** Traces in the window under the filters. */
  matched: number;
  /** The newest of them, up to the cap: the ones that were read. */
  read: number;
}

export interface SteppedTrace {
  traceId: string;
  startedAt: Date;
  steps: TraceStep[];
}

/** The traces one run reads: a result over more says it is a sample. */
export const TRACE_CAP = 2_000;
/** The steps read of one trace. */
export const STEPS_PER_TRACE = 200;

/**
 * The newest matching traces with their steps. The spans are the source (`otel_spans`, by start):
 * every trace has them as it arrives, where the turn ledger waits for a turn to close and holds only
 * what the runtime lane saw. A skill the SDK loaded without a span is its `skill_invoke` event.
 */
export async function loadTraceSteps(
  projectId: string,
  filters: Omit<QueryFilters, "scorer">,
  scope: QueryScope,
  kinds: readonly StepKind[],
  db: MetricsDb,
  cap = TRACE_CAP,
): Promise<{ sample: TraceSample; traces: SteppedTrace[] }> {
  const condition = traceFilterCondition(projectId, withClause<TraceFilter>(filters, scope.filter));
  const steps = kinds.map((kind) => STEPS_OF[kind](projectId));
  const rows = rowsOf<Row>(
    await db.execute(sql`
      with picked as (
        select s.trace_id, s.started_at, (count(*) over ())::int as matched
        from otel_trace_summaries s
        where s.project_id = ${projectId}
          and s.started_at >= ${scope.since.toISOString()}::timestamptz
          and s.started_at < ${scope.until.toISOString()}::timestamptz
          ${condition ? sql`and ${condition}` : sql``}
        order by s.started_at desc, s.trace_id
        limit ${cap}
      ),
      steps as (
        ${steps.length > 0 ? sql.join(steps, sql` union all `) : NO_STEPS}
      ),
      ranked as (
        select *, row_number() over (partition by trace_id order by at, tie, kind) as n from steps
      )
      select p.trace_id, p.started_at, p.matched,
        coalesce(
          jsonb_agg(jsonb_build_array(r.kind, r.name, r.failed, r.ms) order by r.n) filter (where r.n is not null),
          '[]'
        ) as steps
      from picked p
      left join ranked r on r.trace_id = p.trace_id and r.n <= ${STEPS_PER_TRACE}
      group by p.trace_id, p.started_at, p.matched
      order by p.started_at desc, p.trace_id`),
  );
  return {
    sample: { matched: Number(rows[0]?.matched ?? 0), read: rows.length },
    traces: rows.map((row) => ({
      traceId: row.trace_id,
      startedAt: new Date(row.started_at),
      steps: row.steps.map(([kind, name, failed, durationMs]) => ({
        kind,
        name,
        failed,
        durationMs,
      })),
    })),
  };
}

type Row = {
  trace_id: string;
  started_at: string | Date;
  matched: number | string;
  steps: [StepKind, string, boolean, number | null][];
};

const NO_STEPS = sql`select null::text as trace_id, null::timestamptz as at, null::text as tie,
  null::text as kind, null::text as name, null::boolean as failed, null::float8 as ms where false`;

const OUTCOME = sql`s.status_code = 2 as failed, s.duration_ms as ms`;

const STEPS_OF: Record<StepKind, (projectId: string) => SQL> = {
  // A framework's tool span around its own client span is one call.
  tool: (projectId) => sql`
    select s.trace_id, s.started_at as at, s.span_id as tie, 'tool' as kind, ${TOOL_NAME} as name,
      ${OUTCOME}
    from otel_spans s join picked p on p.trace_id = s.trace_id
    where s.project_id = ${projectId} and s.span_class = 'tool' and ${TOOL_NAME} <> ''
      and not exists (
        select 1 from otel_spans outer_span
        where outer_span.project_id = s.project_id and outer_span.trace_id = s.trace_id
          and outer_span.span_id = s.parent_span_id and outer_span.span_class = 'tool'
      )`,
  skill: (projectId) => sql`
    select s.trace_id, s.started_at as at, s.span_id as tie, 'skill' as kind,
      btrim(s.attributes ->> 'ratel.skill.name') as name, ${OUTCOME}
    from otel_spans s join picked p on p.trace_id = s.trace_id
    where s.project_id = ${projectId} and btrim(s.attributes ->> 'ratel.skill.name') <> ''
    union all
    select e.trace_id, coalesce(e.occurred_at, e.received_at), e.id::text, 'skill', btrim(e.skill_id),
      false, null::float8
    from trace_events e join picked p on p.trace_id = e.trace_id
    where e.project_id = ${projectId} and e.type = 'skill_invoke' and btrim(e.skill_id) <> ''`,
  agent: (projectId) => sql`
    select s.trace_id, s.started_at as at, s.span_id as tie, 'agent' as kind, s.agent_key as name,
      ${OUTCOME}
    from otel_spans s join picked p on p.trace_id = s.trace_id
    where s.project_id = ${projectId} and s.agent_key is not null`,
  // A client's span around the server's own is one call.
  mcp_server: (projectId) => sql`
    select s.trace_id, s.started_at as at, s.span_id as tie, 'mcp_server' as kind,
      s.mcp_server as name, ${OUTCOME}
    from otel_spans s join picked p on p.trace_id = s.trace_id
    where s.project_id = ${projectId} and s.mcp_server is not null
      and not exists (
        select 1 from otel_spans outer_span
        where outer_span.project_id = s.project_id and outer_span.trace_id = s.trace_id
          and outer_span.span_id = s.parent_span_id and outer_span.mcp_server is not null
      )`,
  // A framework's model span around the provider's own is one call.
  model: (projectId) => sql`
    select s.trace_id, s.started_at as at, s.span_id as tie, 'model' as kind,
      btrim(s.model) as name, ${OUTCOME}
    from otel_spans s join picked p on p.trace_id = s.trace_id
    where s.project_id = ${projectId} and s.span_class = 'llm_call' and btrim(s.model) <> ''
      and not exists (
        select 1 from otel_spans outer_span
        where outer_span.project_id = s.project_id and outer_span.trace_id = s.trace_id
          and outer_span.span_id = s.parent_span_id and outer_span.span_class = 'llm_call'
      )`,
};
