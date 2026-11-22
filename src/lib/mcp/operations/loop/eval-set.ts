import { getDb } from "@/lib/platform/db/client";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-store";
import type { SimulationRow } from "@/lib/views/evals/domain/simulation";
import type { EvalResult, EvalRun } from "@/lib/views/evals/domain/types";
import { simulationRows } from "@/lib/views/evals/simulation";

/**
 * RC-626: the fix's newest eval-set simulation (`simulate_eval_set`, the
 * agent-wide evals) as `get_eval` returns it. Each eval result names the spec
 * inputs a model wrote that it used (RC-609 `generated`, absent when none) and
 * the tool answers a stand-in model wrote.
 */

export interface EvalSetSimulation {
  run: Pick<EvalRun, "id" | "status">;
  rows: readonly Pick<SimulationRow, "evalId" | "before" | "after" | "outcome">[];
  /** Eval names by id. */
  names: ReadonlyMap<string, string>;
}

/** The fix's newest eval-set simulation with its results; null when it has none. */
export async function latestEvalSetSimulation(
  projectId: string,
  fixId: string,
  db: ReturnType<typeof getDb> = getDb(),
): Promise<EvalSetSimulation | null> {
  const store = createDrizzleEvalStore(db);
  const [run] = await store.listRuns(projectId, { kinds: ["simulation"], fixId, limit: 1 });
  if (!run) return null;
  const read = await simulationRows(projectId, run.id, db);
  if (!read) return null;
  const wanted = new Set(read.rows.map((row) => row.evalId));
  const names = new Map(
    (await store.listEvals(projectId))
      .filter((item) => wanted.has(item.id))
      .map((item) => [item.id, item.name]),
  );
  return { run: { id: run.id, status: run.status }, rows: read.rows, names };
}

/** One entry per eval result (each side), in the simulation's order. */
export function evalSetData(set: EvalSetSimulation) {
  return {
    runId: set.run.id,
    status: set.run.status,
    results: set.rows.flatMap((row) =>
      [row.before, row.after].flatMap((result) =>
        result ? [resultData(row, result, set.names)] : [],
      ),
    ),
  };
}

function resultData(
  row: Pick<SimulationRow, "evalId" | "outcome">,
  result: EvalResult,
  names: ReadonlyMap<string, string>,
) {
  const standIns = result.toolAnswers
    .filter((answer) => answer.source === "stand-in")
    .map((answer) => answer.tool);
  return {
    evalId: row.evalId,
    name: names.get(row.evalId) ?? null,
    side: result.side,
    outcome: row.outcome,
    passed: result.passed,
    error: result.error,
    standIns: { count: standIns.length, tools: standIns },
    ...(result.generated && result.generated.length > 0 ? { generated: result.generated } : {}),
  };
}
