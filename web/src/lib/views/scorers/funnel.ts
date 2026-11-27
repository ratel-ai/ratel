import { sql } from "drizzle-orm";
import type { FunnelCondition, FunnelQuery } from "@/lib/contracts/query";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { type FunnelResult, funnelSteps, isUse } from "@/lib/synthesis/metrics/funnel";
import { type MetricsDb, rowsOf } from "@/lib/synthesis/metrics/query";
import { loadTraceSteps, TRACE_CAP } from "@/lib/synthesis/metrics/steps";
import { runCheck } from "./check";
import { loadScorerTraces } from "./traces";
import type { ScorerTrace, TraceScore } from "./types";

/** What a trace is held against, besides its steps. */
interface TraceFacts {
  trace: ScorerTrace | undefined;
  scores: ReadonlyMap<string, Pick<TraceScore, "value" | "passed">>;
}

/** A funnel over the newest matching traces, up to the cap. Attributes go through the check engine. */
export async function runFunnel(
  projectId: string,
  query: FunnelQuery,
  scope: QueryScope,
  db: MetricsDb,
  cap = TRACE_CAP,
): Promise<FunnelResult> {
  const conditions = query.steps.map(({ condition }) => condition);
  const kinds = [...new Set(conditions.filter(isUse).map(({ type }) => type))];
  const { sample, traces } = await loadTraceSteps(projectId, query.filters, scope, kinds, db, cap);
  const ids = traces.map(({ traceId }) => traceId);
  const readsTrace = conditions.some(({ type }) => type === "attribute" || type === "no_error");
  const read = readsTrace ? await loadScorerTraces(projectId, ids, db) : [];
  const byId = new Map(read.map((trace) => [trace.traceId, trace]));
  const scores = await loadScores(projectId, ids, scorerIds(conditions), db);
  return {
    kind: "funnel",
    sample,
    steps: funnelSteps(
      traces.map(({ traceId, steps }) => ({
        steps,
        holds: conditions.map((condition) =>
          holds(condition, { trace: byId.get(traceId), scores: scores.get(traceId) ?? new Map() }),
        ),
      })),
      query,
    ),
  };
}

/** Whether a condition holds for the trace as a whole. A value that is not there does not. */
function holds(condition: FunnelCondition, { trace, scores }: TraceFacts): boolean {
  switch (condition.type) {
    case "tool":
    case "skill":
      return false;
    case "no_error":
      return trace !== undefined && !trace.error;
    case "attribute": {
      if (!trace) return false;
      const outcome = runCheck(condition, trace);
      return outcome.status === "scored" && outcome.score.passed === true;
    }
    case "scorer": {
      const score = scores.get(condition.scorer.id);
      if (!score) return false;
      if (condition.result) return score.passed === (condition.result === "passed");
      return score.passed === null && score.value >= (condition.atLeast ?? 1);
    }
  }
}

function scorerIds(conditions: readonly FunnelCondition[]): string[] {
  return [
    ...new Set(
      conditions.flatMap((condition) => (condition.type === "scorer" ? [condition.scorer.id] : [])),
    ),
  ];
}

async function loadScores(
  projectId: string,
  traceIds: readonly string[],
  scorers: readonly string[],
  db: MetricsDb,
): Promise<Map<string, Map<string, Pick<TraceScore, "value" | "passed">>>> {
  const byTrace = new Map<string, Map<string, Pick<TraceScore, "value" | "passed">>>();
  if (traceIds.length === 0 || scorers.length === 0) return byTrace;
  const list = (items: readonly string[]) =>
    sql.join(
      items.map((item) => sql`${item}`),
      sql`, `,
    );
  const rows = rowsOf<{
    trace_id: string;
    scorer_id: string;
    value: number | string;
    passed: boolean | null;
  }>(
    await db.execute(sql`
      select r.trace_id, r.scorer_id, r.value, r.passed
      from trace_scores r
      where r.project_id = ${projectId} and r.scorer_id::text in (${list(scorers)})
        and r.trace_id in (${list(traceIds)})`),
  );
  for (const { trace_id, scorer_id, value, passed } of rows) {
    const scores = byTrace.get(trace_id) ?? new Map();
    byTrace.set(trace_id, scores.set(scorer_id, { value: Number(value), passed }));
  }
  return byTrace;
}
