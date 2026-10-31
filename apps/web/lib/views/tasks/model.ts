import { type TaskColorSlot, taskColors } from "@ratel/design-system/task-colors";
import { SIGNAL_CATALOG } from "@/lib/readings/trace-signals/signals/catalog";
import type {
  StoredWorkflow,
  StoredWorkflows,
} from "@/lib/readings/trace-signals/signals/workflow-stored";
import type { UnservedAskView } from "@/lib/readings/trace-signals/view";
import type { WorkflowInsights } from "@/lib/readings/trace-signals/workflows/decide";
import { taskFinish } from "@/lib/readings/trace-signals/workflows/finish";
import { runsInFixedOrder } from "@/lib/readings/trace-signals/workflows/fixed-order";
import { type WorkflowIconKey, workflowIcon } from "@/lib/readings/trace-signals/workflows/icons";
import {
  WORKFLOW_NAME_SEPARATOR,
  type WorkflowLabels,
  workflowDescription,
  workflowDisplayName,
} from "@/lib/readings/trace-signals/workflows/name";
import type {
  TaskReading,
  TaskStepReading,
  TaskStepRole,
} from "@/lib/readings/trace-signals/workflows/reading";
import type { CraftKind, RoundTripPrice } from "@/lib/views/fixes/crafter-types";
import { claimModel, type SignalRecord } from "@/lib/views/health/signals/claims-model";
import {
  basisView,
  parseStoredWorkflows,
  unservedView,
  workflowExamples,
} from "@/lib/views/health/workflows-view";
import { type FixView, taskFixCount, taskFixViews } from "@/lib/views/tasks/fixes";
import { foldIssues, type IssueView, issueView, type TaskFixLike } from "@/lib/views/tasks/issues";
import { fixesHref } from "@/lib/views/tasks/paths";
import {
  TASK_STATUS_RANK,
  type TaskStatus,
  taskStatus,
  WATCH,
  type WatchReason,
} from "@/lib/views/tasks/status";

/**
 * The task pages' model, from what the loader read: the latest signal run's
 * tasks (`summary.workflows`, each with its step-by-step reading), their
 * names, the open issues, the fixes for them, and, when the jobs that write
 * them have run, the intents (stored as topics) each task serves and the
 * self-corrections recorded in it. Pure, so every state is testable without
 * a database. Text the user or agent wrote never reaches it; names and ids
 * only.
 */

/* - Inputs ------------------------------------------------------------------ */

export interface TaskRunFacts {
  windowDays: number;
  finishedAt: Date | null;
  /** Closed runs in the window: what "share of all runs" is of. */
  turnsScanned: number;
}

/** The kinds `trace_self_corrections` records: the five read from steps, and reply phrases. */
export const CORRECTION_KINDS = [
  "retry_after_error",
  "switch_after_error",
  "gave_up_after_error",
  "searched_again",
  "asked_again",
  "phrase",
] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];
export type CorrectionCounts = Partial<Record<CorrectionKind, number>>;

/** Self-corrections recorded per task, when the project has any rows at all. */
export interface RecordedCorrections {
  byTask: ReadonlyMap<string, CorrectionCounts>;
}

export interface TaskTopic {
  id: string;
  name: string;
  /** The task's runs in this topic. */
  runs: number;
}

/** A pending fix (a drafted change to the tools), as the task pages list it. */
export interface TaskFixSource {
  id: string;
  kind: CraftKind;
  headline: string;
  toolIds: readonly string[];
  /** The task the fix composes into one tool, for that kind. */
  workflowId: string | null;
}

export interface TaskIssueSource {
  record: SignalRecord;
  /** The fix the issue opens, once one is linked to it. */
  proposalId: string | null;
}

export interface TasksInputs {
  projectId: string;
  run: TaskRunFacts | null;
  /** `summary.workflows` as stored (untrusted JSON). */
  stored: unknown;
  labels: WorkflowLabels;
  names: ReadonlyMap<string, string>;
  issues: readonly TaskIssueSource[];
  insights: WorkflowInsights | null;
  fixes: readonly TaskFixSource[];
  /** Null until the self-corrections job has written a row for the project. */
  recorded: RecordedCorrections | null;
  /** Null until topics have been assigned for the project. */
  topics: ReadonlyMap<string, readonly TaskTopic[]> | null;
  price: RoundTripPrice | null;
}

