import type { StepDraft } from "@/lib/ledger/types";
import { envNumber } from "@/lib/platform/env-number";
import { MAX_HANDOFF_MS } from "@/lib/readings/tool-explorer/timing";
import { cutTurn } from "@/lib/readings/trace-signals/segments/pieces";
import type { SegmentPlacement } from "@/lib/readings/trace-signals/segments/write";
import { detectInTurn } from "@/lib/readings/trace-signals/self-corrections/detect";
import { DEFAULT_FLOORS, type Floors } from "@/lib/readings/trace-signals/signals/catalog";
import { linkedRunMs } from "@/lib/readings/trace-signals/signals/linked-runs";
import type { DetectedSignal, SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import {
  type StoredWorkflows,
  storedWorkflow,
  storedWorkflows,
} from "@/lib/readings/trace-signals/signals/workflow-stored";
import type { SignalKind } from "@/lib/readings/trace-signals/view";
import {
  agentWorkflows,
  compactAgentRun,
} from "@/lib/readings/trace-signals/workflows/agent-tasks";
import { matchPrevious } from "@/lib/readings/trace-signals/workflows/assign";
import {
  detectWorkflowSignals,
  type WorkflowThresholds,
  type WorkflowWithHealth,
} from "@/lib/readings/trace-signals/workflows/detect";
import { workflowHealth } from "@/lib/readings/trace-signals/workflows/health";
import { mineWorkflows } from "@/lib/readings/trace-signals/workflows/mine";
import {
  membersByTask,
  placeRuns,
  reshapeWorkflow,
} from "@/lib/readings/trace-signals/workflows/place";
import { readTask, type TaskReading } from "@/lib/readings/trace-signals/workflows/reading";
import {
  chooseRunBasis,
  countRun,
  emptyRunBasisCounts,
  minesRun,
  type RunBasis,
} from "@/lib/readings/trace-signals/workflows/run-basis";
import type {
  TurnCorrection,
  Workflow,
  WorkflowConfig,
  WorkflowCore,
  WorkflowSignal,
  WorkflowStep,
  WorkflowTurn,
} from "@/lib/readings/trace-signals/workflows/types";
import { DEFAULT_WORKFLOW_CONFIG } from "@/lib/readings/trace-signals/workflows/types";
import {
  isToolCall,
  stepToken,
  turnUnit,
  type UnitOptions,
} from "@/lib/readings/trace-signals/workflows/units";

/**
 * Workflows (tasks, in the product) inside a signal run. Pass one hands every
 * in-window turn to `collect`, which keeps a compact copy of the turns that
 * called a tool (only the fields mining, health and the task reading need,
 * tool calls only, each with the agent's wait after it, plus the run's
 * self-corrections). `finish` mines them, carries last run's ids over to
 * workflows whose core only drifted, places every run in one task
 * (`workflows/place.ts`), reads each task again from its runs (shape, health,
 * steps) and runs the workflow detectors. The placement goes back to the job,
 * which writes it to `trace_turns.workflow_id`.
 *
 * Memory is bounded by `maxTurns` compact turns: past it, collection stops
 * and the stored result says it was truncated. Every run is counted for the
 * basis (`run-basis.ts`): which runs are clean enough to mine, and whether
 * workflows are hidden because no tool was called or runs are mixed together.
 *
 * With `agentTasks` on (RC-747, `cloud-tool-run-insights`), a run that called
 * no tool but ran as a named agent is kept too, and the runs of one agent form
 * one task (`workflows/agent-tasks.ts`); such runs also lift the "no tool
 * calls" block. Off, they are skipped as before.
 *
 * With `typedSteps` on (RC-1072, `cloud-typed-steps`), the compact copy keeps
 * every step with a token (`workflows/units.ts`), so a run of model calls is
 * mined, placed and read on its signature; such runs lift the "no tool calls"
 * block too. Tool-only runs read as before.
 */

/** Compact turns one run keeps for mining at most. */
export const MAX_WORKFLOW_TURNS = Math.floor(
  envNumber("TRACE_SIGNALS_MAX_WORKFLOW_TURNS", 100_000),
);

export const WORKFLOW_SIGNAL_KINDS = [
  "workflow_failing",
  "workflow_slow",
  "workflow_fixed_chain",
] as const satisfies readonly SignalKind[];

export interface WorkflowRunResult {
  stored: StoredWorkflows;
  signals: DetectedSignal[];
  /** The workflow kinds, once at least one multi-tool turn was collected; else none. */
  measured: Set<SignalKind>;
  /**
   * Each collected run's task id, or null (`placeRuns`): every in-window run
   * that called a tool, and with `agentTasks` every tool-less agent run, until
   * the turn cap. Runs absent from it (no tool call, not read by the basis,
   * past the cap) belong to no task.
   */
  placement: ReadonlyMap<string, string | null>;
  segmentPlacement?: SegmentPlacement;
  /**
   * Tool-less agent runs kept (RC-747); always 0 without `agentTasks`. Their
   * tasks are not counted in `stored.turnsWithTools`, so the run stores its
   * reading for them too (RC-805).
   */
  agentRuns: number;
}

export interface WorkflowCollector {
  collect(turn: SignalTurn): void;
  finish(previous: readonly WorkflowCore[]): WorkflowRunResult;
}

/** The detector thresholds under a set of (env-resolved) floors. */
export function workflowThresholds(floors: Floors): WorkflowThresholds {
  return {
    failing: { ...floors.workflow_failing },
    slow: { ...floors.workflow_slow },
    fixedChain: { ...floors.workflow_fixed_chain },
  };
}

function endOf(step: StepDraft): number | null {
  if (step.endOccurredAt) return step.endOccurredAt.getTime();
  return step.tookMs === null ? null : step.occurredAt.getTime() + step.tookMs;
}

/**
 * The agent's wait between a call's end and the next call's start (a tool or
 * a skill; searches in between count as waiting), the hand-off of
 * `tool-explorer/timing.ts`: null when either end is unknown, negative, or
 * past `MAX_HANDOFF_MS` (the user walking away).
 */
function handoffAfter(steps: readonly StepDraft[], index: number): number | null {
  const end = endOf(steps[index]!);
  if (end === null) return null;
  const next = steps
    .slice(index + 1)
    .find((step) => step.kind === "invoke" && step.targetId !== null);
  if (!next) return null;
  const wait = next.occurredAt.getTime() - end;
  return wait >= 0 && wait <= MAX_HANDOFF_MS ? wait : null;
}

/** The run's self-corrections as a task reads them, from its full steps (`self-corrections/detect.ts`). */
function correctionsOf(steps: readonly StepDraft[]): TurnCorrection[] {
  return detectInTurn(steps).map((event) => ({
    kind: event.kind,
    tool: event.tool,
    recovered: event.recovered,
  }));
}

/**
 * The turn as mining and the task reading read it, tool calls only (with
 * `typedSteps`, every step with a token); null when it has none.
 */
export function compactTurn(turn: SignalTurn, options: UnitOptions = {}): WorkflowTurn | null {
  const kept = options.typedSteps ? (step: StepDraft) => stepToken(step) !== null : isToolCall;
  const steps: WorkflowStep[] = turn.steps.flatMap((step, index) =>
    kept(step)
      ? [
          {
            kind: step.kind,
            targetType: step.targetType,
            targetId: step.targetId,
            outcome: step.outcome,
            tookMs: step.tookMs,
            traceEventId: step.traceEventId,
            handoffMs: handoffAfter(turn.steps, index),
          },
        ]
      : [],
  );
  if (steps.length === 0) return null;
  const linked = turn.linked;
  const model = linked
    ? {
        calls: linked.modelCalls,
        costUsd: linked.costUsd,
        modelMs: linked.modelMs,
        runMs: linkedRunMs(turn, linked),
        tokens: linked.inputTokens + linked.outputTokens,
      }
    : null;
  const corrections = correctionsOf(turn.steps);
  return {
    id: turn.id,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    turnSource: turn.turnSource,
    steps,
    ...(model ? { model } : {}),
    ...(corrections.length > 0 ? { corrections } : {}),
  };
}

/**
 * This run's id per mined fingerprint: last run's id where `matchPrevious`
 * pairs them, else the fingerprint. A fresh fingerprint that equals an id
 * carried over to another workflow gets a numbered suffix, so ids stay unique.
 */
export function carryWorkflowIds(
  current: readonly WorkflowCore[],
  previous: readonly WorkflowCore[],
): Map<string, string> {
  const matched = matchPrevious(current, previous);
  const taken = new Set(matched.values());
  const out = new Map<string, string>();
  for (const workflow of current) {
    const carried = matched.get(workflow.id);
    const id = carried ?? freeId(workflow.id, taken);
    taken.add(id);
    out.set(workflow.id, id);
  }
  return out;
}

/** `base`, or `base-2`, `base-3`... whichever is not taken yet. */
function freeId(base: string, taken: ReadonlySet<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

interface PlacedEntry extends WorkflowWithHealth {
  /** This run's fingerprint of the core (the id unless it was carried over). */
  fingerprint: string;
  reading: TaskReading;
}

/**
 * Each mined workflow read from the runs placed in it, most runs first. A
 * workflow no run was placed in (every run of it held a heavier core) is
 * dropped: a task with no runs says nothing.
 */
function placedEntries(
  carried: readonly Workflow[],
  mined: readonly Workflow[],
  placement: ReadonlyMap<string, string | null>,
  turns: readonly WorkflowTurn[],
  ctx: { ubiquitous: ReadonlySet<string>; turnsWithTools: number },
  options: UnitOptions = {},
): PlacedEntry[] {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const members = membersByTask(placement);
  return carried
    .flatMap((workflow, i): PlacedEntry[] => {
      const runs = (members.get(workflow.id) ?? []).flatMap((id) => {
        const turn = byId.get(id);
        return turn ? [turn] : [];
      });
      if (runs.length === 0) return [];
      const shaped = reshapeWorkflow(
        workflow,
        runs.map((run) => turnUnit(run, options)),
        ctx,
      );
      const health = workflowHealth(shaped, byId, undefined, options);
      return [
        {
          workflow: shaped,
          health,
          reading: readTask(shaped, runs, options),
          fingerprint: mined[i]!.id,
        },
      ];
    })
    .sort(mostRunsFirst);
}

function mostRunsFirst(a: PlacedEntry, b: PlacedEntry): number {
  return (
    b.workflow.runs - a.workflow.runs ||
    (a.workflow.id < b.workflow.id ? -1 : a.workflow.id > b.workflow.id ? 1 : 0)
  );
}

function toDetected(signal: WorkflowSignal, entry: WorkflowWithHealth | undefined): DetectedSignal {
  const detail = entry
    ? { coreTools: [...entry.workflow.coreTools], typicalOrder: [...entry.workflow.typicalOrder] }
    : undefined;
  return { ...signal, ...(detail ? { subjectDetail: detail } : {}) };
}

export function createWorkflowCollector(
  maxTurns: number = MAX_WORKFLOW_TURNS,
  floors: Floors = DEFAULT_FLOORS,
  /** Decided before the reading from the window's run counts; absent, decided here from the runs collected. */
  fixedBasis?: RunBasis,
  /** Mining tunables over the defaults (RC-725, `cloud-tool-run-insights`); absent, the defaults. */
  mining: Partial<WorkflowConfig> = {},
): WorkflowCollector {
  const turns: WorkflowTurn[] = [];
  const agentRuns: WorkflowTurn[] = [];
  const counts = emptyRunBasisCounts();
  const units: UnitOptions = { typedSteps: mining.typedSteps ?? false };
  const parents = new Map<string, string>();
  let capped = false;
  let typedRuns = 0;
  return {
    collect(turn) {
      const candidates = units.typedSteps
        ? cutTurn(turn).map((piece) => ({
            ...turn,
            id: piece.id,
            startedAt: piece.startedAt,
            endedAt: piece.endedAt,
            steps: [...piece.steps],
          }))
        : [turn];
      for (const candidate of candidates) {
        const compact = compactTurn(candidate, units);
        const unit = compact ? turnUnit(compact, units) : null;
        countRun(counts, candidate, unit ? unit.tools.length : 0);
        const agentRun = !compact && mining.agentTasks ? compactAgentRun(candidate) : null;
        if (capped || !(compact || agentRun)) continue;
        if (turns.length + agentRuns.length >= maxTurns) capped = true;
        else {
          parents.set(candidate.id, turn.id);
          if (compact) {
            turns.push(compact);
            if (unit && unit.nonTools.length > 0) typedRuns += 1;
          } else if (agentRun) agentRuns.push(agentRun);
        }
      }
    },
    finish(previous) {
      const basis = liftedByToollessRuns(
        fixedBasis ?? chooseRunBasis(counts),
        agentRuns.length + typedRuns,
      );
      const mined = mineWorkflows(
        turns.filter((turn) => minesRun(basis.basis, turn.turnSource)),
        mining,
      );
      const agents = agentWorkflows(
        agentRuns.filter((run) => minesRun(basis.basis, run.turnSource)),
        mining.minSupport ?? DEFAULT_WORKFLOW_CONFIG.minSupport,
      );
      const all = [...mined.workflows, ...agents.workflows];
      const ids = carryWorkflowIds(all, previous);
      const carried = all.map((workflow) => ({
        ...workflow,
        id: ids.get(workflow.id) ?? workflow.id,
      }));
      const toolTasks = carried.slice(0, mined.workflows.length);
      const agentTasks = carried.slice(mined.workflows.length);
      const placement = placeRuns(turns, toolTasks, {
        weights: mined.idf,
        basis: basis.basis,
        ...units,
      });
      placeAgentRuns(placement, agentRuns, agentTasks, basis.basis);
      const entries = [
        ...placedEntries(
          toolTasks,
          mined.workflows,
          placement,
          turns,
          {
            ubiquitous: new Set(mined.ubiquitousTools),
            turnsWithTools: mined.turnsWithTools,
          },
          units,
        ),
        ...placedEntries(agentTasks, agents.workflows, placement, agentRuns, {
          ubiquitous: new Set(),
          turnsWithTools: agents.runs,
        }),
      ].sort(mostRunsFirst);
      if (units.typedSteps) {
        for (const entry of entries) {
          for (const examples of [
            entry.health.failedExamples,
            entry.health.slowExamples,
            entry.health.recentExamples,
          ]) {
            for (const example of examples)
              example.turnId = parents.get(example.turnId) ?? example.turnId;
          }
        }
      }
      const byKey = new Map(entries.map((entry) => [entry.workflow.id, entry]));
      const signals = detectWorkflowSignals(entries, workflowThresholds(floors)).map((s) =>
        toDetected(s, byKey.get(s.subjectKey)),
      );
      const items = entries.map((entry) =>
        storedWorkflow(entry.workflow, entry.fingerprint, entry.health, entry.reading),
      );
      const placed = entries.reduce((sum, entry) => sum + entry.workflow.runs, 0);
      return {
        stored: storedWorkflows({ ...mined, assignedTurns: placed }, items, capped, basis),
        signals,
        measured: new Set<SignalKind>(
          mined.multiToolTurns > 0 || agents.workflows.length > 0 ? WORKFLOW_SIGNAL_KINDS : [],
        ),
        placement: units.typedSteps ? firstTaskPerTurn(placement, parents) : placement,
        ...(units.typedSteps
          ? { segmentPlacement: { tasks: carried, weights: mined.idf, basis: basis.basis } }
          : {}),
        agentRuns: agentRuns.length,
      };
    },
  };
}

/**
 * The basis, with the "no tool calls" block lifted when runs without a tool
 * call were kept: tool-less agent runs (RC-747), or runs with a step token
 * (`typedSteps`, RC-1072). They are what the tasks are read from.
 */
function liftedByToollessRuns(basis: RunBasis, runs: number): RunBasis {
  return basis.blocked === "no_tool_calls" && runs > 0
    ? { ...basis, basis: "all", blocked: null }
    : basis;
}

/** Each agent run in its agent's task, or none (under the floor, or not read by the basis). */
function placeAgentRuns(
  placement: Map<string, string | null>,
  runs: readonly WorkflowTurn[],
  tasks: readonly Workflow[],
  basis: RunBasis["basis"],
): void {
  const byStep = new Map(tasks.map((task) => [task.coreTools[0], task.id]));
  for (const run of runs) {
    const step = run.steps[0]?.targetId;
    placement.set(
      run.id,
      step && minesRun(basis, run.turnSource) ? (byStep.get(step) ?? null) : null,
    );
  }
}

/** Keep the first placed piece as the legacy turn pointer. */
function firstTaskPerTurn(
  placement: ReadonlyMap<string, string | null>,
  parents: ReadonlyMap<string, string>,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [id, task] of placement) {
    const turnId = parents.get(id) ?? id;
    if (!out.has(turnId) || out.get(turnId) === null) out.set(turnId, task);
  }
  return out;
}
