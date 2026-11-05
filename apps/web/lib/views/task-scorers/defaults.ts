import { costLimit, latencyLimit } from "@/lib/views/task-scorers/outcome";
import type { Scorer } from "@/lib/views/task-scorers/types";

/** Median measurements from a task's own closed runs. Null means no measurement. */
export interface TaskStats {
  selfCorrections: number | null;
  costUsd: number | null;
  latencyMs: number | null;
}

/** Apply the outcome defaults' rounding and budget room to a task's measurements. */
export function defaultScorers(taskStats: TaskStats): Scorer[] {
  const scorers: Scorer[] = [{ kind: "ends_well" }];
  const corrections = taskStats.selfCorrections;
  if (corrections !== null && Number.isFinite(corrections) && corrections >= 0) {
    scorers.push({ kind: "max_self_corrections", max: Math.ceil(corrections) });
  }
  const cost = costLimit(taskStats.costUsd);
  if (cost !== null) scorers.push({ kind: "max_cost_usd", max: cost });
  const latency = latencyLimit(taskStats.latencyMs);
  if (latency !== null) scorers.push({ kind: "max_latency_ms", max: latency });
  return scorers;
}
