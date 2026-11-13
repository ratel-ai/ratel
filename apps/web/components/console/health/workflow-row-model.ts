import { formatWorkflowTime, stoppedShortText } from "@/components/console/health/workflow-copy";
import { formatSharePercent } from "@/lib/readings/trace-signals/claims";
import type {
  WorkflowExampleView,
  WorkflowModelView,
  WorkflowRowView,
} from "@/lib/readings/trace-signals/view";
import { formatUsd } from "@/lib/views/health/tiles";

/**
 * A workflow row at its two depths, kept pure so the component only lays it
 * out. Collapsed: name, runs, finish rate and one status dot. Expanded: the
 * description, the steps with the failing and slow ones marked, one sentence
 * for the top problem, what to build, the runs that asked for it and failed,
 * and the first example run to open.
 */

/** The one status pill a collapsed row carries: needs attention (failing, slow), an opportunity, or healthy. */
export type WorkflowStatus = "failing" | "slow" | "build" | "fine";

/** The pill's label. */
export const WORKFLOW_STATUS_LABEL: Readonly<Record<WorkflowStatus, string>> = {
  failing: "Failing",
  slow: "Slow",
  build: "Build this",
  fine: "Healthy",
};

/** Of the run time, a step taking at least this much is marked slow even without a slow signal. */
export const SLOW_STEP_SHARE = 0.5;

/** A failing workflow before a slow one, then one worth building as a tool, then fine. */
export function workflowStatus(row: Pick<WorkflowRowView, "problem" | "build">): WorkflowStatus {
  if (row.problem?.kind === "workflow_failing") return "failing";
  if (row.problem?.kind === "workflow_slow") return "slow";
  if (row.build) return "build";
  return "fine";
}

export interface WorkflowRowSummary {
  status: WorkflowStatus;
  statusLabel: string;
  /** "1,083", under the "Runs" column. */
  runs: string;
  /** "94%". */
  finish: string;
}

const fmt = (n: number): string => n.toLocaleString("en-US");

export function workflowRowSummary(
  row: Pick<WorkflowRowView, "problem" | "build" | "runs" | "completion">,
): WorkflowRowSummary {
  const status = workflowStatus(row);
  return {
    status,
    statusLabel: WORKFLOW_STATUS_LABEL[status],
    runs: fmt(row.runs),
    finish: formatSharePercent(row.completion),
  };
}

/** How a step chip is marked: where failed runs stop, or where the time goes. */
export type StepMark = "failing" | "slow" | null;

export interface MarkedStep {
  id: string;
  label: string;
  mark: StepMark;
  /** Why it is marked, for its tooltip and screen readers; null when it is not. */
  note: string | null;
}

/** The steps in order, the failing one coral and the slow one amber (failing wins when both). */
export function markedSteps(
  row: Pick<WorkflowRowView, "steps" | "failingStep" | "slowestStep" | "completion" | "problem">,
): MarkedStep[] {
  const failing = row.completion < 1 && row.failingStep ? row.failingStep : null;
  const slowMarked =
    row.slowestStep &&
    (row.problem?.kind === "workflow_slow" || row.slowestStep.share >= SLOW_STEP_SHARE);
  const slow = slowMarked ? row.slowestStep : null;
  let failingDone = false;
  let slowDone = false;
  return row.steps.map((step) => {
    if (failing && !failingDone && step.id === failing.tool.id) {
      failingDone = true;
      return {
        ...step,
        mark: "failing",
        note: `Most failed runs stop here (${formatSharePercent(failing.share)} of them)`,
      };
    }
    if (slow && !slowDone && step.id === slow.tool.id) {
      slowDone = true;
      return { ...step, mark: "slow", note: `Takes ${formatSharePercent(slow.share)} of the time` };
    }
    return { ...step, mark: null, note: null };
  });
}

const EXAMPLE_LINK: Readonly<Record<WorkflowExampleView["why"], string>> = {
  failed: "Open a failed run",
  slow: "Open a slow run",
  recent: "Open a recent run",
};

export interface WorkflowExpanded {
  description: string | null;
  steps: MarkedStep[];
  /** "11% of runs · typical run 9.8 s". */
  meta: string;
  /** "$0.03 a run · 4 model calls · 70% of the time in the model", or null without linked model calls. */
  model: string | null;
  /** One sentence for the top problem, or null. */
  problem: { kind: "failing" | "slow"; text: string } | null;
  build: string | null;
  /** "9 more runs asked for this and failed ...", or null. */
  stoppedShort: string | null;
  /** The first example run (failed ones first), with its link label. */
  example: (WorkflowExampleView & { label: string }) | null;
}

export function workflowExpanded(row: WorkflowRowView): WorkflowExpanded {
  const time = formatWorkflowTime(row.medianMs);
  const first = row.examples[0] ?? null;
  return {
    description: row.description,
    steps: markedSteps(row),
    meta: [`${formatSharePercent(row.share)} of runs`, time ? `typical run ${time}` : null]
      .filter(Boolean)
      .join(" · "),
    model: row.model ? workflowModelText(row.model) : null,
    problem: row.problem
      ? {
          kind: row.problem.kind === "workflow_failing" ? "failing" : "slow",
          text: row.problem.claim,
        }
      : null,
    build: row.build,
    stoppedShort: row.stoppedShort ? stoppedShortText(row.stoppedShort) : null,
    example: first ? { ...first, label: EXAMPLE_LINK[first.why] } : null,
  };
}

/** What a typical run spends in the model: "$0.03 a run · 4 model calls · 70% of the time in the model". */
export function workflowModelText(model: WorkflowModelView): string {
  const calls = Math.round(model.modelCalls);
  return [
    model.costUsd === null ? null : `${formatUsd(model.costUsd)} a run`,
    `${calls} model ${calls === 1 ? "call" : "calls"}`,
    `${formatSharePercent(model.modelShare)} of the time in the model`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The button that focuses the map on a workflow. */
export const SEE_NEEDS_FIRST = "See what each step needs first";
