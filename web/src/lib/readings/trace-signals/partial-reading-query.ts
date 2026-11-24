import { sql } from "drizzle-orm";
import { andAnalyzedTrace } from "@/lib/platform/analysis-filter";
import { getDb } from "@/lib/platform/db/client";
import type {
  ModelFact,
  PartialFacts,
  StepFact,
} from "@/lib/readings/trace-signals/partial-reading";
import type { WindowDays } from "@/lib/readings/trace-signals/view";

/**
 * The spans behind a partial reading (`partial-reading.ts`): the runs (root
 * spans) that started in the window and every span under them. Raw SQL, as
 * the other span aggregates: one statement per part, each scoped to the
 * project and its window through the `(project_id, started_at)` root index.
 */

export type PartialFactsDb = Pick<ReturnType<typeof getDb>, "execute">;

/** OpenTelemetry's error status. */
const STATUS_ERROR = 2;
const DAY_MS = 24 * 60 * 60_000;
/** Steps listed; the rest are rare and the table is a summary. */
const STEP_LIMIT = 30;
const MODEL_LIMIT = 10;

export async function loadPartialFacts(
  projectId: string,
  options: { now: Date; windowDays: WindowDays },
  db: PartialFactsDb = getDb(),
): Promise<PartialFacts> {
  const since = new Date(options.now.getTime() - options.windowDays * DAY_MS).toISOString();
  const runs = sql`
    runs as (
      select trace_id, duration_ms, status_code from otel_spans
      where project_id = ${projectId} and parent_span_id is null and started_at >= ${since}
        ${andAnalyzedTrace(projectId, sql`otel_spans.trace_id`)}
    ),
    spans as (
      select s.* from otel_spans s join (select distinct trace_id from runs) r using (trace_id)
      where s.project_id = ${projectId} and s.parent_span_id is not null
    )`;
  const [totals, steps, models] = await Promise.all([
    db.execute(sql`with ${runs}
      select
        (select count(*)::int from runs) as runs,
        (select count(*)::int from runs r where r.status_code <> ${STATUS_ERROR} and not exists (
          select 1 from spans s where s.trace_id = r.trace_id and s.status_code = ${STATUS_ERROR})) as completed_runs,
        (select percentile_cont(0.95) within group (order by duration_ms) from runs) as p95_run_ms,
        count(*)::int as calls,
        count(*) filter (where status_code = ${STATUS_ERROR})::int as failed_calls,
        count(*) filter (where span_class = 'llm_call')::int as model_calls,
        sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0))
          filter (where span_class = 'llm_call' and (input_tokens is not null or output_tokens is not null))::float8 as tokens
      from spans`),
    db.execute(sql`with ${runs},
      parents as (select distinct trace_id, parent_span_id as span_id from spans)
      select s.name,
        count(*)::int as calls,
        count(*) filter (where s.status_code = ${STATUS_ERROR})::int as failed,
        count(*) filter (where p.span_id is null)::int as leaf_calls,
        percentile_cont(0.95) within group (order by s.duration_ms) as p95_ms
      from spans s left join parents p on p.trace_id = s.trace_id and p.span_id = s.span_id
      where s.span_class <> 'llm_call'
      group by s.name
      order by 2 desc, 1 asc
      limit ${STEP_LIMIT}`),
    db.execute(sql`with ${runs}
      select model,
        count(*)::int as calls,
        sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0))
          filter (where input_tokens is not null or output_tokens is not null)::float8 as tokens
      from spans
      where span_class = 'llm_call' and model is not null
      group by model
      order by 2 desc, 1 asc
      limit ${MODEL_LIMIT}`),
  ]);
  const t = totals.rows[0] as Record<string, unknown> | undefined;
  return {
    runs: int(t?.runs),
    completedRuns: int(t?.completed_runs),
    calls: int(t?.calls),
    failedCalls: int(t?.failed_calls),
    modelCalls: int(t?.model_calls),
    tokens: numOrNull(t?.tokens),
    p95RunMs: numOrNull(t?.p95_run_ms),
    steps: steps.rows.map(toStep),
    models: models.rows.map(toModel),
  };
}

function toStep(row: unknown): StepFact {
  const r = row as Record<string, unknown>;
  return {
    name: String(r.name),
    calls: int(r.calls),
    failed: int(r.failed),
    leafCalls: int(r.leaf_calls),
    p95Ms: numOrNull(r.p95_ms),
  };
}

function toModel(row: unknown): ModelFact {
  const r = row as Record<string, unknown>;
  return { model: String(r.model), calls: int(r.calls), tokens: numOrNull(r.tokens) };
}

function int(value: unknown): number {
  return numOrNull(value) ?? 0;
}

function numOrNull(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
