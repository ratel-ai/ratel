import type { StepDraft } from "@/lib/ledger/types";
import { detectAfterErrors } from "../self-corrections/detect";
import { quantile, Reservoir } from "../signals/severity";
import { isInvoke } from "../signals/turn-facts";
import type { SignalTurn } from "../signals/types";
import { type PublicStepKind, stepKindOf } from "./kind";

/**
 * Agent health per step kind (RC-1077, `cloud-typed-steps`): pure readings of
 * the window's runs, one table per public step kind. The signal run feeds the
 * same in-window runs it reads (same basis, same filters), and stores the
 * result as `summary.steps`. Counts, rates and names only; never content.
 */

/** What ingest stored for one model call, by its `trace_events` id. */
export interface ModelCallFact {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  finishReason: string | null;
}

export interface StepMetricInputs {
  modelCalls?: ReadonlyMap<string, ModelCallFact>;
}

export interface ModelCallReading {
  calls: number;
  /** Runs read in the window (every run, not only those with a model call). */
  runs: number;
  callsPerRun: number;
  errors: number;
  errorRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Null when no call was priced. */
  costUsd: number | null;
  pricedCalls: number;
  /** Calls that stopped at the token limit or the content filter, of the calls with a known finish reason. */
  finish: { length: number; contentFilter: number; known: number };
  /** Failed calls of a model step that ran again later in the run. */
  retries: number;
}

/** Tool and skill calls: the numbers Agent health reads for tools today. */
export interface CallReading {
  calls: number;
  errors: number;
  errorRate: number;
  p95Ms: number | null;
  retries: number;
  switches: number;
  giveUps: number;
}

export interface CodeReading {
  calls: number;
  errors: number;
  errorRate: number;
  p95Ms: number | null;
  /** Time in code steps over the wall time of the runs that ran code. */
  runTimeShare: number | null;
}

export interface HandoffRoute {
  /** The agent that handed off; null when the run does not name one. */
  from: string | null;
  to: string;
  count: number;
  /** Handoffs whose receiving agent run failed. */
  errors: number;
}

export interface HandoffReading {
  count: number;
  errors: number;
  /** Error rate of the receiving agent runs. */
  errorRate: number;
  /** Most taken first, at most {@link MAX_ROUTES}. */
  routes: HandoffRoute[];
}

export interface UserMessageReading {
  messages: number;
  /** Task segments read, or runs with a message when no segments are stored. */
  segments: number;
  perSegment: number;
  /** Runs whose sentiment was read; null when none was. */
  sentiment: { positive: number; neutral: number; negative: number; read: number } | null;
  /** Runs that asked the last run's question again, of the runs whose ask was read; null when none was. */
  askedAgain: { runs: number; read: number; share: number } | null;
}

export interface StepKindReadings {
  model_call: ModelCallReading | null;
  tool_call: CallReading | null;
  skill: CallReading | null;
  code: CodeReading | null;
  handoff: HandoffReading | null;
  user_message: UserMessageReading | null;
}

export interface WeakestStep {
  kind: PublicStepKind;
  name: string;
  calls: number;
  errors: number;
  errorRate: number;
}

/** One task's segments (`task_segments`) in the window. */
export interface TaskReading {
  workflowId: string;
  runs: number;
  /** Segments whose last executed step did not fail. */
  finished: number;
  finishRate: number;
  /** Null when no model call of the task was priced. */
  costPerRun: number | null;
  p50DurationMs: number | null;
  /** Retries, switches and give-ups after a failed step, per 100 segments. */
  selfCorrectionsPer100: number;
  /** The step with the highest error rate; null when no step failed. */
  weakestStep: WeakestStep | null;
}

export interface StepReadings {
  version: 1;
  /** Runs read in the window. */
  runs: number;
  kinds: StepKindReadings;
  /** Most runs first, at most {@link MAX_TASKS}. */
  tasks: TaskReading[];
}

/** What the topics reading stored for one run (`trace_turn_topics`). */
export interface RunTopicFact {
  sentiment: "positive" | "neutral" | "negative" | null;
  /** The run asks the last run's question again (verdict `retry`). */
  askedAgain: boolean;
}

