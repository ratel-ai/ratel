import {
  ERROR_KINDS,
  SELF_CORRECTION_KINDS,
  type SelfCorrectionKind,
} from "@/lib/readings/trace-signals/self-corrections/detect";
import { median, Reservoir } from "@/lib/readings/trace-signals/signals/severity";
import type {
  TurnCorrection,
  Workflow,
  WorkflowTurn,
} from "@/lib/readings/trace-signals/workflows/types";
import { toolCalls } from "@/lib/readings/trace-signals/workflows/units";

/**
 * One task read step by step, from the runs placed in it: what used to be
 * Tool craft's per-ask reading (transitions, reliability, timing, cost),
 * now per task, over the same runs Agent health counts. Pure; the signal run
 * stores it beside the task (`summary.workflows.items[].reading`).
 *
 * - A run finished when it called a tool and its last call did not fail:
 *   no `gave_up_after_error` (`self-corrections/detect.ts`, the one
 *   definition of a retry, a switch and a give-up). A run with no tool call
 *   did not finish.
 * - Per step (core tools in the task's order, then optional tools, then
 *   helpers): its runs and calls, the calls that failed, the retries,
 *   switches and give-ups after its failed calls, its typical time, the
 *   agent's typical wait after it (the hand-off to the next call), and what
 *   came next (the next tool, or the end of the run), repeats collapsed so a
 *   retry is one visit to the step.
 * - Cost only from runs linked to priced model calls; null when none was.
 */

export const TASK_READING_VERSION = 1;
/** Next steps kept per step, most common first. */
export const NEXT_SHOWN = 3;
/** Samples kept per step for its medians. */
const SAMPLES = 200;

export type TaskStepRole = "core" | "optional" | "helper";

export interface TaskStepNext {
  /** The next tool; null for the end of the run. */
  toolId: string | null;
  n: number;
  /** Of `nextOf`. */
  share: number;
}

export interface TaskStepReading {
  toolId: string;
  role: TaskStepRole;
  /** Runs that called it. */
  runs: number;
  calls: number;
  /** Calls that ended in an error. */
  failures: number;
  retries: number;
  switches: number;
  /** Runs that ended on its failed call. */
  gaveUp: number;
  medianMs: number | null;
  /** The agent's typical wait after it before the next call. */
  handoffMs: number | null;
  next: TaskStepNext[];
  /** Visits to the step (repeats collapsed): what `next` shares are of. */
  nextOf: number;
}

export type TaskCorrectionCounts = Record<SelfCorrectionKind, number>;

export interface TaskCost {
  /** Runs linked to model calls, and those whose model has a price. */
  linkedRuns: number;
  pricedRuns: number;
  totalUsd: number | null;
  medianUsd: number | null;
  medianModelCalls: number | null;
}

export interface TaskReading {
  version: typeof TASK_READING_VERSION;
  runs: number;
  finishedRuns: number;
  /** Runs with at least one failed call. */
  errorRuns: number;
  /** Of those, runs that still finished. */
  recoveredRuns: number;
  /** Tool calls, repeats included. */
  calls: number;
  steps: TaskStepReading[];
  /** Self-corrections read from the runs' steps (asked again and phrases are read elsewhere). */
  corrections: { runs: number; events: number; byKind: TaskCorrectionCounts };
  cost: TaskCost | null;
}

interface StepCount {
  toolId: string;
  role: TaskStepRole;
  runs: number;
  calls: number;
  failures: number;
  retries: number;
  switches: number;
  gaveUp: number;
  took: Reservoir<number>;
  handoff: Reservoir<number>;
  next: Map<string | null, number>;
  nextOf: number;
}

function newStep(toolId: string, role: TaskStepRole): StepCount {
  return {
    toolId,
    role,
    runs: 0,
    calls: 0,
    failures: 0,
    retries: 0,
    switches: 0,
    gaveUp: 0,
    took: new Reservoir<number>(SAMPLES, `took:${toolId}`),
    handoff: new Reservoir<number>(SAMPLES, `handoff:${toolId}`),
    next: new Map(),
    nextOf: 0,
  };
}

function stepCounts(
  task: Pick<Workflow, "typicalOrder" | "optionalTools" | "helperTools">,
): Map<string, StepCount> {
  const steps = new Map<string, StepCount>();
  const add = (ids: readonly string[], role: TaskStepRole) => {
    for (const id of ids) if (!steps.has(id)) steps.set(id, newStep(id, role));
  };
  add(task.typicalOrder, "core");
  add(task.optionalTools, "optional");
  add(task.helperTools, "helper");
  return steps;
}

const emptyKinds = (): TaskCorrectionCounts =>
  Object.fromEntries(SELF_CORRECTION_KINDS.map((kind) => [kind, 0])) as TaskCorrectionCounts;

