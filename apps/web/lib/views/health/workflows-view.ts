import type {
  StoredWorkflow,
  StoredWorkflows,
} from "@/lib/readings/trace-signals/signals/workflow-stored";
import type {
  SignalView,
  UnservedAskView,
  WorkflowExampleView,
  WorkflowModelView,
  WorkflowProblemView,
  WorkflowRowView,
  WorkflowStepView,
  WorkflowsView,
  WorkflowToolView,
} from "@/lib/readings/trace-signals/view";
import type { WorkflowInsights } from "@/lib/readings/trace-signals/workflows/decide";
import { taskFinish } from "@/lib/readings/trace-signals/workflows/finish";
import { workflowIcon } from "@/lib/readings/trace-signals/workflows/icons";
import {
  type WorkflowLabels,
  workflowDescription,
  workflowDisplayName,
} from "@/lib/readings/trace-signals/workflows/name";
import { DEFAULT_WORKFLOW_CONFIG } from "@/lib/readings/trace-signals/workflows/types";

/**
 * The Workflows section's model, from the latest run's `summary.workflows`
 * and the open signals: one row per workflow (its name, its steps in order,
 * how often and how well it runs, its worst open problem, a "build this" line
 * when its steps always run in the same order, and a few example runs), and
 * which chain signals lie inside a workflow, so the problem list can fold
 * them under it. Pure; the stored JSON is read defensively.
 */

/** Example runs a row offers at most. */
export const WORKFLOW_EXAMPLE_LIMIT = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function isStoredItem(value: unknown): value is StoredWorkflow {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  return (
    strings(value.typicalOrder).length > 0 && isRecord(value.health) && isRecord(value.examples)
  );
}

const BLOCKS: ReadonlySet<string> = new Set(["no_tool_calls", "mixed_runs"]);

/** The stored basis as the view reads it; older runs (no basis) read every run, nothing hidden. */
export function basisView(
  basis: unknown,
): Pick<WorkflowsView, "blocked" | "readingSince" | "excludedRuns"> {
  if (!isRecord(basis)) return { blocked: null, readingSince: null, excludedRuns: 0 };
  const blocked =
    typeof basis.blocked === "string" && BLOCKS.has(basis.blocked)
      ? (basis.blocked as WorkflowsView["blocked"])
      : null;
  const since = basis.basis === "exact" && typeof basis.since === "string" ? basis.since : null;
  return {
    blocked,
    readingSince: since,
    excludedRuns: Math.max(0, numberOr(basis.excludedRuns, 0)),
  };
}

/** Where the judged requests came from, from the insights' source counts. */
export function asksFrom(insights: WorkflowInsights | null | undefined): WorkflowsView["asksFrom"] {
  const sources = insights?.sources;
  // Insights stored before the counts say nothing about the source.
  if (!sources || !isRecord(sources)) return null;
  const user = numberOr(sources.user, 0);
  const search = numberOr(sources.search, 0);
  if (user + search === 0) return null;
  return search === 0 ? "user" : user === 0 ? "search" : "mixed";
}

/** The stored workflows, or null when the summary has none (older runs, or no tool calls). */
export function parseStoredWorkflows(value: unknown): StoredWorkflows | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  return { ...(value as unknown as StoredWorkflows), items: value.items.filter(isStoredItem) };
}

function toolView(id: string, names: ReadonlyMap<string, string>): WorkflowToolView {
  return { id, label: names.get(id) ?? id };
}

function stepView(
  step: { toolId?: unknown; share?: unknown } | null | undefined,
  names: ReadonlyMap<string, string>,
): WorkflowStepView | null {
  if (!step || typeof step.toolId !== "string") return null;
  return { tool: toolView(step.toolId, names), share: numberOr(step.share, 0) };
}

