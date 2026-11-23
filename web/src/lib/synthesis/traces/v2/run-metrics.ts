/**
 * What makes agent runs comparable (AOBS-7): where a
 * run's time went (the model, the tools, a person), how its context grew with
 * each request, how much of its input came from the cache, where it ran, and
 * what happened around its tool calls (a compaction, a permission decision, a
 * hook, a wait for a person).
 *
 * Built from the run's spans, like the run summary and the agent rollup, so
 * it needs no stored rollup. The attributes are the ones the Beluga exporter
 * sends (`ratel.run.*`, `ratel.context.*`, `ratel.wait.*`) and the events are
 * the ones `otel_spans.events` keeps. A run with none of them still gets its
 * time split, context sizes and cache hit rate from the spans alone.
 */

import { formatDuration, formatInteger } from "./format";
import { stringAttribute } from "./span-kind";

/** A stored span event, as `otel_spans.events` keeps it. */
export interface RunMetricsEvent {
  name: string;
  timeUnixMs: number;
  attributes: Readonly<Record<string, unknown>>;
}

/** The span fields the metrics read: a subset of both `OtelSpan` and `TraceSpanView`. */
export interface RunMetricsSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  spanClass: string;
  startedAt: Date | string;
  durationMs: number;
  statusCode: number;
  inputTokens: number | null;
  cachedTokens: number | null;
  attributes: Readonly<Record<string, unknown>>;
  events?: readonly RunMetricsEvent[] | null;
}

/** Where a run's wall-clock time went. The three parts add up to the total. */
export interface RunTimeSplit {
  totalMs: number;
  /** Time with at least one model call open; calls that overlap count once. */
  modelMs: number;
  /** Time the agent waited for a person: an approval, a question, a plan. */
  humanWaitMs: number;
  /** The rest: tools, hooks and the harness itself. */
  toolMs: number;
}

/** One model request, in start order. */
export interface RunRequest {
  spanId: string;
  /** `ratel.context.tokens`, else the request's input tokens. */
  contextTokens: number;
  /** `ratel.context.window`: only the main agent's requests carry it. */
  contextWindow: number | null;
  agent: string | null;
  /** A request of the run's own agent, not of a sub-agent. */
  mainAgent: boolean;
}

export interface RunContext {
  repo: string | null;
  branch: string | null;
  worktree: string | null;
  task: string | null;
  pr: number | null;
  harness: string | null;
  harnessVersion: string | null;
  effort: string | null;
  permissionMode: string | null;
  /** `ok`, `error` or `stopped`. */
  outcome: string | null;
}

export interface RunCounter {
  key: string;
  label: string;
  value: number;
}

export type RunEventKind = "compaction" | "permission" | "hook" | "wait";

/** Something that happened around the run's steps, on the span that carried it. */
export interface RunEvent {
  kind: RunEventKind;
  spanId: string;
  /** Milliseconds from the run's start. */
  offsetMs: number;
  label: string;
  detail: string;
  tone: "neutral" | "warning";
}

/** A step's wait for a person (`ratel.wait.*`). A refused wait is not a failure. */
export interface SpanWait {
  kind: string | null;
  outcome: string;
  humanMs: number | null;
  label: string;
  /** Declined, skipped or timed out: the step did not run as asked. */
  refused: boolean;
}

export interface RunMetrics {
  context: RunContext | null;
  /** The root's own counts, in a fixed order; a count the run did not send is left out. */
  counters: RunCounter[];
  timeSplit: RunTimeSplit | null;
  requests: RunRequest[];
  contextWindow: number | null;
  /** The largest context of a main-agent request. */
  peakContextTokens: number | null;
  cache: { inputTokens: number; cachedTokens: number; hitRate: number } | null;
  events: RunEvent[];
  eventCounts: Record<RunEventKind, number>;
  /** Nothing to show: no model call, no run attribute and no event. */
  empty: boolean;
}

const RUN = "ratel.run.";
const COUNTERS: readonly { key: string; label: string }[] = [
  { key: "tool_calls", label: "Tool calls" },
  { key: "tool_errors", label: "Tool errors" },
  { key: "subagents", label: "Sub-agents" },
  { key: "compactions", label: "Compactions" },
  { key: "human_waits", label: "Waits for a person" },
  { key: "hooks", label: "Hooks" },
  { key: "commits", label: "Commits" },
  { key: "prs_opened", label: "Pull requests opened" },
  { key: "test_runs", label: "Test runs" },
  { key: "test_failures", label: "Failed test runs" },
  { key: "thinking_tokens", label: "Thinking tokens" },
];
const EVENT_KIND: Readonly<Record<string, RunEventKind>> = {
  "ratel.compaction": "compaction",
  "ratel.permission.decision": "permission",
  "ratel.hook": "hook",
  "ratel.human.wait": "wait",
};
const WAIT_OUTCOME_LABEL: Readonly<Record<string, string>> = {
  approved: "Approved",
  declined: "Declined",
  answered: "Answered",
  skipped: "Skipped",
  timeout: "No answer in time",
};
const REFUSED: ReadonlySet<string> = new Set(["declined", "skipped", "timeout"]);
const HOOK_TROUBLE: ReadonlySet<string> = new Set(["blocked", "error", "cancelled"]);