/* - Shared pieces ------------------------------------------------------------ */

export interface WeakestStep {
  toolId: string;
  label: string;
  failures: number;
  calls: number;
  failureShare: number;
}

interface TaskCore {
  item: StoredWorkflow;
  reading: TaskReading | null;
  id: string;
  name: string;
  description: string | null;
  icon: WorkflowIconKey;
  color: TaskColorSlot | null;
  runs: number;
  finishedRuns: number;
  /** Runs that asked for the task (judged from their request) but called no tool: unfinished. */
  askedNoTool: number;
  finishRate: number | null;
  weakest: WeakestStep | null;
  corrections: { events: number; byKind: CorrectionCounts; source: "recorded" | "steps" } | null;
  correctionsPer100: number | null;
  status: TaskStatus;
  watch: WatchReason | null;
  issues: TaskIssueSource[];
  fixes: TaskFixSource[];
  tools: ReadonlySet<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The stored reading, when this run stored one of this version. */
function readingOf(item: StoredWorkflow): TaskReading | null {
  const reading = (item as { reading?: unknown }).reading;
  if (!isRecord(reading) || reading.version !== 1 || !Array.isArray(reading.steps)) return null;
  return reading as unknown as TaskReading;
}

const nameOf = (names: ReadonlyMap<string, string>) => (id: string) => names.get(id) ?? id;

/** The route a finding's fix takes: the one the detector stored, else its kind's. */
function fixRouteOf(record: SignalRecord): string {
  const stored = record.metrics.route;
  return typeof stored === "string" ? stored : SIGNAL_CATALOG[record.kind].fixRoute;
}

/** The step that fails the largest share of its calls; null when no step failed. */
export function weakestStep(
  reading: TaskReading | null,
  label: (id: string) => string,
): WeakestStep | null {
  if (!reading) return null;
  let best: WeakestStep | null = null;
  for (const step of reading.steps) {
    if (step.role === "helper" || step.calls === 0 || step.failures === 0) continue;
    const share = step.failures / step.calls;
    if (
      !best ||
      share > best.failureShare ||
      (share === best.failureShare && step.failures > best.failures)
    ) {
      best = {
        toolId: step.toolId,
        label: label(step.toolId),
        failures: step.failures,
        calls: step.calls,
        failureShare: share,
      };
    }
  }
  return best;
}

function sumCounts(counts: CorrectionCounts): number {
  return CORRECTION_KINDS.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
}

function correctionsOf(
  id: string,
  reading: TaskReading | null,
  recorded: RecordedCorrections | null,
): TaskCore["corrections"] {
  if (recorded) {
    const byKind = recorded.byTask.get(id) ?? {};
    return { events: sumCounts(byKind), byKind, source: "recorded" };
  }
  if (!reading) return null;
  return {
    events: reading.corrections.events,
    byKind: { ...reading.corrections.byKind },
    source: "steps",
  };
}

/**
 * Issues raised on the task itself or on one of its tools (both tools, for a
 * pair). Two of its own steps that run in a chain are the task itself, not an
 * issue in it: its "steps that always run in order" says so once, as the
 * Summary folds them; and a chain the agent reaches directly ("nothing to
 * change yet") is no issue anywhere.
 */
function issuesOf(
  id: string,
  core: ReadonlySet<string>,
  tools: ReadonlySet<string>,
  issues: readonly TaskIssueSource[],
): TaskIssueSource[] {
  return issues.filter(({ record }) => {
    if (
      record.kind === "sequence_chain" &&
      (fixRouteOf(record) !== "workflow_skill" || record.subjectIds.every((tool) => core.has(tool)))
    )
      return false;
    if (record.subjectKind === "workflow") return record.subjectKey === id;
    if (record.subjectKind === "tool" || record.subjectKind === "skill")
      return tools.has(record.subjectKey);
    if (record.subjectKind === "tool_pair")
      return record.subjectIds.length > 0 && record.subjectIds.every((tool) => tools.has(tool));
    return false;
  });
}

function fixesOf(
  id: string,
  tools: ReadonlySet<string>,
  fixes: readonly TaskFixSource[],
): TaskFixSource[] {
  return fixes.filter(
    (fix) =>
      fix.workflowId === id ||
      (fix.workflowId === null && fix.toolIds.some((tool) => tools.has(tool))),
  );
}

function coreOf(
  item: StoredWorkflow,
  inputs: TasksInputs,
  colors: ReadonlyMap<string, TaskColorSlot>,
): TaskCore {
  const reading = readingOf(item);
  const label = nameOf(inputs.names);
  const runs = reading?.runs ?? item.runs;
  const finish = taskFinish(
    { health: item.health, ...(reading ? { reading } : {}) },
    inputs.insights?.placed?.[item.id],
  );
  const finishedRuns = finish.finished;
  const askedNoTool = finish.askedNoTool;
  const finishRate = finish.rate;
  const weakest = weakestStep(reading, label);
  const corrections = correctionsOf(item.id, reading, inputs.recorded);
  const correctionsPer100 = corrections && runs > 0 ? (corrections.events * 100) / runs : null;
  const tools = new Set([...item.coreTools, ...item.optionalTools]);
  const issues = issuesOf(item.id, new Set(item.coreTools), tools, inputs.issues);
  const own = new Set(
    issues
      .filter(({ record }) => record.subjectKind === "workflow")
      .map(({ record }) => record.kind as string),
  );
  const { status, reason } = taskStatus({
    issueKinds: own,
    finishRate,
    weakest,
    correctionsPer100,
  });
  return {
    item,
    reading,
    id: item.id,
    name: workflowDisplayName(
      { id: item.id, typicalOrder: item.typicalOrder },
      inputs.names,
      inputs.labels,
    ),
    description: workflowDescription({ id: item.id }, inputs.labels),
    icon: workflowIcon(inputs.labels.get(item.id)?.icon),
    color: colors.get(item.id) ?? null,
    runs,
    finishedRuns,
    askedNoTool,
    finishRate,
    weakest,
    corrections,
    correctionsPer100,
    status,
    watch: reason,
    issues,
    fixes: fixesOf(item.id, tools, inputs.fixes),
    tools,
  };
}

function coresOf(inputs: TasksInputs): { cores: TaskCore[]; stored: StoredWorkflows | null } {
  const stored = parseStoredWorkflows(inputs.stored);
  if (!stored) return { cores: [], stored: null };
  const colors = taskColors(
    stored.items.map((item) => ({ id: item.id, runs: readingOf(item)?.runs ?? item.runs })),
  );
  const cores = stored.items
    .map((item) => coreOf(item, inputs, colors))
    .filter((core) => core.runs > 0);
  return { cores, stored };
}

/** One sentence on why a task wears its status. */
export function statusLine(
  core: Pick<
    TaskCore,
    "status" | "watch" | "finishRate" | "weakest" | "correctionsPer100" | "issues" | "id"
  >,
  windowDays: number,
  names: ReadonlyMap<string, string>,
  labels: WorkflowLabels,
): string {
  const own = (kind: string) =>
    core.issues.find(({ record }) => record.subjectKind === "workflow" && record.kind === kind);
  if (core.status === "failing" || core.status === "slow") {
    const issue = own(core.status === "failing" ? "workflow_failing" : "workflow_slow");
    if (issue) return claimModel(issue.record, names, windowDays, labels).claim;
  }
  const finish = core.finishRate === null ? null : formatPercentWhole(core.finishRate);
  if (core.watch === "finish" && finish) return `Finishes ${finish} of its runs.`;
  if (core.watch === "step" && core.weakest)
    return `${core.weakest.label} fails ${formatPercentWhole(core.weakest.failureShare)} of its calls.`;
  if (core.watch === "corrections" && core.correctionsPer100 !== null) {
    return `The agent corrects itself ${Math.round(core.correctionsPer100)} times per 100 runs.`;
  }
  return finish ? `Finishes ${finish} of its runs.` : "No runs in this window.";
}

function formatPercentWhole(share: number): string {
  const whole = Math.round(share * 100);
  if (share > 0 && whole === 0) return "<1%";
  if (share < 1 && whole === 100) return ">99%";
  return `${whole}%`;
}

/* - The list ----------------------------------------------------------------- */

export type TasksState = "no_reading" | "blocked" | "no_tasks" | "ready";

/** One of a task's steps, by tool. */
export interface TaskStepRef {
  toolId: string;
  label: string;
}

export interface TaskRow {
  id: string;
  name: string;
  description: string | null;
  icon: WorkflowIconKey;
  color: TaskColorSlot | null;
  /** Its steps, the tools it runs in their usual order. Optional for callers that build rows by hand. */
  steps?: TaskStepRef[];
  status: TaskStatus;
  runs: number;
  /** Of every closed run in the window. */
  share: number | null;
  finishRate: number | null;
  weakest: WeakestStep | null;
  correctionsPer100: number | null;
  /** The top intents (stored as topics) it serves, most runs first; null when they are not assigned yet. */
  topics: TaskTopic[] | null;
  /** How many intents it serves in all, of which `topics` are the top ones. */
  topicCount?: number;
  issues: number;
  fixes: number;
  fixesHref: string;
}

export interface UnservedRow {
  /** False without the placement verdicts (no captured requests, or no decision model). */
  measured: boolean;
  asks: UnservedAskView[];
  runs: number;
}

export interface TaskListModel {
  state: TasksState;
  blocked: "no_tool_calls" | "mixed_runs" | null;
  windowDays: number | null;
  readAt: Date | null;
  stats: {
    tasks: number;
    runsInTasks: number;
    allRuns: number;
    finishRate: number | null;
    correctionsPer100: number | null;
    /** Recorded self-corrections (every kind) rather than the ones read from steps. */
    correctionsRecorded: boolean;
  };
  rows: TaskRow[];
  unserved: UnservedRow;
  /** Read from runs with exact boundaries since this date, when guessed runs were left out, and how many were. */
  readingSince: string | null;
  excludedRuns: number;
}

export const LIST_TOPICS = 2;

function unservedOf(insights: WorkflowInsights | null): UnservedRow {
  const asks = unservedView(insights);
  return { measured: insights !== null, asks, runs: asks.reduce((sum, ask) => sum + ask.runs, 0) };
}

/** What the task pages read besides their inputs: Fixes' open fixes, when the page loaded them. */
export interface TaskFixesOption {
  /** Null when Fixes could not be read; absent where a page does not show fixes. */
  fixes?: readonly TaskFixLike[] | null;
}

export function buildTaskList(inputs: TasksInputs, options: TaskFixesOption = {}): TaskListModel {
  const { cores, stored } = coresOf(inputs);
  const label = nameOf(inputs.names);
  const basis = stored
    ? basisView(stored.basis)
    : { blocked: null, readingSince: null, excludedRuns: 0 };
  const allRuns = inputs.run?.turnsScanned ?? 0;
  const runsInTasks = cores.reduce((sum, core) => sum + core.runs, 0);
  const finished = cores.reduce((sum, core) => sum + core.finishedRuns, 0);
  const finishOf = cores.reduce((sum, core) => sum + core.runs + core.askedNoTool, 0);
  const counted = cores.filter((core) => core.corrections !== null);
  const correctionRuns = counted.reduce((sum, core) => sum + core.runs, 0);
  const correctionEvents = counted.reduce((sum, core) => sum + (core.corrections?.events ?? 0), 0);
  const rows: TaskRow[] = [...cores]
    .sort(
      (a, b) =>
        b.runs - a.runs ||
        TASK_STATUS_RANK[a.status] - TASK_STATUS_RANK[b.status] ||
        (a.id < b.id ? -1 : 1),
    )
    .map((core) => ({
      id: core.id,
      name: core.name,
      description: core.description,
      icon: core.icon,
      color: core.color,
      steps: core.item.typicalOrder.map((toolId) => ({ toolId, label: label(toolId) })),
      status: core.status,
      runs: core.runs,
      share: allRuns > 0 ? Math.min(1, core.runs / allRuns) : null,
      finishRate: core.finishRate,
      weakest: core.weakest,
      correctionsPer100: core.correctionsPer100,
      topics: inputs.topics ? [...(inputs.topics.get(core.id) ?? [])].slice(0, LIST_TOPICS) : null,
      topicCount: inputs.topics ? (inputs.topics.get(core.id) ?? []).length : 0,
      issues: core.issues.length,
      fixes: taskFixCount(core.id, options.fixes, core.fixes),
      fixesHref: fixesHref(inputs.projectId, { task: core.id }),
    }));
  const state: TasksState =
    !inputs.run || !stored
      ? "no_reading"
      : basis.blocked
        ? "blocked"
        : rows.length === 0
          ? "no_tasks"
          : "ready";
  return {
    state,
    blocked: basis.blocked,
    windowDays: inputs.run?.windowDays ?? null,
    readAt: inputs.run?.finishedAt ?? null,
    stats: {
      tasks: rows.length,
      runsInTasks,
      allRuns,
      finishRate: finishOf > 0 ? finished / finishOf : null,
      correctionsPer100: correctionRuns > 0 ? (correctionEvents * 100) / correctionRuns : null,
      correctionsRecorded: inputs.recorded !== null,
    },
    rows,
    unserved: unservedOf(inputs.insights),
    readingSince: basis.readingSince,
    excludedRuns: basis.excludedRuns,
  };
}

/* - One task ----------------------------------------------------------------- */

export interface StepNextView {
  /** The next tool; null for the end of the run. */
  toolId: string | null;
  label: string;
  share: number;
}

export interface StepView {
  toolId: string;
  label: string;
  role: TaskStepRole;
  /** 1-based place in the task's order; null for optional and helper tools. */
  position: number | null;
  runs: number;
  runShare: number;
  calls: number;
  failures: number;
  failureShare: number | null;
  retries: number;
  switches: number;
  gaveUp: number;
  medianMs: number | null;
  handoffMs: number | null;
  next: StepNextView[];
  /** Where the eye should land: the step that fails most, or the slow one. */
  mark: "failing" | "slow" | null;
}

export interface CorrectionRow {
  kind: CorrectionKind;
  label: string;
  count: number;
  per100: number | null;
}

export type { FixView } from "@/lib/views/tasks/fixes";
export type { IssueView } from "@/lib/views/tasks/issues";

export interface ExampleRef {
  turnId: string;
  focusEventId: string | null;
  why: "failed" | "slow" | "recent";
}

export type CostView =
  | {
      kind: "measured";
      perRun: number | null;
      total: number | null;
      runs: number;
      modelCalls: number | null;
    }
  | { kind: "estimated"; perRun: number; total: number; callsPerRun: number }
  | { kind: "none" };

export interface FlowEdge {
  a: string;
  b: string;
  n: number;
  na: number;
}

export interface TaskDetailModel {
  id: string;
  name: string;
  description: string | null;
  icon: WorkflowIconKey;
  color: TaskColorSlot | null;
  status: TaskStatus;
  /** Why a task is on Watch: its finish rate, a step that fails, or how often the agent corrects itself. */
  watch: WatchReason | null;
  statusLine: string;
  windowDays: number;
  readAt: Date | null;
  runs: number;
  share: number | null;
  finishRate: number | null;
  finishedRuns: number;
  askedNoTool: number;
  recoveredRuns: number | null;
  medianMs: number | null;
  correctionsPer100: number | null;
  callsPerRun: number | null;
  cost: CostView;
  /** False on a run stored before tasks were read step by step. */
  hasReading: boolean;
  /** The one fixed-order rule (`fixed-order.ts`): the share of full runs in the usual order. */
  order: { stability: number; fixed: boolean };
  steps: StepView[];
  sideSteps: StepView[];
  flow: { edges: FlowEdge[]; tools: { toolId: string; n: number }[] };
  topics: TaskTopic[] | null;
  corrections: {
    source: "recorded" | "steps";
    rows: CorrectionRow[];
    total: number;
    per100: number | null;
  } | null;
  issues: IssueView[];
  fixes: FixView[];
  allFixesHref: string;
  examples: ExampleRef[];
  /** Tools to mark when a run's session opens: the steps. */
  focusTools: string[];
}

export const CORRECTION_LABEL: Readonly<Record<CorrectionKind, string>> = {
  retry_after_error: "Retried",
  switch_after_error: "Switched tools",
  gave_up_after_error: "Gave up",
  searched_again: "Searched again",
  asked_again: "Asked again",
  phrase: "Apologized",
};

function stepView(
  step: TaskStepReading,
  runs: number,
  label: (id: string) => string,
  marks: { failing: string | null; slow: string | null },
  position: number | null,
): StepView {
  return {
    toolId: step.toolId,
    label: label(step.toolId),
    role: step.role,
    position,
    runs: step.runs,
    runShare: runs > 0 ? step.runs / runs : 0,
    calls: step.calls,
    failures: step.failures,
    failureShare: step.calls > 0 ? step.failures / step.calls : null,
    retries: step.retries,
    switches: step.switches,
    gaveUp: step.gaveUp,
    medianMs: step.medianMs,
    handoffMs: step.handoffMs,
    next: step.next.map((next) => ({
      toolId: next.toolId,
      label: next.toolId === null ? "Run ends" : label(next.toolId),
      share: step.nextOf > 0 ? next.n / step.nextOf : next.share,
    })),
    mark: marks.failing === step.toolId ? "failing" : marks.slow === step.toolId ? "slow" : null,
  };
}

/** Steps without numbers, for a run stored before tasks were read step by step. */
function bareStep(
  id: string,
  role: TaskStepRole,
  label: (id: string) => string,
  position: number | null,
): StepView {
  return {
    toolId: id,
    label: label(id),
    role,
    position,
    runs: 0,
    runShare: 0,
    calls: 0,
    failures: 0,
    failureShare: null,
    retries: 0,
    switches: 0,
    gaveUp: 0,
    medianMs: null,
    handoffMs: null,
    next: [],
    mark: null,
  };
}

function costOf(core: TaskCore, price: RoundTripPrice | null): CostView {
  const cost = core.reading?.cost;
  if (cost && cost.pricedRuns > 0) {
    return {
      kind: "measured",
      perRun: cost.medianUsd,
      total: cost.totalUsd,
      runs: cost.pricedRuns,
      modelCalls: cost.medianModelCalls,
    };
  }
  const reading = core.reading;
  if (reading && reading.runs > 0 && price?.usd != null && price.usd > 0) {
    // One model round-trip per tool call (the model emits the call, then reads it), at the project's price.
    const callsPerRun = reading.calls / reading.runs;
    const perRun = callsPerRun * price.usd;
    return { kind: "estimated", perRun, total: perRun * reading.runs, callsPerRun };
  }
  return { kind: "none" };
}

function correctionRows(
  corrections: NonNullable<TaskCore["corrections"]>,
  runs: number,
): CorrectionRow[] {
  return CORRECTION_KINDS.flatMap((kind) => {
    const count = corrections.byKind[kind] ?? 0;
    // Asked again and phrases are only read where they are recorded; from steps alone they are not measured.
    if (corrections.source === "steps" && (kind === "asked_again" || kind === "phrase")) return [];
    return [
      {
        kind,
        label: CORRECTION_LABEL[kind],
        count,
        per100: runs > 0 ? (count * 100) / runs : null,
      },
    ];
  });
}

function flowOf(reading: TaskReading | null): TaskDetailModel["flow"] {
  if (!reading) return { edges: [], tools: [] };
  const edges = reading.steps.flatMap((step) =>
    step.next.flatMap((next) =>
      next.toolId === null ? [] : [{ a: step.toolId, b: next.toolId, n: next.n, na: step.nextOf }],
    ),
  );
  return {
    edges,
    tools: reading.steps
      .filter((step) => step.runs > 0)
      .map((step) => ({ toolId: step.toolId, n: step.runs })),
  };
}

export function buildTaskDetail(
  inputs: TasksInputs,
  taskId: string,
  options: TaskFixesOption = {},
): TaskDetailModel | null {
  const { cores } = coresOf(inputs);
  const core = cores.find((candidate) => candidate.id === taskId);
  if (!core || !inputs.run) return null;
  const { item, reading } = core;
  const windowDays = inputs.run.windowDays;
  const label = nameOf(inputs.names);
  const failingIssue = core.issues.some(
    ({ record }) => record.subjectKind === "workflow" && record.kind === "workflow_failing",
  );
  const slowIssue = core.issues.some(
    ({ record }) => record.subjectKind === "workflow" && record.kind === "workflow_slow",
  );
  const marks = {
    failing:
      core.weakest &&
      (failingIssue ||
        (core.weakest.calls >= WATCH.stepMinCalls &&
          core.weakest.failureShare >= WATCH.stepFailureShare))
        ? core.weakest.toolId
        : null,
    slow: slowIssue ? (item.health.slowestStep?.toolId ?? null) : null,
  };
  const order = item.typicalOrder;
  const steps = reading
    ? reading.steps
        .filter((step) => step.role === "core")
        .map((step) =>
          stepView(step, core.runs, label, marks, order.indexOf(step.toolId) + 1 || null),
        )
    : order.map((id, i) => bareStep(id, "core", label, i + 1));
  const sideSteps = reading
    ? reading.steps
        .filter((step) => step.role !== "core" && step.runs > 0)
        .map((step) => stepView(step, core.runs, label, marks, null))
    : [
        ...item.optionalTools.map((id) => bareStep(id, "optional", label, null)),
        ...item.helperTools.map((id) => bareStep(id, "helper", label, null)),
      ];
  const allRuns = inputs.run.turnsScanned;
  const corrections = core.corrections
    ? {
        source: core.corrections.source,
        rows: correctionRows(core.corrections, core.runs),
        total: core.corrections.events,
        per100: core.correctionsPer100,
      }
    : null;
  return {
    id: core.id,
    name: core.name,
    description: core.description,
    icon: core.icon,
    color: core.color,
    status: core.status,
    watch: core.watch,
    statusLine: statusLine(core, windowDays, inputs.names, inputs.labels),
    windowDays,
    readAt: inputs.run.finishedAt,
    runs: core.runs,
    share: allRuns > 0 ? Math.min(1, core.runs / allRuns) : null,
    finishRate: core.finishRate,
    finishedRuns: core.finishedRuns,
    askedNoTool: core.askedNoTool,
    recoveredRuns: reading?.recoveredRuns ?? null,
    medianMs: item.health.medianMs,
    correctionsPer100: core.correctionsPer100,
    callsPerRun: reading && reading.runs > 0 ? reading.calls / reading.runs : null,
    cost: costOf(core, inputs.price),
    hasReading: reading !== null,
    order: {
      stability: item.orderStability,
      fixed: runsInFixedOrder({
        runs: core.runs,
        coreTools: item.coreTools,
        orderStability: item.orderStability,
      }),
    },
    steps,
    sideSteps,
    flow: flowOf(reading),
    topics: inputs.topics ? [...(inputs.topics.get(core.id) ?? [])] : null,
    corrections,
    issues: foldIssues(
      [...core.issues]
        .sort(
          (a, b) =>
            Number(b.record.subjectKind === "workflow") -
              Number(a.record.subjectKind === "workflow") || b.record.severity - a.record.severity,
        )
        .map((source) =>
          issueView(source, {
            projectId: inputs.projectId,
            taskId: core.id,
            names: inputs.names,
            labels: inputs.labels,
            windowDays,
            fixes: options.fixes ?? null,
          }),
        ),
    ),
    fixes: taskFixViews({
      projectId: inputs.projectId,
      taskId: core.id,
      fixes: options.fixes,
      drafts: core.fixes,
      names: inputs.names,
    }),
    allFixesHref: fixesHref(inputs.projectId, { task: core.id }),
    examples: workflowExamples(item, 6),
    focusTools: [...order, ...item.optionalTools].slice(0, 8),
  };
}

/** The task names by id, for pages that only link to tasks. */
export function taskNames(
  stored: unknown,
  labels: WorkflowLabels,
  names: ReadonlyMap<string, string>,
): Map<string, string> {
  const parsed = parseStoredWorkflows(stored);
  return new Map(
    (parsed?.items ?? []).map((item) => [
      item.id,
      workflowDisplayName({ id: item.id, typicalOrder: item.typicalOrder }, names, labels),
    ]),
  );
}

/** A task's steps as one line ("find_task > assign_task"), for places with no room for the drawing. */
export function stepsLine(steps: readonly Pick<StepView, "label">[]): string {
  return steps.map((step) => step.label).join(WORKFLOW_NAME_SEPARATOR);
}
