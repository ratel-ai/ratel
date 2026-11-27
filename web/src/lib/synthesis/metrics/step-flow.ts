import { sql } from "drizzle-orm";
import { STEP_FLOW_LIMITS, type StepFlowQuery } from "@/lib/contracts/query";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { type MetricsDb, rowsOf } from "@/lib/synthesis/metrics/query";
import {
  compare,
  foldStepFlow,
  NO_GROUP,
  type StepFlowColumn,
  type StepFlowLink,
  type StepFlowPath,
  type StepFlowPaths,
} from "@/lib/synthesis/metrics/step-flow-columns";
import {
  loadTraceSteps,
  type SteppedTrace,
  TRACE_CAP,
  type TraceSample,
  type TraceStep,
} from "@/lib/synthesis/metrics/steps";

/** The step flow kind: what traces do step by step, forward from the start or back from one node. */

/** What is wrong with a node at a step, over the traces that were read. */
export interface StepFlowMark {
  step: number;
  name: string;
  errors: boolean;
  slow: boolean;
}

export interface StepFlowResult extends StepFlowPaths {
  kind: "step_flow";
  /** Traces on the flow. In mode before, the ones that reached the target. */
  total: number;
  columns: StepFlowColumn[];
  /** By column, the most traces first. */
  links: StepFlowLink[];
  /** The nodes with something to mark. */
  marks: StepFlowMark[];
  sample: TraceSample;
}

/** A node is marked for errors over this many failed visits and this share of them. */
export const ERROR_MARK = { visits: 3, share: 0.2 } as const;
/** A node is marked slow when its p95 is over both. As the Health page's slow tools. */
export const SLOW_MARK = { visits: 5, ms: 10_000, ofMedian: 5 } as const;

/** A turn may start a little away from the trace it belongs to. */
const PLACED_SLACK_MS = 86_400_000;

export async function runStepFlow(
  projectId: string,
  query: StepFlowQuery,
  scope: QueryScope,
  db: MetricsDb,
  cap = TRACE_CAP,
): Promise<StepFlowResult> {
  const { sample, traces } = await loadTraceSteps(
    projectId,
    query.filters,
    scope,
    [query.node],
    db,
    cap,
  );
  const starts = await loadStarts(projectId, query.start, traces, scope, db);
  const { paths, marks } = stepPaths(traces, starts, query);
  const { total, columns, links } = foldStepFlow(paths, query);
  return { kind: "step_flow", total, columns, links, ...paths, marks, sample };
}

/** Pure: every trace's path, the same ones counted together, and the marks of its nodes. */
export function stepPaths(
  traces: readonly Pick<SteppedTrace, "traceId" | "steps">[],
  starts: ReadonlyMap<string, string>,
  { node, start, mode, target }: Pick<StepFlowQuery, "node" | "start" | "mode" | "target">,
): { paths: StepFlowPaths; marks: StepFlowMark[] } {
  const { max } = STEP_FLOW_LIMITS.steps;
  const names: string[] = [];
  const indexes = new Map<string, number>();
  const indexOf = (name: string) => {
    const known = indexes.get(name);
    if (known !== undefined) return known;
    indexes.set(name, names.length);
    return names.push(name) - 1;
  };
  const counted = new Map<string, StepFlowPath>();
  const visits = new Map<string, Visits>();
  const durations: number[] = [];
  for (const { traceId, steps: all } of traces) {
    let steps = visitsOf(all.filter(({ kind }) => kind === node));
    if (mode === "before") {
      const at = steps.findIndex(({ name }) => name === target);
      if (at < 0) continue;
      steps = steps.slice(0, at).reverse();
    }
    const kept = steps.slice(0, max);
    for (const [at, { name, failed, durationMs }] of kept.entries()) {
      const key = JSON.stringify([at + 1, name]);
      const visit = visits.get(key) ?? { step: at + 1, name, count: 0, failed: 0, ms: [] };
      visit.count += 1;
      if (failed) visit.failed += 1;
      if (typeof durationMs === "number") {
        visit.ms.push(durationMs);
        durations.push(durationMs);
      }
      visits.set(key, visit);
    }
    const path = {
      start: indexOf(starts.get(traceId) ?? NO_GROUP[start]),
      steps: kept.map(({ name }) => indexOf(name)),
      more: steps.length > max,
    };
    const key = JSON.stringify(path);
    const same = counted.get(key);
    if (same) same.count += 1;
    else counted.set(key, { ...path, count: 1 });
  }
  return {
    paths: { names, paths: [...counted.values()].sort((a, b) => b.count - a.count) },
    marks: marksOf([...visits.values()], quantile(durations, 0.5)),
  };
}

