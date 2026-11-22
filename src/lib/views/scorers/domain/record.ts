import { endsWellOf, selfCorrectionsOf } from "@/lib/views/task-scorers/outcome";
import type { RunRecord } from "./types";

/**
 * The run as scorers read it: the record's own fields plus derived ones. A
 * check's path and a JSONLogic `var` both resolve against this view. Unknown
 * values are null. Pure.
 */
export interface RunView {
  messages: RunRecord["messages"];
  toolCalls: RunRecord["toolCalls"];
  finalAnswer: string | null;
  answered: boolean | null;
  latencyMs: number | null;
  costUsd: number | null;
  tokens: RunRecord["tokens"];
  /** The first search's list. Empty when the run did not search. Null when the list is unknown. */
  firstList: readonly string[] | null;
  toolNames: readonly string[] | null;
  toolCallCount: number | null;
  failedCalls: number | null;
  selfCorrections: number | null;
  endsWell: boolean | null;
  /** Every message's text, joined. */
  text: string | null;
}

export const VIEW_FIELDS = [
  "messages",
  "toolCalls",
  "finalAnswer",
  "answered",
  "latencyMs",
  "costUsd",
  "tokens",
  "firstList",
  "toolNames",
  "toolCallCount",
  "failedCalls",
  "selfCorrections",
  "endsWell",
  "text",
] as const satisfies readonly (keyof RunView)[];

const TRANSCRIPT_FIELD_CHARS = 2_000;
const TRANSCRIPT_CHARS = 20_000;

export function viewOf(record: RunRecord): RunView {
  const calls = record.toolCalls;
  const names = calls ? calls.map((call) => call.name) : null;
  const outcomes =
    calls && record.outcomesKnown !== false ? calls.map((call) => call.outcome) : null;
  const answered = record.answered ?? null;
  return {
    messages: record.messages,
    toolCalls: calls,
    finalAnswer: record.finalAnswer,
    answered,
    latencyMs: record.latencyMs,
    costUsd: record.costUsd,
    tokens: record.tokens,
    firstList: record.listKnown === false ? null : (record.firstList ?? []),
    toolNames: names,
    toolCallCount: calls ? calls.length : null,
    failedCalls: calls ? calls.filter((call) => call.outcome === "error").length : null,
    selfCorrections: selfCorrectionsOf({ calls: names, outcomes }),
    endsWell: endsWellOf({ calls: names, outcomes, answered }),
    text: record.messages ? record.messages.map((message) => message.content).join("\n") : null,
  };
}

/**
 * Resolve a dotted path. `*` maps over an array and flattens; `length` reads
 * an array's or a string's length. Undefined when a segment is missing.
 */
export function resolvePath(view: RunView, path: string): unknown {
  let values: unknown[] = [view];
  let spread = false;
  for (const segment of path.split(".")) {
    const next: unknown[] = [];
    for (const value of values) {
      if (segment === "*") {
        if (Array.isArray(value)) next.push(...value);
        continue;
      }
      const child = childOf(value, segment);
      if (child !== undefined) next.push(child);
    }
    if (segment === "*") spread = true;
    values = next;
  }
  if (spread) return values;
  return values[0];
}

/** The run in plain words, the only thing a model-based scorer reads. Long fields are cut. */
export function transcriptOf(record: RunRecord): string {
  const lines: string[] = [];
  for (const message of record.messages ?? [])
    lines.push(`${capitalize(message.role)}: ${cut(message.content)}`);
  if (record.toolCalls) {
    if (record.toolCalls.length === 0) lines.push("It called no tool.");
    for (const call of record.toolCalls) {
      const args = call.arguments ? cut(JSON.stringify(call.arguments)) : "";
      const result =
        call.result === undefined || call.result === null
          ? ""
          : ` -> ${cut(typeof call.result === "string" ? call.result : JSON.stringify(call.result))}`;
      lines.push(
        `Tool call: ${call.name}(${args}) [${call.outcome === "error" ? "failed" : call.outcome}]${result}`,
      );
    }
  } else {
    lines.push("Which tools it called is not known.");
  }
  if (record.finalAnswer) lines.push(`Final answer: ${cut(record.finalAnswer)}`);
  else if (record.answered === false) lines.push("It never gave a final answer.");
  const metrics = [
    record.latencyMs === null ? null : `latency ${Math.round(record.latencyMs)} ms`,
    record.costUsd === null ? null : `cost $${record.costUsd.toFixed(4)}`,
    record.tokens ? `tokens ${record.tokens.input} in / ${record.tokens.output} out` : null,
  ].filter(Boolean);
  if (metrics.length > 0) lines.push(`Measured: ${metrics.join(", ")}.`);
  const text = lines.join("\n");
  return text.length > TRANSCRIPT_CHARS ? `${text.slice(0, TRANSCRIPT_CHARS)}…` : text;
}

function childOf(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return undefined;
  if ((Array.isArray(value) || typeof value === "string") && key === "length") return value.length;
  if (Array.isArray(value)) return /^\d+$/.test(key) ? value[Number(key)] : undefined;
  if (typeof value === "object" && Object.hasOwn(value, key))
    return (value as Record<string, unknown>)[key];
  return undefined;
}

function cut(text: string): string {
  return text.length > TRANSCRIPT_FIELD_CHARS ? `${text.slice(0, TRANSCRIPT_FIELD_CHARS)}…` : text;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
