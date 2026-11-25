import {
  ATTRIBUTE_PREFIX,
  type CheckConfig,
  type CheckValue,
  type ScoreOutcome,
  type ScorerTrace,
  type TraceField,
} from "./types";

const FIELD_READERS: Record<TraceField, (trace: ScorerTrace) => unknown> = {
  duration_ms: (trace) => trace.durationMs,
  cost_usd: (trace) => trace.costUsd,
  input_tokens: (trace) => trace.inputTokens,
  output_tokens: (trace) => trace.outputTokens,
  total_tokens: (trace) => trace.inputTokens + trace.outputTokens,
  error: (trace) => trace.error,
  models: (trace) => trace.models,
  tools: (trace) => trace.tools,
  agents: (trace) => trace.agents,
  mcp_servers: (trace) => trace.mcpServers,
  service: (trace) => trace.service,
  environment: (trace) => trace.environment,
};

/** Apply one check to one trace. Pure. An unknown value is a skip; only `exists` reads it as a fail. */
export function runCheck(config: CheckConfig, trace: ScorerTrace): ScoreOutcome {
  const actual = resolvePath(trace, config.path);
  const known = actual !== undefined && actual !== null;
  if (config.op === "exists")
    return verdict(known && !(Array.isArray(actual) && actual.length === 0));
  if (!known) return { status: "skipped", reason: "missing_attribute" };
  const expected = config.value ?? "";
  switch (config.op) {
    case "eq":
      return verdict(itemsOf(actual).some((item) => same(item, expected)));
    case "ne":
      return verdict(!itemsOf(actual).some((item) => same(item, expected)));
    case "contains":
      return verdict(itemsOf(actual).some((item) => includes(item, expected)));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left = numberOf(actual);
      const right = numberOf(expected);
      if (left === null || right === null) return { status: "skipped", reason: "not_a_number" };
      return verdict(compare(left, config.op, right));
    }
  }
}

/** The value at a path: a trace field, or a root span attribute (flat dotted key first, then nested). */
export function resolvePath(trace: ScorerTrace, path: string): unknown {
  if (Object.hasOwn(FIELD_READERS, path)) return FIELD_READERS[path as TraceField](trace);
  if (!path.startsWith(ATTRIBUTE_PREFIX)) return undefined;
  const key = path.slice(ATTRIBUTE_PREFIX.length);
  if (Object.hasOwn(trace.attributes, key)) return trace.attributes[key];
  let current: unknown = trace.attributes;
  for (const part of key.split(".")) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part))
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function verdict(passed: boolean): ScoreOutcome {
  return { status: "scored", score: { value: passed ? 1 : 0, passed, confidence: null } };
}

function itemsOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** Two numbers compare as numbers ("200" equals 200); anything else compares as text. */
function same(actual: unknown, expected: CheckValue): boolean {
  const left = numberOf(actual);
  const right = numberOf(expected);
  if (left !== null && right !== null) return left === right;
  return textOf(actual) === textOf(expected);
}

function includes(actual: unknown, expected: CheckValue): boolean {
  return textOf(actual).toLowerCase().includes(textOf(expected).toLowerCase());
}

function compare(left: number, op: "gt" | "gte" | "lt" | "lte", right: number): boolean {
  switch (op) {
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
  }
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOf(value: unknown): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}