interface Visits {
  step: number;
  name: string;
  count: number;
  failed: number;
  ms: number[];
}

/** Every span of an agent or a skill names it: staying there is one visit. A second call is two. */
function visitsOf(steps: readonly TraceStep[]): TraceStep[] {
  const visits: TraceStep[] = [];
  for (const step of steps) {
    const last = visits[visits.length - 1];
    const stays = (step.kind === "agent" || step.kind === "skill") && last?.name === step.name;
    if (!stays) visits.push({ ...step });
    else if (step.failed) last.failed = true;
  }
  return visits;
}

function marksOf(visits: readonly Visits[], median: number): StepFlowMark[] {
  const bar = Math.max(SLOW_MARK.ms, SLOW_MARK.ofMedian * median);
  return visits
    .map(({ step, name, count, failed, ms }) => ({
      step,
      name,
      errors: failed >= ERROR_MARK.visits && failed >= ERROR_MARK.share * count,
      slow: ms.length >= SLOW_MARK.visits && quantile(ms, 0.95) > bar,
    }))
    .filter(({ errors, slow }) => errors || slow)
    .sort((a, b) => a.step - b.step || compare(a.name, b.name));
}

function quantile(values: readonly number[], q: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/** What each trace starts from, where it has one. */
async function loadStarts(
  projectId: string,
  start: StepFlowQuery["start"],
  traces: readonly Pick<SteppedTrace, "traceId">[],
  { since, until }: QueryScope,
  db: MetricsDb,
): Promise<Map<string, string>> {
  if (start === "none" || traces.length === 0) return new Map();
  const wanted = sql`select jsonb_array_elements_text(
    ${JSON.stringify(traces.map(({ traceId }) => traceId))}::jsonb) as trace_id`;
  // A trace's intent is the one the topics job placed its first placed turn in. A turn's trace is
  // its `otlp:` key, or one its steps' events carry (as in `views/scorers/traces`).
  const from = new Date(since.getTime() - PLACED_SLACK_MS).toISOString();
  const to = new Date(until.getTime() + PLACED_SLACK_MS).toISOString();
  const rows = rowsOf<{ trace_id: string; name: string }>(
    await db.execute(
      start === "agent"
        ? sql`
      with wanted as (${wanted})
      select distinct on (s.trace_id) s.trace_id, s.agent_key as name
      from wanted w join otel_spans s on s.project_id = ${projectId} and s.trace_id = w.trace_id
      where s.agent_key is not null
      order by s.trace_id, s.started_at, s.span_id`
        : sql`
      with wanted as (${wanted}),
      placed as (
        select tt.turn_id, tt.topic_id, tt.started_at from trace_turn_topics tt
        where tt.project_id = ${projectId} and tt.verdict = 'topic'
          and tt.started_at >= ${from}::timestamptz and tt.started_at < ${to}::timestamptz
      ),
      traced as (
        select substr(t.turn_key, 6) as trace_id, p.* from placed p
        join trace_turns t on t.id = p.turn_id and t.turn_key like 'otlp:%'
        union all
        select e.trace_id, p.* from placed p
        join trace_turn_steps st on st.turn_id = p.turn_id
        join trace_events e on e.project_id = ${projectId} and e.id = st.trace_event_id
        where e.trace_id is not null
      )
      select distinct on (x.trace_id) x.trace_id, topic.name
      from wanted w join traced x on x.trace_id = w.trace_id
      join trace_topics topic on topic.project_id = ${projectId} and topic.topic_id = x.topic_id
      order by x.trace_id, x.started_at, x.topic_id`,
    ),
  );
  return new Map(rows.map(({ trace_id, name }) => [trace_id, name]));
}