/** One `task_segments` row, as much of it as the readings need. */
export interface SegmentFact {
  workflowId: string;
  startTurnId: string;
  startOrdinal: number;
  endTurnId: string;
  endOrdinal: number;
  startedAt: Date;
  endedAt: Date;
  turnIds: readonly string[];
}

/** Read after the run's segments are written. */
export interface StepFinishInputs {
  segments?: readonly SegmentFact[];
  topics?: ReadonlyMap<string, RunTopicFact>;
}

export interface StepMetrics {
  add(turn: SignalTurn): void;
  finish(inputs?: StepFinishInputs): StepReadings;
}

/** Latency samples kept per kind: enough for a stable p95, bounded in memory. */
const LATENCY_SAMPLES = 10_000;
export const MAX_ROUTES = 20;
export const MAX_TASKS = 50;
/** Runs kept for the task readings; segments of runs past the cap are not read. */
export const MAX_TASK_RUNS = 20_000;

/** Collect per-kind readings over a stream of in-window runs. */
export function createStepMetrics(inputs: StepMetricInputs = {}): StepMetrics {
  let runs = 0;
  const models = createModelStats();
  const tools = createCallStats("tool_call");
  const skills = createCallStats("skill");
  const code = createCodeStats();
  const handoffs = createHandoffStats();
  const messages = createMessageStats();
  const compact = new Map<string, readonly CompactStep[]>();
  return {
    add(turn) {
      runs += 1;
      addModelCalls(models, turn.steps, inputs.modelCalls);
      addInvokes(tools, skills, turn.steps);
      addCode(code, turn);
      addHandoffs(handoffs, turn.steps);
      addMessages(messages, turn);
      if (compact.size < MAX_TASK_RUNS)
        compact.set(turn.id, compactSteps(turn.steps, inputs.modelCalls));
    },
    finish(extras = {}) {
      return {
        version: 1,
        runs,
        kinds: {
          model_call: finishModelCalls(models, runs),
          tool_call: finishCalls(tools),
          skill: finishCalls(skills),
          code: finishCode(code),
          handoff: finishHandoffs(handoffs),
          user_message: finishMessages(messages, extras),
        },
        tasks: taskReadings(extras.segments ?? [], compact),
      };
    },
  };
}

/** Readings of an in-memory list of runs (tests, replay). */
export function stepReadingsOf(
  turns: readonly SignalTurn[],
  inputs: StepMetricInputs = {},
  extras: StepFinishInputs = {},
): StepReadings {
  const metrics = createStepMetrics(inputs);
  for (const turn of turns) metrics.add(turn);
  return metrics.finish(extras);
}

/* - Model calls --------------------------------------------------------------- */

interface ModelStats {
  calls: number;
  errors: number;
  latency: Reservoir<number>;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  pricedCalls: number;
  finish: { length: number; contentFilter: number; known: number };
  retries: number;
}

function createModelStats(): ModelStats {
  return {
    calls: 0,
    errors: 0,
    latency: new Reservoir(LATENCY_SAMPLES, "steps:model_call"),
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    pricedCalls: 0,
    finish: { length: 0, contentFilter: 0, known: 0 },
    retries: 0,
  };
}

function addModelCalls(
  stats: ModelStats,
  steps: readonly StepDraft[],
  facts: ReadonlyMap<string, ModelCallFact> | undefined,
): void {
  const calls = steps.filter((step) => step.kind === "model_call");
  for (const call of calls) {
    stats.calls += 1;
    if (call.outcome === "error") stats.errors += 1;
    if (call.tookMs !== null) stats.latency.add(call.tookMs);
    const fact = facts?.get(call.traceEventId);
    if (!fact) continue;
    stats.inputTokens += fact.inputTokens ?? 0;
    stats.outputTokens += fact.outputTokens ?? 0;
    stats.reasoningTokens += fact.reasoningTokens ?? 0;
    if (fact.costUsd !== null) {
      stats.costUsd += fact.costUsd;
      stats.pricedCalls += 1;
    }
    if (fact.finishReason) {
      stats.finish.known += 1;
      if (fact.finishReason === "length") stats.finish.length += 1;
      if (fact.finishReason === "content_filter") stats.finish.contentFilter += 1;
    }
  }
  stats.retries += countAfterErrors(
    calls.map((call) => ({
      ordinal: call.ordinal,
      node: call.targetId ?? "",
      failed: call.outcome === "error",
    })),
  ).retries;
}

