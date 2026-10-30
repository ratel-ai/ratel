/**
 * A run told as a conversation (the run Panel and the full trace): what was
 * asked, each step the agent took in order with how long it took, what it
 * answered, and what it cost. Built from the spans alone, so it works whether
 * or not the customer captures message content; without content the steps
 * still read in order.
 */

import { promptOf } from "@/lib/ingest/otlp/prompt-text";
import type { AttrMap } from "@/lib/ingest/otlp/types";
import { buildTraceContentView } from "@/lib/synthesis/traces/content-view";
import type { RunStatus } from "./runs";
import { STEP_KIND_LABEL, type StepKind, stepKind, stepTitle, stringAttribute } from "./span-kind";

/** The span fields a run summary reads: a subset of both `OtelSpan` and `TraceSpanView`. */
export interface RunSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  spanClass: string;
  operationName: string | null;
  model: string | null;
  startedAt: Date | string;
  endedAt: Date | string;
  durationMs: number;
  statusCode: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | number | null;
  searchQuery: string | null;
  searchTarget: string | null;
  searchHitCount: number | null;
  attributes: Readonly<Record<string, unknown>>;
}

export interface RunStep {
  id: string;
  kind: StepKind;
  /** "Model call", "Tool call", "Search", "Agent step", "Step". */
  label: string;
  /** The model, the tool, the query or the agent. */
  title: string;
  /** One quiet line: "1,240 tokens", "5 results". */
  detail: string | null;
  /** Start, relative to the run's first span. */
  offsetMs: number;
  durationMs: number;
  failed: boolean;
  /** The span's `error.type`, when it reported one. */
  errorType: string | null;
}

export interface RunTotals {
  durationMs: number;
  spanCount: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costUsd: number;
  failedSpans: number;
}

export interface RunSummary {
  /** Incomplete while the run's top-level span has not arrived (it ends, and is sent, last). */
  status: RunStatus;
  /** The first span's start, ISO. */
  startedAt: string;
  /** The ask when captured, else the root span's name in plain words. */
  title: string;
  ask: string | null;
  answer: string | null;
  contentCaptured: boolean;
  steps: RunStep[];
  /** Steps past the cap; the full trace shows them. */
  hiddenStepCount: number;
  /** The root span failed with this error type (no step carries it). */
  runError: string | null;
  totals: RunTotals;
}

/** Steps a Panel lists before pointing at the full trace. */
export const MAX_SUMMARY_STEPS = 100;
/** The ask and the answer are previews; the Conversation tab has the rest. */
export const MAX_SUMMARY_TEXT = 600;

const STEP_KINDS: ReadonlySet<StepKind> = new Set(["model", "tool", "search"]);

