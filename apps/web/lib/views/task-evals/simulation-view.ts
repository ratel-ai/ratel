import { createHash } from "node:crypto";
import { parseChange } from "@/lib/views/eval-gate/change";
import { type ReplayPathsView, replayPathsOf } from "@/lib/views/eval-gate/replay-paths";
import { STALE_EVAL_RUN_MS } from "@/lib/views/eval-gate/store";
import type { CaseResult, FixChange } from "@/lib/views/eval-gate/types";
import type { TaskEvalCaseRow, TaskEvalRunRow } from "@/lib/views/task-evals/schema";
import { SCORER_VERSION } from "@/lib/views/task-scorers/engine";
import type { Scorer } from "@/lib/views/task-scorers/types";

export type TaskSimulationState = {
  state: "none" | "running" | "better" | "worse" | "same" | "unreliable";
  stale: boolean;
};

/** Compare against queued inputs, including edits made while a run was active. */
export function taskSimulationState(
  run: TaskEvalRunRow | null,
  inputKey: string,
  now = Date.now(),
): TaskSimulationState {
  if (!run) return { state: "none", stale: false };
  const stale = run.change?.inputKey !== inputKey || run.scorerVersion !== SCORER_VERSION;
  if (run.status === "queued" || run.status === "running") {
    return {
      state:
        now - (run.startedAt ?? run.createdAt).getTime() > STALE_EVAL_RUN_MS
          ? "unreliable"
          : "running",
      stale,
    };
  }
  const verdict = run.verdict;
  return {
    state:
      run.status === "completed" &&
      (verdict === "better" || verdict === "worse" || verdict === "same")
        ? verdict
        : "unreliable",
    stale,
  };
}

/** RC-76: one replayed run of a task simulation, as "What the replay did" lists it. */
export interface TaskReplayRun {
  id: string;
  turnId: string;
  runHref: string;
  label: string;
  paths: ReplayPathsView;
}

/** What the replay did for each replayed run of one simulation; empty when nothing was replayed. */
export function taskReplayRuns(
  run: Pick<TaskEvalRunRow, "results"> | null,
  projectId: string,
): TaskReplayRun[] {
  const results = (Array.isArray(run?.results) ? run.results : []) as unknown as CaseResult[];
  return results.flatMap((result) => {
    const paths = replayPathsOf(result);
    return paths
      ? [
          {
            id: result.caseId,
            turnId: result.turnId,
            paths,
            label: result.role === "evidence" ? "Fix-specific test" : "Task set",
            runHref: `/project/${encodeURIComponent(projectId)}/traces/turns/${encodeURIComponent(result.turnId)}`,
          },
        ]
      : [];
  });
}

/** Hash the effective change, active cases and scorer settings in a stable order. */
export function simulationInputKey(
  change: FixChange,
  cases: readonly TaskEvalCaseRow[],
  scorers: readonly Scorer[],
): string {
  return createHash("sha256")
    .update(
      stable({
        change: parseChange(change),
        scorerVersion: SCORER_VERSION,
        cases: cases
          .filter((item) => item.excludedAt === null)
          .map((item) => ({
            id: item.id,
            turnId: item.turnId,
            fixId: item.fixId,
            expected: item.expected,
            criteria: item.criteria,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        scorers: [...scorers].sort((a, b) => a.kind.localeCompare(b.kind)),
      }),
    )
    .digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