function finishModelCalls(stats: ModelStats, runs: number): ModelCallReading | null {
  if (stats.calls === 0) return null;
  const latency = stats.latency.values();
  return {
    calls: stats.calls,
    runs,
    callsPerRun: runs > 0 ? stats.calls / runs : 0,
    errors: stats.errors,
    errorRate: stats.errors / stats.calls,
    p50Ms: quantile(latency, 0.5),
    p95Ms: quantile(latency, 0.95),
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    reasoningTokens: stats.reasoningTokens,
    costUsd: stats.pricedCalls > 0 ? stats.costUsd : null,
    pricedCalls: stats.pricedCalls,
    finish: { ...stats.finish },
    retries: stats.retries,
  };
}

/* - Tool and skill calls ------------------------------------------------------- */

interface CallStats {
  calls: number;
  errors: number;
  latency: Reservoir<number>;
  retries: number;
  switches: number;
  giveUps: number;
}

function createCallStats(kind: string): CallStats {
  return {
    calls: 0,
    errors: 0,
    latency: new Reservoir(LATENCY_SAMPLES, `steps:${kind}`),
    retries: 0,
    switches: 0,
    giveUps: 0,
  };
}

/**
 * Tool and skill calls as today's readings count them: an invocation with a
 * target (`isInvoke`), and the after-error events of `detectAfterErrors` over
 * the run, each counted for the kind of the call that failed.
 */
function addInvokes(tools: CallStats, skills: CallStats, steps: readonly StepDraft[]): void {
  for (const step of steps.filter(isInvoke)) {
    const stats = step.targetType === "skill" ? skills : tools;
    stats.calls += 1;
    if (step.outcome === "error") stats.errors += 1;
    if (step.tookMs !== null) stats.latency.add(step.tookMs);
  }
  for (const event of detectAfterErrors(steps)) {
    const stats = event.tool?.startsWith("skill:") ? skills : tools;
    if (event.kind === "retry_after_error") stats.retries += 1;
    else if (event.kind === "switch_after_error") stats.switches += 1;
    else if (event.kind === "gave_up_after_error") stats.giveUps += 1;
  }
}

function finishCalls(stats: CallStats): CallReading | null {
  if (stats.calls === 0) return null;
  return {
    calls: stats.calls,
    errors: stats.errors,
    errorRate: stats.errors / stats.calls,
    p95Ms: quantile(stats.latency.values(), 0.95),
    retries: stats.retries,
    switches: stats.switches,
    giveUps: stats.giveUps,
  };
}

/* - Code steps ------------------------------------------------------------------ */

interface CodeStats {
  calls: number;
  errors: number;
  latency: Reservoir<number>;
  codeMs: number;
  runMs: number;
}

function createCodeStats(): CodeStats {
  return {
    calls: 0,
    errors: 0,
    latency: new Reservoir(LATENCY_SAMPLES, "steps:code"),
    codeMs: 0,
    runMs: 0,
  };
}

/** Code steps are spans with status 2 when they fail (`otlp/derive-steps.ts`). */
function addCode(stats: CodeStats, turn: SignalTurn): void {
  const steps = turn.steps.filter((step) => step.kind === "code");
  if (steps.length === 0) return;
  for (const step of steps) {
    stats.calls += 1;
    if (step.outcome === "error") stats.errors += 1;
    if (step.tookMs !== null) {
      stats.latency.add(step.tookMs);
      stats.codeMs += step.tookMs;
    }
  }
  stats.runMs += Math.max(0, turn.endedAt.getTime() - turn.startedAt.getTime());
}

function finishCode(stats: CodeStats): CodeReading | null {
  if (stats.calls === 0) return null;
  return {
    calls: stats.calls,
    errors: stats.errors,
    errorRate: stats.errors / stats.calls,
    p95Ms: quantile(stats.latency.values(), 0.95),
    runTimeShare: stats.runMs > 0 ? Math.min(1, stats.codeMs / stats.runMs) : null,
  };
}

/* - Handoffs -------------------------------------------------------------------- */

interface HandoffStats {
  count: number;
  errors: number;
  routes: Map<string, HandoffRoute>;
}

