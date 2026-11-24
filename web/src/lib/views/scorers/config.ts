import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import {
  ATTRIBUTE_PREFIX,
  CHECK_OPERATORS,
  type CheckConfig,
  type CheckValue,
  JUDGE_OUTPUTS,
  type JudgeConfig,
  type ScorerDefinition,
  type ScorerDraft,
  TRACE_FIELDS,
} from "./types";

export const MAX_NAME_CHARS = 100;
export const MAX_PATH_CHARS = 200;
export const MAX_VALUE_CHARS = 500;
export const MAX_PROMPT_CHARS = 5_000;
const MAX_FILTER_VALUES = 50;
const ORDER_OPERATORS: readonly string[] = ["gt", "gte", "lt", "lte"];
const FILTER_LISTS = [
  "models",
  "tools",
  "services",
  "environments",
  "agents",
  "mcpServers",
] as const;

/** A person's scorer, checked; a sentence about the first problem otherwise. */
export function parseScorerDraft(
  raw: unknown,
): { ok: true; draft: ScorerDraft } | { ok: false; error: string } {
  if (!isRecord(raw)) return fail("The scorer settings are invalid.");
  const name = text(raw.name, MAX_NAME_CHARS);
  if (!name) return fail(`Give the scorer a name of up to ${MAX_NAME_CHARS} characters.`);
  const { sampleRate, enabled } = raw;
  if (
    typeof sampleRate !== "number" ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 1 ||
    sampleRate > 100
  )
    return fail("The sample rate is a whole number from 1 to 100.");
  if (typeof enabled !== "boolean") return fail("The scorer settings are invalid.");
  const filter = parseFilter(raw.filter);
  if (!filter) return fail("The trace filter is invalid.");
  const definition = parseDefinition(raw.kind, raw.config);
  if (typeof definition === "string") return fail(definition);
  return { ok: true, draft: { name, sampleRate, enabled, filter, ...definition } };
}

/** A kind and its config, or a sentence about the problem. */
export function parseDefinition(kind: unknown, config: unknown): ScorerDefinition | string {
  if (!isRecord(config)) return "The scorer settings are invalid.";
  if (kind === "check") {
    const parsed = parseCheck(config);
    return typeof parsed === "string" ? parsed : { kind, config: parsed };
  }
  if (kind === "judge") {
    const parsed = parseJudge(config);
    return typeof parsed === "string" ? parsed : { kind, config: parsed };
  }
  return "Choose a check or a judge.";
}

/** A stored or submitted trace filter with only known keys; null when a value is malformed. */
export function parseFilter(raw: unknown): TraceFilter | null {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) return null;
  const filter: TraceFilter = {};
  for (const key of FILTER_LISTS) {
    const list = raw[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > MAX_FILTER_VALUES) return null;
    const values = list.map((item) => text(item, MAX_VALUE_CHARS));
    if (values.some((value) => value === null)) return null;
    if (values.length > 0) filter[key] = values as string[];
  }
  if (raw.status !== undefined) {
    if (raw.status !== "failed" && raw.status !== "ok") return null;
    filter.status = raw.status;
  }
  for (const key of ["minCostUsd", "minTokens"] as const) {
    const min = raw[key];
    if (min === undefined) continue;
    if (typeof min !== "number" || !Number.isFinite(min) || min < 0) return null;
    filter[key] = min;
  }
  return filter;
}

function parseCheck(raw: Record<string, unknown>): CheckConfig | string {
  const path = text(raw.path, MAX_PATH_CHARS);
  if (!path || !isPath(path))
    return `Choose a trace field, or an attribute that starts with "${ATTRIBUTE_PREFIX}".`;
  const op = CHECK_OPERATORS.find((candidate) => candidate === raw.op);
  if (!op) return "Choose an operator.";
  if (op === "exists") return { path, op };
  const value = checkValue(raw.value);
  if (value === null) return "Give the check a value to compare with.";
  if (
    ORDER_OPERATORS.includes(op) &&
    (typeof value === "boolean" || !Number.isFinite(Number(value)))
  )
    return "This operator compares with a number.";
  return { path, op, value };
}

function parseJudge(raw: Record<string, unknown>): JudgeConfig | string {
  const prompt = text(raw.prompt, MAX_PROMPT_CHARS);
  if (!prompt) return `Write the judge's question in up to ${MAX_PROMPT_CHARS} characters.`;
  const output = JUDGE_OUTPUTS.find((candidate) => candidate === raw.output);
  return output ? { prompt, output } : "Choose the judge's answer: pass or fail, or 1 to 5.";
}

function isPath(path: string): boolean {
  return (
    TRACE_FIELDS.some((field) => field === path) ||
    (path.startsWith(ATTRIBUTE_PREFIX) && path.length > ATTRIBUTE_PREFIX.length)
  );
}

function checkValue(raw: unknown): CheckValue | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  return text(raw, MAX_VALUE_CHARS);
}

function text(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= max ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
