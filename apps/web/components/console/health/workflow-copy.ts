import { formatSharePercent } from "@/lib/readings/trace-signals/claims";
import type {
  WorkflowExampleView,
  WorkflowRowView,
  WorkflowsView,
} from "@/lib/readings/trace-signals/view";

/**
 * The Workflows section's words and figures, kept pure so the components only
 * lay them out. Whole percents, one decimal at most, no em dashes.
 */

const fmt = (n: number): string => n.toLocaleString("en-US");

/** "4.2 s", "850 ms", "2 min". */
export function formatWorkflowTime(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export interface WorkflowFigures {
  runs: string;
  share: string;
  completion: string;
  time: string | null;
}

/** A row's figures: "212 runs", "18% of runs", "94%", "4.2 s". */
export function workflowFigures(
  row: Pick<WorkflowRowView, "runs" | "share" | "completion" | "medianMs">,
): WorkflowFigures {
  return {
    runs: `${fmt(row.runs)} ${row.runs === 1 ? "run" : "runs"}`,
    share: `${formatSharePercent(row.share)} of runs`,
    completion: formatSharePercent(row.completion),
    time: formatWorkflowTime(row.medianMs),
  };
}

/** The section's line under its title: how many tasks, and how much of the work they cover. */
export function workflowsSummary(
  view: Pick<WorkflowsView, "items" | "multiToolTurns" | "assignedTurns">,
): string {
  const count = view.items.length;
  const head = `${fmt(count)} ${count === 1 ? "task" : "tasks"}`;
  if (view.multiToolTurns <= 0) return head;
  const covered = formatSharePercent(view.assignedTurns / view.multiToolTurns);
  return `${head}, covering ${covered} of the runs that used two or more tools`;
}

/** Why the list is empty, in plain words. */
export function workflowsEmptyReason(
  view: Pick<WorkflowsView, "multiToolTurns" | "minTools" | "minRuns">,
): string {
  const need = `A task shows up once at least ${fmt(view.minRuns)} runs use the same ${fmt(view.minTools)} or more tools together.`;
  if (view.multiToolTurns <= 0)
    return `No run used ${fmt(view.minTools)} or more tools yet. ${need}`;
  const runs = `${fmt(view.multiToolTurns)} ${view.multiToolTurns === 1 ? "run" : "runs"}`;
  return `${runs} used ${fmt(view.minTools)} or more tools, but no group of tools repeats often enough yet. ${need}`;
}

/** "Fails at update_status in 62% of failed runs". */
export function failingStepText(row: Pick<WorkflowRowView, "failingStep">): string | null {
  const step = row.failingStep;
  if (!step) return null;
  return `Most failed runs stop at ${step.tool.label} (${formatSharePercent(step.share)} of them).`;
}

/** "link_document takes 70% of the time". */
export function slowestStepText(row: Pick<WorkflowRowView, "slowestStep">): string | null {
  const step = row.slowestStep;
  if (!step) return null;
  return `${step.tool.label} takes ${formatSharePercent(step.share)} of the time.`;
}

const EXAMPLE_LABEL: Record<WorkflowExampleView["why"], string> = {
  failed: "A run that failed",
  slow: "One of the slowest runs",
  recent: "A recent run",
};

export function workflowExampleLabel(example: Pick<WorkflowExampleView, "why">): string {
  return EXAMPLE_LABEL[example.why];
}

/** The map's line while it shows one task. */
export function workflowFocusLine(row: Pick<WorkflowRowView, "name" | "runs">): string {
  return `Only the runs of ${row.name} (${fmt(row.runs)} ${row.runs === 1 ? "run" : "runs"}), step by step.`;
}

/** When the map cannot place a workflow's steps (folded away, or past the calls it records). */
export const WORKFLOW_FOCUS_EMPTY =
  "These steps are folded into other tools on this map, so it cannot show them on their own.";

/** Runs that asked for a task but failed or did nothing before running all of it, as one plain line. */
export function stoppedShortText({
  runs,
  withErrors,
}: {
  runs: number;
  withErrors: number;
}): string {
  const asked = runs === 1 ? "1 more run asked for this" : `${fmt(runs)} more runs asked for this`;
  if (withErrors >= runs) return `${asked} and failed.`;
  if (withErrors === 0) return `${asked} but called no tool.`;
  return `${asked} and failed or called no tool.`;
}

/** How many runs asked for a request no task or tool handles, said by why it counts. */
export function unservedRunsText(runs: number, reason?: "no_tool" | "unresolved" | null): string {
  const asked = `${fmt(runs)} ${runs === 1 ? "run" : "runs"} asked for this`;
  if (reason === "no_tool") return `${asked}; no tool does it`;
  if (reason === "unresolved") return `${asked} and failed or called no tool`;
  return asked;
}

/** The collapsed line of asks no task or tool handles: "3 asks no tool or task handles · 19 runs". */
export function unservedSummary(asks: readonly { runs: number }[]): string {
  const runs = asks.reduce((sum, ask) => sum + Math.max(0, ask.runs), 0);
  const head = `${fmt(asks.length)} ${asks.length === 1 ? "ask" : "asks"} no tool or task handles`;
  return `${head} · ${fmt(runs)} ${runs === 1 ? "run" : "runs"}`;
}

/** The expanded heading of those asks. */
export const UNSERVED_TITLE = "Asks no task or tool handles";