function createHandoffStats(): HandoffStats {
  return { count: 0, errors: 0, routes: new Map() };
}

/**
 * A handoff goes from the agent that holds the run: the last agent handed to
 * in the run, else the run's own agent (its `agent` step), else none named.
 */
function addHandoffs(stats: HandoffStats, steps: readonly StepDraft[]): void {
  let holder: string | null = null;
  for (const step of steps) {
    if (step.kind === "agent" && holder === null) holder = step.targetId;
    if (step.kind !== "handoff" || step.targetId === null) continue;
    const failed = step.outcome === "error";
    stats.count += 1;
    if (failed) stats.errors += 1;
    const key = JSON.stringify([holder, step.targetId]);
    const route = stats.routes.get(key) ?? { from: holder, to: step.targetId, count: 0, errors: 0 };
    route.count += 1;
    if (failed) route.errors += 1;
    stats.routes.set(key, route);
    holder = step.targetId;
  }
}

function finishHandoffs(stats: HandoffStats): HandoffReading | null {
  if (stats.count === 0) return null;
  const routes = [...stats.routes.values()]
    .sort(
      (a, b) =>
        b.count - a.count || (a.from ?? "").localeCompare(b.from ?? "") || a.to.localeCompare(b.to),
    )
    .slice(0, MAX_ROUTES)
    .map((route) => ({ ...route }));
  return {
    count: stats.count,
    errors: stats.errors,
    errorRate: stats.errors / stats.count,
    routes,
  };
}

/* - User messages ----------------------------------------------------------------- */

interface MessageStats {
  messages: number;
  /** Runs with a message, by id: their message counts. */
  runs: Map<string, number>;
}

function createMessageStats(): MessageStats {
  return { messages: 0, runs: new Map() };
}

function addMessages(stats: MessageStats, turn: SignalTurn): void {
  const count = turn.steps.filter((step) => step.kind === "user_message").length;
  if (count === 0) return;
  stats.messages += count;
  stats.runs.set(turn.id, count);
}

function finishMessages(stats: MessageStats, extras: StepFinishInputs): UserMessageReading | null {
  if (stats.messages === 0) return null;
  const segments = extras.segments?.length ? extras.segments.length : stats.runs.size;
  const read = [...stats.runs.keys()].flatMap((id) => {
    const topic = extras.topics?.get(id);
    return topic ? [topic] : [];
  });
  const felt = read.filter((topic) => topic.sentiment !== null);
  const asked = read.filter((topic) => topic.askedAgain).length;
  return {
    messages: stats.messages,
    segments,
    perSegment: stats.messages / segments,
    sentiment:
      felt.length === 0
        ? null
        : {
            positive: felt.filter((topic) => topic.sentiment === "positive").length,
            neutral: felt.filter((topic) => topic.sentiment === "neutral").length,
            negative: felt.filter((topic) => topic.sentiment === "negative").length,
            read: felt.length,
          },
    askedAgain:
      read.length === 0 ? null : { runs: asked, read: read.length, share: asked / read.length },
  };
}

/* - Tasks ------------------------------------------------------------------------- */

interface CompactStep {
  ordinal: number;
  kind: PublicStepKind;
  name: string;
  failed: boolean;
  costUsd: number | null;
}

/** What the task readings keep of a run: its typed steps, without times. */
function compactSteps(
  steps: readonly StepDraft[],
  facts: ReadonlyMap<string, ModelCallFact> | undefined,
): CompactStep[] {
  return steps.flatMap((step) => {
    const kind = stepKindOf(step);
    if (kind === null) return [];
    return [
      {
        ordinal: step.ordinal,
        kind,
        name: step.targetId ?? kind,
        failed: step.outcome === "error",
        costUsd: kind === "model_call" ? (facts?.get(step.traceEventId)?.costUsd ?? null) : null,
      },
    ];
  });
}

function segmentSteps(
  segment: SegmentFact,
  runs: ReadonlyMap<string, readonly CompactStep[]>,
): CompactStep[] | null {
  let known = false;
  const steps = segment.turnIds.flatMap((turnId) => {
    const run = runs.get(turnId);
    if (!run) return [];
    known = true;
    return run.filter(
      (step) =>
        (turnId !== segment.startTurnId || step.ordinal >= segment.startOrdinal) &&
        (turnId !== segment.endTurnId || step.ordinal <= segment.endOrdinal),
    );
  });
  return known ? steps : null;
}

