/**
 * An example run as a task's page draws it: the tools it called in order and
 * how it ended, read the way Self-corrections reads a run
 * (`lib/trace-signals/self-corrections/detect.ts`): the run gave up when its
 * last call failed and nothing ran after it; it recovered when a call failed
 * and a later one worked. Tool names and outcomes only. Pure.
 */

export interface ExampleStep {
  /** The called tool's catalog id (`skill:<id>` for a skill). */
  toolId: string;
  label: string;
  failed: boolean;
}

export type ExampleStatus = "worked" | "recovered" | "gave_up" | "failed";

export const EXAMPLE_STATUS_LABEL: Readonly<Record<ExampleStatus, string>> = {
  worked: "Worked",
  recovered: "Recovered",
  gave_up: "Gave up",
  // Only when the run's calls are no longer kept: a failure, without knowing how it ended.
  failed: "A call failed",
};

/** How a run ended, from its calls; without them, from its failure count alone. */
export function exampleStatus(
  steps: readonly Pick<ExampleStep, "failed">[],
  failures: number,
): ExampleStatus {
  if (steps.length === 0) return failures > 0 ? "failed" : "worked";
  if (steps[steps.length - 1]!.failed) return "gave_up";
  return steps.some((step) => step.failed) ? "recovered" : "worked";
}

/** A run's calls from its stored steps, in order: invocations with a target only (searches are not steps of a task). */
export function exampleSteps(
  rows: readonly {
    kind: string;
    targetType: string | null;
    targetId: string | null;
    outcome: string | null;
  }[],
  names: ReadonlyMap<string, string>,
): ExampleStep[] {
  return rows.flatMap((row) => {
    if (row.kind !== "invoke" || !row.targetId) return [];
    const toolId = row.targetType === "skill" ? `skill:${row.targetId}` : row.targetId;
    return [{ toolId, label: names.get(toolId) ?? toolId, failed: row.outcome === "error" }];
  });
}

/** A run of the same tool called again and again, one after another: one pin with its count. */
export interface ExampleStepGroup extends ExampleStep {
  /** Calls in the group (1 for a single call). */
  count: number;
  /** Of them, the ones that failed. */
  failures: number;
}

/** A run's calls with back-to-back repeats of one tool folded into one group, so a long run still reads as its shape. */
export function collapseRepeats(steps: readonly ExampleStep[]): ExampleStepGroup[] {
  return steps.reduce<ExampleStepGroup[]>((groups, step) => {
    const last = groups[groups.length - 1];
    if (last && last.toolId === step.toolId) {
      const merged = {
        ...last,
        count: last.count + 1,
        failures: last.failures + (step.failed ? 1 : 0),
        failed: last.failed || step.failed,
      };
      return [...groups.slice(0, -1), merged];
    }
    return [...groups, { ...step, count: 1, failures: step.failed ? 1 : 0 }];
  }, []);
}
