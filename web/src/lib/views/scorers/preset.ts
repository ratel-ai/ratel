import { sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { type EvalDb, loadRuns } from "@/lib/views/eval-gate/runs";
import { recordedView } from "@/lib/views/eval-gate/simulate";
import { scoreRun } from "@/lib/views/task-scorers/engine";
import type { Scorer as TaskScorer } from "@/lib/views/task-scorers/types";
import { rowsOf } from "./traces";
import type { PresetConfig, ScoreOutcome, ScorerDefinition, ScorerTrace } from "./types";

const OTLP_KEY = "otlp:";

/**
 * Grade each trace with the closed run of these tasks that it belongs to, as `task-scorers/engine.ts`
 * grades that run. A run can span more than one trace: each of its traces gets the run's result. A
 * trace in no closed run of the tasks, or a run without the measurement, gets no result.
 */
export async function scorePresetTraces(
  projectId: string,
  config: PresetConfig,
  traces: readonly ScorerTrace[],
  taskIds: readonly string[],
  db: EvalDb = getDb(),
): Promise<ScoreOutcome[]> {
  const turnOf = await closedTurnsOf(
    projectId,
    traces.map((trace) => trace.traceId),
    taskIds,
    db,
  );
  const runs = await loadRuns(projectId, [...new Set(turnOf.values())], db);
  const scorer = taskScorerOf(config);
  const tool = config.preset === "expected_tool" ? config.tool : null;
  return traces.map((trace): ScoreOutcome => {
    const turnId = turnOf.get(trace.traceId);
    const run = turnId === undefined ? undefined : runs.get(turnId);
    if (!run) return { status: "skipped", reason: "no_run" };
    const [result] = scoreRun(recordedView(run, tool), [scorer]);
    if (!result || result.status === "skip") return { status: "skipped", reason: "not_measured" };
    return {
      status: "scored",
      score: { value: result.score, passed: result.status === "pass", confidence: null },
    };
  });
}

/** The task scorer a preset stands for. */
export function taskScorerOf(config: PresetConfig): TaskScorer {
  switch (config.preset) {
    case "ends_well":
      return { kind: config.preset };
    case "expected_tool":
      return { kind: config.preset, tool: config.tool };
    default:
      return { kind: config.preset, max: config.max };
  }
}

/** The scorer of the one model a task scorer becomes: `judge_criteria` is a pass-or-fail judge. */
export function definitionOf(scorer: TaskScorer): ScorerDefinition {
  switch (scorer.kind) {
    case "judge_criteria":
      return { kind: "judge", config: { prompt: scorer.criteria, output: "boolean" } };
    case "ends_well":
      return { kind: "preset", config: { preset: scorer.kind } };
    case "expected_tool":
      return { kind: "preset", config: { preset: scorer.kind, tool: scorer.tool } };
    default:
      return { kind: "preset", config: { preset: scorer.kind, max: scorer.max } };
  }
}

/**
 * The closed turn of these tasks each trace belongs to: by the turn's `otlp:<trace id>` key, or by
 * its steps' events, as `traces.ts#taskTraces` reads a task's traces. The earliest one wins.
 */
async function closedTurnsOf(
  projectId: string,
  traceIds: readonly string[],
  taskIds: readonly string[],
  db: Pick<EvalDb, "execute">,
): Promise<Map<string, string>> {
  if (traceIds.length === 0 || taskIds.length === 0) return new Map();
  const list = (values: readonly string[]) =>
    sql.join(
      values.map((value) => sql`${value}`),
      sql`, `,
    );
  const keys = traceIds.map((id) => `${OTLP_KEY}${id}`);
  const rows = rowsOf<{ trace_id: string; turn_id: string }>(
    await db.execute(sql`
      select distinct on (x.trace_id) x.trace_id, x.turn_id
      from (
        select substr(t.turn_key, ${OTLP_KEY.length + 1}) as trace_id, t.id as turn_id, t.started_at
        from trace_turns t
        where t.project_id = ${projectId} and t.status = 'closed'
          and t.workflow_id in (${list(taskIds)}) and t.turn_key in (${list(keys)})
        union all
        select e.trace_id, t.id as turn_id, t.started_at
        from trace_turns t
        join trace_turn_steps st on st.project_id = t.project_id and st.turn_id = t.id
        join trace_events e on e.project_id = st.project_id and e.id = st.trace_event_id
        where t.project_id = ${projectId} and t.status = 'closed'
          and t.workflow_id in (${list(taskIds)}) and e.trace_id in (${list(traceIds)})
      ) x
      order by x.trace_id, x.started_at, x.turn_id`),
  );
  return new Map(rows.map((row) => [row.trace_id, row.turn_id]));
}
