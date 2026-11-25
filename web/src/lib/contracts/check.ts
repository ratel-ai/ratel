/** What a check reads of a trace, and how it compares: the vocabulary of check scorers and of funnel steps. */

export const CHECK_OPERATORS = [
  "eq",
  "ne",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
] as const;
export type CheckOperator = (typeof CHECK_OPERATORS)[number];

/** The trace fields a check may read by name. Any other path starts with `ATTRIBUTE_PREFIX`. */
export const TRACE_FIELDS = [
  "duration_ms",
  "cost_usd",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "error",
  "models",
  "tools",
  "agents",
  "mcp_servers",
  "service",
  "environment",
] as const;
export type TraceField = (typeof TRACE_FIELDS)[number];

/** `attributes.<key>` reads one attribute of the trace's root span. */
export const ATTRIBUTE_PREFIX = "attributes.";
export const MAX_PATH_CHARS = 200;
export const MAX_VALUE_CHARS = 500;

export type CheckValue = string | number | boolean;

/** `value` is absent for `exists` only. */
export interface CheckConfig {
  path: string;
  op: CheckOperator;
  value?: CheckValue;
}

const ORDER_OPERATORS: readonly CheckOperator[] = ["gt", "gte", "lt", "lte"];

export function isCheckPath(path: string): boolean {
  return (
    TRACE_FIELDS.some((field) => field === path) ||
    (path.startsWith(ATTRIBUTE_PREFIX) && path.length > ATTRIBUTE_PREFIX.length)
  );
}

/** Whether the operator can compare with the value: an order compares with a number. */
export function isComparable(op: CheckOperator, value: CheckValue): boolean {
  return (
    !ORDER_OPERATORS.includes(op) || (typeof value !== "boolean" && Number.isFinite(Number(value)))
  );
}

/** The agent's answer of an eval trial. `output.<path>` reads one field of an answer that is JSON. */
export const OUTPUT_PATH = "output";
export const OUTPUT_PREFIX = "output.";
/** `tool_arguments.<tool>.<path>` reads an argument of each call of a tool in an eval trial. */
export const TOOL_ARGUMENTS_PREFIX = "tool_arguments.";

/** The trace fields that an eval trial has too. */
export const TRIAL_FIELDS = [
  "duration_ms",
  "cost_usd",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "tools",
] as const satisfies readonly TraceField[];

/** Whether a check of an eval case may read the path. A trial has no trace attributes. */
export function isTrialCheckPath(path: string): boolean {
  return (
    TRIAL_FIELDS.some((field) => field === path) ||
    path === OUTPUT_PATH ||
    (path.startsWith(OUTPUT_PREFIX) && path.length > OUTPUT_PREFIX.length) ||
    /^tool_arguments\..+\..+$/.test(path)
  );
}