export function buildRunMetrics(spans: readonly RunMetricsSpan[]): RunMetrics {
  const root = spans.find((span) => span.parentSpanId === null) ?? spans[0];
  const modelCalls = spans.filter((span) => span.spanClass === "llm_call").sort(byStart);
  const startMs = spans.length > 0 ? Math.min(...spans.map(startOf)) : 0;
  const context = root ? runContext(root.attributes) : null;
  const counters = root ? runCounters(root.attributes) : [];
  const requests = runRequests(modelCalls, root);
  const mainRequests = requests.filter((request) => request.mainAgent);
  const events = runEvents(spans, startMs);
  return {
    context,
    counters,
    timeSplit: root ? timeSplit(root, spans, modelCalls) : null,
    requests,
    contextWindow: mainRequests.reduce<number | null>(
      (max, request) => maxOf(max, request.contextWindow),
      null,
    ),
    peakContextTokens: mainRequests.reduce<number | null>(
      (max, request) => maxOf(max, request.contextTokens),
      null,
    ),
    cache: cacheUse(modelCalls),
    events,
    eventCounts: {
      compaction: events.filter((event) => event.kind === "compaction").length,
      permission: events.filter((event) => event.kind === "permission").length,
      hook: events.filter((event) => event.kind === "hook").length,
      wait: events.filter((event) => event.kind === "wait").length,
    },
    empty:
      modelCalls.length === 0 && context === null && counters.length === 0 && events.length === 0,
  };
}

/** The step's wait for a person, or null when it did not wait. */
export function spanWait(
  attributes: Readonly<Record<string, unknown>> | undefined,
): SpanWait | null {
  const outcome = stringAttribute(attributes, "ratel.wait.outcome");
  if (!outcome) return null;
  return {
    kind: stringAttribute(attributes, "ratel.wait.kind"),
    outcome,
    humanMs: numberAttribute(attributes, "ratel.wait.human_ms"),
    label: WAIT_OUTCOME_LABEL[outcome] ?? outcome,
    refused: REFUSED.has(outcome),
  };
}

/** A hook that ran without trouble: routine, so a list shows it after the other events or folds it away. */
export function isRoutineHook(event: RunEvent): boolean {
  return event.kind === "hook" && event.tone === "neutral";
}

function timeSplit(
  root: RunMetricsSpan,
  spans: readonly RunMetricsSpan[],
  modelCalls: readonly RunMetricsSpan[],
): RunTimeSplit | null {
  if (modelCalls.length === 0) return null;
  const totalMs = Math.max(0, root.durationMs);
  if (totalMs === 0) return null;
  const rootStart = startOf(root);
  const waited =
    numberAttribute(root.attributes, `${RUN}human_wait_ms`) ??
    spans.reduce(
      (sum, span) =>
        sum + (span === root ? 0 : (numberAttribute(span.attributes, "ratel.wait.human_ms") ?? 0)),
      0,
    );
  const humanWaitMs = Math.min(totalMs, Math.max(0, waited));
  // A model call that spans the wait (one call for the whole turn) gives the wait back.
  const modelMs = Math.min(
    unionMs(modelCalls, rootStart, rootStart + totalMs),
    totalMs - humanWaitMs,
  );
  return { totalMs, modelMs, humanWaitMs, toolMs: totalMs - modelMs - humanWaitMs };
}

/** The length of the union of the spans' intervals, inside the window. */
function unionMs(spans: readonly RunMetricsSpan[], windowStart: number, windowEnd: number): number {
  let total = 0;
  let openEnd = windowStart;
  for (const span of spans) {
    const start = Math.max(startOf(span), openEnd);
    const end = Math.min(startOf(span) + Math.max(0, span.durationMs), windowEnd);
    if (end > start) {
      total += end - start;
      openEnd = end;
    }
  }
  return total;
}

function runRequests(
  modelCalls: readonly RunMetricsSpan[],
  root: RunMetricsSpan | undefined,
): RunRequest[] {
  const mainAgent = root ? stringAttribute(root.attributes, "gen_ai.agent.name") : null;
  return modelCalls.flatMap((span): RunRequest[] => {
    const contextTokens =
      numberAttribute(span.attributes, "ratel.context.tokens") ?? span.inputTokens;
    if (contextTokens === null) return [];
    const agent = stringAttribute(span.attributes, "gen_ai.agent.name");
    return [
      {
        spanId: span.spanId,
        contextTokens,
        contextWindow: numberAttribute(span.attributes, "ratel.context.window"),
        agent,
        mainAgent: agent === null || mainAgent === null || agent === mainAgent,
      },
    ];
  });
}