export function buildRunSummary(
  spans: readonly RunSpan[],
  maxSteps = MAX_SUMMARY_STEPS,
): RunSummary {
  const ordered = [...spans].sort(compareSpans);
  const topLevel = ordered.find((span) => span.parentSpanId === null);
  const root = topLevel ?? ordered[0];
  const startMs = ordered.reduce(
    (min, span) => Math.min(min, time(span.startedAt)),
    Number.POSITIVE_INFINITY,
  );
  const endMs = ordered.reduce(
    (max, span) =>
      Math.max(max, time(span.endedAt), time(span.startedAt) + finite(span.durationMs)),
    Number.NEGATIVE_INFINITY,
  );
  const allSteps = ordered.flatMap((span): RunStep[] => {
    const kind = stepKind(span);
    const failed = span.statusCode === 2;
    // Model calls, tool calls and searches are the story. Anything else shows
    // up only when it failed, and the root's failure is the run's own.
    if (!STEP_KINDS.has(kind) && (!failed || span === root)) return [];
    return [
      {
        id: span.spanId,
        kind,
        label: STEP_KIND_LABEL[kind],
        title: stepTitle(span),
        detail: stepDetail(kind, span),
        offsetMs: Math.max(0, time(span.startedAt) - startMs),
        durationMs: finite(span.durationMs),
        failed,
        errorType: failed ? stringAttribute(span.attributes, "error.type") : null,
      },
    ];
  });
  const content = buildTraceContentView(ordered);
  const ask = runAsk(ordered) ?? firstUserText(content.messages);
  const answer = lastAssistantText(content.messages);
  const inputTokens = sum(ordered, (span) => span.inputTokens ?? 0);
  const outputTokens = sum(ordered, (span) => span.outputTokens ?? 0);
  const failedSpans = ordered.filter((span) => span.statusCode === 2).length;
  const rootFailed = root?.statusCode === 2;
  const stepFailed = allSteps.some((step) => step.failed);

  return {
    status: failedSpans > 0 ? "failed" : topLevel ? "completed" : "incomplete",
    startedAt: Number.isFinite(startMs)
      ? new Date(startMs).toISOString()
      : new Date(0).toISOString(),
    title: preview(ask) ?? (root ? stepTitle(root) : "Run"),
    ask: preview(ask),
    answer: preview(answer),
    contentCaptured: content.contentCaptured || ask !== null,
    steps: allSteps.slice(0, maxSteps),
    hiddenStepCount: Math.max(0, allSteps.length - maxSteps),
    runError:
      rootFailed && !stepFailed
        ? (stringAttribute(root.attributes, "error.type") ?? "Failed")
        : null,
    totals: {
      durationMs:
        Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0,
      spanCount: ordered.length,
      inputTokens,
      outputTokens,
      tokens: inputTokens + outputTokens,
      costUsd: sum(ordered, (span) => toNumber(span.costUsd)),
      failedSpans,
    },
  };
}

/**
 * What the person asked: the last user message going into the run's first
 * model call (earlier messages are history), else the root span's own prompt.
 * Null when content isn't captured.
 */
export function runAsk(
  spans: readonly Pick<
    RunSpan,
    "spanClass" | "parentSpanId" | "startedAt" | "spanId" | "attributes"
  >[],
): string | null {
  const ordered = [...spans].sort(compareSpans);
  const firstModelCall = ordered.find((span) => span.spanClass === "llm_call");
  const root = ordered.find((span) => span.parentSpanId === null);
  for (const span of [firstModelCall, root]) {
    if (!span) continue;
    const prompt = promptOf(span.attributes as AttrMap);
    if (prompt?.trim()) return prompt.trim();
  }
  return null;
}

/** A one-line preview, cut at a word near the limit. */
export function preview(text: string | null, limit = MAX_SUMMARY_TEXT): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function stepDetail(kind: StepKind, span: RunSpan): string | null {
  if (kind === "model") {
    const tokens = (span.inputTokens ?? 0) + (span.outputTokens ?? 0);
    return tokens > 0 ? `${tokens.toLocaleString("en-US")}\u00a0tokens` : null;
  }
  if (kind === "search" && span.searchHitCount !== null && span.searchHitCount !== undefined) {
    const noun = span.searchHitCount === 1 ? "result" : "results";
    return `${span.searchHitCount.toLocaleString("en-US")} ${noun}`;
  }
  return null;
}

function firstUserText(messages: readonly { role: string; text: string }[]): string | null {
  return messages.find((message) => message.role === "user" && message.text.trim())?.text ?? null;
}

function lastAssistantText(messages: readonly { role: string; text: string }[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.text.trim()) return message.text;
  }
  return null;
}

function compareSpans(
  left: Pick<RunSpan, "startedAt" | "spanId">,
  right: Pick<RunSpan, "startedAt" | "spanId">,
): number {
  const difference = time(left.startedAt) - time(right.startedAt);
  if (difference !== 0) return difference;
  return left.spanId < right.spanId ? -1 : left.spanId > right.spanId ? 1 : 0;
}

function time(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function finite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function toNumber(value: string | number | null): number {
  if (value === null) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum<T>(items: readonly T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}