/** A few runs to open: failed ones first, then the slowest, then the newest; each run once. */
export function workflowExamples(
  item: StoredWorkflow,
  limit = WORKFLOW_EXAMPLE_LIMIT,
): WorkflowExampleView[] {
  const list = (key: "failed" | "slow" | "recent") =>
    Array.isArray(item.examples?.[key]) ? item.examples[key] : [];
  const ordered = [
    ...list("failed")
      .slice(0, 2)
      .map((e) => ({ e, why: "failed" as const })),
    ...list("slow")
      .slice(0, 1)
      .map((e) => ({ e, why: "slow" as const })),
    ...list("recent").map((e) => ({ e, why: "recent" as const })),
  ];
  const seen = new Set<string>();
  const out: WorkflowExampleView[] = [];
  for (const { e, why } of ordered) {
    if (!e || typeof e.turnId !== "string" || seen.has(e.turnId)) continue;
    seen.add(e.turnId);
    out.push({
      turnId: e.turnId,
      focusEventId: typeof e.traceEventId === "string" ? e.traceEventId : null,
      why,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** The workflow's worst open problem: a failing signal before a slow one. */
function problemOf(id: string, signals: readonly SignalView[]): WorkflowProblemView | null {
  const mine = signals.filter((s) => s.subject.kind === "workflow" && s.subject.key === id);
  const pick =
    mine.find((s) => s.kind === "workflow_failing") ?? mine.find((s) => s.kind === "workflow_slow");
  return pick ? { signalId: pick.id, kind: pick.kind, claim: pick.claim } : null;
}

/** "Build this" for a task whose steps always run in the same order. */
export function buildSuggestion(steps: number): string {
  return `Build one tool for these ${steps} steps, or a skill that runs them in order.`;
}

function stoppedShortOf(
  id: string,
  insights: WorkflowInsights | null | undefined,
): WorkflowRowView["stoppedShort"] {
  const placed = insights?.placed?.[id];
  if (!placed || !(placed.outside > 0)) return null;
  return { runs: placed.outside, withErrors: Math.max(0, placed.outsideWithErrors ?? 0) };
}

/** Requests no workflow or tool handles, as the page lists them. */
export function unservedView(insights: WorkflowInsights | null | undefined): UnservedAskView[] {
  if (!insights || !Array.isArray(insights.unserved)) return [];
  return insights.unserved.flatMap((group) => {
    const samples = strings(group.samples);
    if (samples.length === 0 || !(group.turns > 0)) return [];
    const reason =
      group.reason === "no_tool" || group.reason === "unresolved" ? group.reason : null;
    return [
      {
        title: samples[0],
        others: samples.slice(1),
        runs: group.turns,
        reason,
        turnIds: strings(group.turnIds),
      },
    ];
  });
}

function rowOf(
  item: StoredWorkflow,
  signals: readonly SignalView[],
  names: ReadonlyMap<string, string>,
  labels: WorkflowLabels | undefined,
  insights?: WorkflowInsights | null,
): WorkflowRowView {
  const fixed = signals.some(
    (s) =>
      s.kind === "workflow_fixed_chain" &&
      s.subject.kind === "workflow" &&
      s.subject.key === item.id,
  );
  const order = strings(item.typicalOrder);
  return {
    id: item.id,
    name: workflowDisplayName({ id: item.id, typicalOrder: order }, names, labels),
    description: workflowDescription({ id: item.id }, labels),
    icon: workflowIcon(labels?.get(item.id)?.icon),
    steps: order.map((id) => toolView(id, names)),
    focusTools: order,
    runs: numberOr(item.runs, 0),
    share: numberOr(item.share, 0),
    // The one finish rate (`workflows/finish.ts`): runs that asked for the task and called no tool count as unfinished.
    completion:
      taskFinish(item, insights?.placed?.[item.id]).rate ?? numberOr(item.health.completion, 0),
    medianMs: typeof item.health.medianMs === "number" ? item.health.medianMs : null,
    problem: problemOf(item.id, signals),
    build: fixed ? buildSuggestion(order.length) : null,
    failingStep: stepView(item.health.failingStep, names),
    slowestStep: stepView(item.health.slowestStep, names),
    examples: workflowExamples(item),
    stoppedShort: stoppedShortOf(item.id, insights),
    ...modelOf(item),
  };
}

/** The row's model figures, spread in only when the run stored them. */
function modelOf(item: StoredWorkflow): { model?: WorkflowModelView } {
  const model = (item.health as { model?: unknown }).model;
  if (!model || typeof model !== "object") return {};
  const m = model as Record<string, unknown>;
  if (typeof m.medianModelCalls !== "number" || typeof m.modelShare !== "number") return {};
  const costUsd = typeof m.medianCostUsd === "number" ? m.medianCostUsd : null;
  return { model: { costUsd, modelCalls: m.medianModelCalls, modelShare: m.modelShare } };
}

/**
 * Chain signals whose two tools both lie in one workflow's core, to that
 * workflow (the one with the most runs when several hold the pair). The
 * problem list folds them under the workflow instead of listing each pair.
 */
export function chainOwners(
  items: readonly Pick<StoredWorkflow, "id" | "coreTools" | "runs">[],
  signals: readonly Pick<SignalView, "id" | "kind" | "subject">[],
): Record<string, string> {
  const byRuns = [...items].sort((a, b) => b.runs - a.runs);
  const owners: Record<string, string> = {};
  for (const signal of signals) {
    if (signal.kind !== "sequence_chain") continue;
    const [a, b] = signal.subject.chips.map((chip) => chip.id);
    if (!a || !b) continue;
    const owner = byRuns.find((item) => {
      const core = strings(item.coreTools);
      return core.includes(a) && core.includes(b);
    });
    if (owner) owners[signal.id] = owner.id;
  }
  return owners;
}

export interface WorkflowsViewInputs {
  /** `summary.workflows` as stored; null or absent when the run stored none. */
  stored: unknown;
  /** Every open signal, shown or not, so a row's problem is found however the plan cuts the list. */
  signals: readonly SignalView[];
  names: ReadonlyMap<string, string>;
  labels?: WorkflowLabels;
  /** What the choice model read from captured asks (`label_workflows` job); absent without it. */
  insights?: WorkflowInsights | null;
}

/** The section's model; null when the run stored no workflows, so the section is not drawn. */
export function workflowsView({
  stored,
  signals,
  names,
  labels,
  insights,
}: WorkflowsViewInputs): WorkflowsView | null {
  const parsed = parseStoredWorkflows(stored);
  if (!parsed) return null;
  const items = [...parsed.items].sort((a, b) => numberOr(b.runs, 0) - numberOr(a.runs, 0));
  return {
    items: items.map((item) => rowOf(item, signals, names, labels, insights)),
    multiToolTurns: numberOr(parsed.multiToolTurns, 0),
    assignedTurns: numberOr(parsed.assignedTurns, 0),
    minTools: DEFAULT_WORKFLOW_CONFIG.minSize,
    minRuns: DEFAULT_WORKFLOW_CONFIG.minSupport,
    chainOwners: chainOwners(items, signals),
    unserved: unservedView(insights),
    ...basisView(parsed.basis),
    asksFrom: asksFrom(insights),
  };
}

/** Chain signals folded under their workflow, as the problem list reads them. */
export interface ChainFolding {
  /** Chain signal id to its workflow's id. */
  owners: Readonly<Record<string, string>>;
  /** Workflow id to its display name. */
  names: Readonly<Record<string, string>>;
}

/** The folding the problem list applies; undefined when there is nothing to fold. */
export function chainFolding(
  view: Pick<WorkflowsView, "items" | "chainOwners"> | null,
): ChainFolding | undefined {
  if (!view || Object.keys(view.chainOwners).length === 0) return undefined;
  return {
    owners: view.chainOwners,
    names: Object.fromEntries(view.items.map((item) => [item.id, item.name])),
  };
}