function collapse(ids: readonly string[]): string[] {
  return ids.filter((id, i) => i === 0 || ids[i - 1] !== id);
}

function countCalls(steps: ReadonlyMap<string, StepCount>, run: WorkflowTurn): void {
  const calls = toolCalls(run);
  for (const call of calls) {
    const step = steps.get(call.targetId);
    if (!step) continue;
    step.calls += 1;
    if (call.outcome === "error") step.failures += 1;
    if (typeof call.tookMs === "number") step.took.add(call.tookMs);
    if (typeof call.handoffMs === "number") step.handoff.add(call.handoffMs);
  }
  for (const id of new Set(calls.map((call) => call.targetId))) {
    const step = steps.get(id);
    if (step) step.runs += 1;
  }
  const visits = collapse(calls.map((call) => call.targetId));
  visits.forEach((id, i) => {
    const step = steps.get(id);
    if (!step) return;
    const next = visits[i + 1] ?? null;
    step.nextOf += 1;
    step.next.set(next, (step.next.get(next) ?? 0) + 1);
  });
}

function countCorrections(
  steps: ReadonlyMap<string, StepCount>,
  corrections: readonly TurnCorrection[],
): void {
  for (const event of corrections) {
    const step = event.tool === null ? undefined : steps.get(event.tool);
    if (!step) continue;
    if (event.kind === "retry_after_error") step.retries += 1;
    else if (event.kind === "switch_after_error") step.switches += 1;
    else if (event.kind === "gave_up_after_error") step.gaveUp += 1;
  }
}

const byNext = ([a, x]: [string | null, number], [b, y]: [string | null, number]): number =>
  y - x || (a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0);

function finishStep(step: StepCount): TaskStepReading {
  return {
    toolId: step.toolId,
    role: step.role,
    runs: step.runs,
    calls: step.calls,
    failures: step.failures,
    retries: step.retries,
    switches: step.switches,
    gaveUp: step.gaveUp,
    medianMs: median(step.took.values()),
    handoffMs: median(step.handoff.values()),
    next: [...step.next]
      .sort(byNext)
      .slice(0, NEXT_SHOWN)
      .map(([toolId, n]) => ({ toolId, n, share: step.nextOf > 0 ? n / step.nextOf : 0 })),
    nextOf: step.nextOf,
  };
}

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

function costOf(runs: readonly WorkflowTurn[]): TaskCost | null {
  const models = runs.flatMap((run) => (run.model ? [run.model] : []));
  if (models.length === 0) return null;
  const priced = models.flatMap((model) => (model.costUsd === null ? [] : [model.costUsd]));
  const medianUsd = median(priced);
  return {
    linkedRuns: models.length,
    pricedRuns: priced.length,
    totalUsd: priced.length > 0 ? round6(priced.reduce((sum, usd) => sum + usd, 0)) : null,
    medianUsd: medianUsd === null ? null : round6(medianUsd),
    medianModelCalls: median(models.map((model) => model.calls)),
  };
}

interface RunOutcome {
  finished: boolean;
  errored: boolean;
}

function outcomeOf(run: WorkflowTurn): RunOutcome {
  const calls = toolCalls(run);
  const corrections = run.corrections ?? [];
  const last = calls[calls.length - 1];
  const gaveUp = corrections.some((event) => event.kind === "gave_up_after_error");
  const finished = last !== undefined && last.outcome !== "error" && !gaveUp;
  const errored =
    calls.some((call) => call.outcome === "error") ||
    corrections.some((event) => ERROR_KINDS.has(event.kind));
  return { finished, errored };
}

export function readTask(
  task: Pick<Workflow, "typicalOrder" | "optionalTools" | "helperTools">,
  runs: readonly WorkflowTurn[],
): TaskReading {
  const steps = stepCounts(task);
  const byKind = emptyKinds();
  let finishedRuns = 0;
  let errorRuns = 0;
  let recoveredRuns = 0;
  let calls = 0;
  let correctionRuns = 0;
  let events = 0;
  for (const run of runs) {
    countCalls(steps, run);
    const corrections = run.corrections ?? [];
    countCorrections(steps, corrections);
    for (const event of corrections) byKind[event.kind] += 1;
    events += corrections.length;
    if (corrections.length > 0) correctionRuns += 1;
    calls += toolCalls(run).length;
    const outcome = outcomeOf(run);
    if (outcome.finished) finishedRuns += 1;
    if (outcome.errored) errorRuns += 1;
    if (outcome.errored && outcome.finished) recoveredRuns += 1;
  }
  return {
    version: TASK_READING_VERSION,
    runs: runs.length,
    finishedRuns,
    errorRuns,
    recoveredRuns,
    calls,
    steps: [...steps.values()].map(finishStep),
    corrections: { runs: correctionRuns, events, byKind },
    cost: costOf(runs),
  };
}