function cacheUse(modelCalls: readonly RunMetricsSpan[]): RunMetrics["cache"] {
  let inputTokens = 0;
  let cachedTokens = 0;
  for (const span of modelCalls) {
    const input = Math.max(0, span.inputTokens ?? 0);
    inputTokens += input;
    // Cached tokens are a part of the input tokens.
    cachedTokens += Math.min(input, Math.max(0, span.cachedTokens ?? 0));
  }
  return inputTokens > 0
    ? { inputTokens, cachedTokens, hitRate: cachedTokens / inputTokens }
    : null;
}

function runContext(attributes: Readonly<Record<string, unknown>>): RunContext | null {
  const context: RunContext = {
    repo: stringAttribute(attributes, `${RUN}repo`),
    branch: stringAttribute(attributes, `${RUN}branch`),
    worktree: stringAttribute(attributes, `${RUN}worktree`),
    task: stringAttribute(attributes, `${RUN}task`),
    pr: numberAttribute(attributes, `${RUN}pr`),
    harness: stringAttribute(attributes, "ratel.harness.name"),
    harnessVersion: stringAttribute(attributes, "ratel.harness.version"),
    effort: stringAttribute(attributes, "ratel.harness.effort"),
    permissionMode: stringAttribute(attributes, "ratel.harness.permission_mode"),
    outcome: stringAttribute(attributes, `${RUN}outcome`),
  };
  return Object.values(context).some((value) => value !== null) ? context : null;
}

function runCounters(attributes: Readonly<Record<string, unknown>>): RunCounter[] {
  return COUNTERS.flatMap((counter): RunCounter[] => {
    const value = numberAttribute(attributes, `${RUN}${counter.key}`);
    return value === null ? [] : [{ ...counter, value }];
  });
}

function runEvents(spans: readonly RunMetricsSpan[], startMs: number): RunEvent[] {
  const events: RunEvent[] = [];
  for (const span of spans) {
    for (const event of span.events ?? []) {
      const kind = EVENT_KIND[event.name];
      if (!kind) continue;
      events.push({
        kind,
        spanId: span.spanId,
        offsetMs: Math.max(0, event.timeUnixMs - startMs),
        ...describe(kind, event.attributes),
      });
    }
  }
  return events.sort((a, b) => a.offsetMs - b.offsetMs);
}

function describe(
  kind: RunEventKind,
  attributes: Readonly<Record<string, unknown>>,
): Pick<RunEvent, "label" | "detail" | "tone"> {
  const text = (key: string) => stringAttribute(attributes, key);
  const number = (key: string) => numberAttribute(attributes, key);
  const join = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(", ");
  switch (kind) {
    case "compaction": {
      const before = number("ratel.compaction.pre_tokens");
      const after = number("ratel.compaction.post_tokens");
      return {
        label: "Context compacted",
        detail: join([
          before !== null &&
            after !== null &&
            `${formatInteger(before)} to ${formatInteger(after)} tokens`,
          text("ratel.compaction.trigger"),
        ]),
        tone: "neutral",
      };
    }
    case "hook": {
      const outcome = text("ratel.hook.outcome");
      const duration = number("ratel.hook.duration_ms");
      const count = number("ratel.hook.count");
      return {
        label: `Hook ${text("ratel.hook.name") ?? text("ratel.hook.event") ?? ""}`.trim(),
        detail: join([
          text("ratel.hook.name") ? text("ratel.hook.event") : null,
          outcome,
          duration !== null && formatDuration(duration),
          count !== null && count > 1 && `${formatInteger(count)} times`,
        ]),
        tone: outcome && HOOK_TROUBLE.has(outcome) ? "warning" : "neutral",
      };
    }
    case "permission": {
      const denied = text("ratel.permission.decision") === "deny";
      const source = text("ratel.permission.source");
      const waited = number("ratel.wait.human_ms");
      return {
        label: denied ? "Permission denied" : "Permission allowed",
        detail: join([
          text("gen_ai.tool.name"),
          source && `by ${source}`,
          waited !== null && `waited ${formatDuration(waited)}`,
        ]),
        tone: denied ? "warning" : "neutral",
      };
    }
    case "wait": {
      const wait = spanWait(attributes);
      return {
        label: "Waited for a person",
        detail: join([
          text("gen_ai.tool.name"),
          wait?.kind,
          wait && wait.label.toLowerCase(),
          wait && wait.humanMs !== null && formatDuration(wait.humanMs),
        ]),
        tone: wait?.refused ? "warning" : "neutral",
      };
    }
  }
}

function numberAttribute(
  attributes: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | null {
  const value = attributes?.[key];
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function startOf(span: RunMetricsSpan): number {
  return span.startedAt instanceof Date ? span.startedAt.getTime() : Date.parse(span.startedAt);
}

function byStart(a: RunMetricsSpan, b: RunMetricsSpan): number {
  return startOf(a) - startOf(b) || (a.spanId < b.spanId ? -1 : 1);
}

function maxOf(current: number | null, value: number | null): number | null {
  if (value === null) return current;
  return current === null ? value : Math.max(current, value);
}