interface TaskStats {
  runs: number;
  finished: number;
  costUsd: number;
  priced: number;
  durations: number[];
  corrections: number;
  steps: Map<string, WeakestStep>;
}

function taskReadings(
  segments: readonly SegmentFact[],
  runs: ReadonlyMap<string, readonly CompactStep[]>,
): TaskReading[] {
  const tasks = new Map<string, TaskStats>();
  for (const segment of segments) {
    const steps = segmentSteps(segment, runs);
    if (steps === null) continue;
    const task: TaskStats = tasks.get(segment.workflowId) ?? {
      runs: 0,
      finished: 0,
      costUsd: 0,
      priced: 0,
      durations: [],
      corrections: 0,
      steps: new Map(),
    };
    const executed = steps.filter((step) => step.kind !== "user_message");
    task.runs += 1;
    if (!executed.at(-1)?.failed) task.finished += 1;
    task.durations.push(Math.max(0, segment.endedAt.getTime() - segment.startedAt.getTime()));
    const corrections = countAfterErrors(
      executed.map((step, i) => ({
        ordinal: i + 1,
        node: `${step.kind}:${step.name}`,
        failed: step.failed,
      })),
    );
    task.corrections += corrections.retries + corrections.switches + corrections.giveUps;
    for (const step of executed) {
      if (step.costUsd !== null) {
        task.costUsd += step.costUsd;
        task.priced += 1;
      }
      const key = `${step.kind}:${step.name}`;
      const entry = task.steps.get(key) ?? {
        kind: step.kind,
        name: step.name,
        calls: 0,
        errors: 0,
        errorRate: 0,
      };
      entry.calls += 1;
      if (step.failed) entry.errors += 1;
      entry.errorRate = entry.errors / entry.calls;
      task.steps.set(key, entry);
    }
    tasks.set(segment.workflowId, task);
  }
  return [...tasks.entries()]
    .map(
      ([workflowId, task]): TaskReading => ({
        workflowId,
        runs: task.runs,
        finished: task.finished,
        finishRate: task.finished / task.runs,
        costPerRun: task.priced > 0 ? task.costUsd / task.runs : null,
        p50DurationMs: quantile(task.durations, 0.5),
        selfCorrectionsPer100: (task.corrections / task.runs) * 100,
        weakestStep: weakestOf(task.steps.values()),
      }),
    )
    .sort((a, b) => b.runs - a.runs || a.workflowId.localeCompare(b.workflowId))
    .slice(0, MAX_TASKS);
}

function weakestOf(steps: Iterable<WeakestStep>): WeakestStep | null {
  let weakest: WeakestStep | null = null;
  for (const step of steps) {
    if (step.errors === 0) continue;
    if (
      !weakest ||
      step.errorRate > weakest.errorRate ||
      (step.errorRate === weakest.errorRate && step.calls > weakest.calls)
    )
      weakest = step;
  }
  return weakest ? { ...weakest } : null;
}

/* - Shared -------------------------------------------------------------------- */

interface AfterErrorCounts {
  retries: number;
  switches: number;
  giveUps: number;
}

interface Call {
  ordinal: number;
  node: string;
  failed: boolean;
}

/**
 * Retries, switches and give-ups among calls, with the self-corrections rules
 * (`self-corrections/detect.ts`), each call read as a call of its node.
 */
function countAfterErrors(calls: readonly Call[]): AfterErrorCounts {
  const asSteps = calls.map(
    (call) =>
      ({
        ordinal: call.ordinal,
        kind: "invoke",
        targetType: "tool",
        targetId: call.node,
        outcome: call.failed ? "error" : "ok",
      }) as StepDraft,
  );
  const counts = { retries: 0, switches: 0, giveUps: 0 };
  for (const event of detectAfterErrors(asSteps)) {
    if (event.kind === "retry_after_error") counts.retries += 1;
    else if (event.kind === "switch_after_error") counts.switches += 1;
    else if (event.kind === "gave_up_after_error") counts.giveUps += 1;
  }
  return counts;
}
