import {
  ATTRIBUTE_PREFIX,
  CHECK_OPERATORS,
  type CheckConfig,
  type CheckValue,
  JUDGE_OUTPUTS,
  type JudgeConfig,
  type ScorerDefinition,
  type ScorerDraft,
  type ScorerFilter,
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

/** The form control a problem belongs to. */
export type DraftField = "name" | "path" | "op" | "value" | "prompt" | "output" | "sampleRate";
export type DraftProblem = { ok: false; error: string; field?: DraftField };

/** A person's scorer, checked; a sentence about the first problem otherwise. Pure: the form uses it too. */
export function parseScorerDraft(raw: unknown): { ok: true; draft: ScorerDraft } | DraftProblem {
  if (!isRecord(raw)) return fail("The scorer settings are invalid.");
  const name = text(raw.name, MAX_NAME_CHARS);
  if (!name) return fail(`Give the scorer a name of up to ${MAX_NAME_CHARS} characters.`, "name");
  const { sampleRate, enabled } = raw;
  if (
    typeof sampleRate !== "number" ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 1 ||
    sampleRate > 100
  )
    return fail("The sample rate is a whole number from 1 to 100.", "sampleRate");
  if (typeof enabled !== "boolean") return fail("The scorer settings are invalid.");
  const filter = parseFilter(raw.filter);
  if (!filter) return fail("The trace filter is invalid.");
  const definition = parseDefinition(raw.kind, raw.config);
  if ("ok" in definition) return definition;
  return { ok: true, draft: { name, sampleRate, enabled, filter, ...definition } };
}

/** A kind and its config, or the problem. */
export function parseDefinition(kind: unknown, config: unknown): ScorerDefinition | DraftProblem {
  if (!isRecord(config)) return fail("The scorer settings are invalid.");
  if (kind === "check") {
    const parsed = parseCheck(config);
    return "ok" in parsed ? parsed : { kind, config: parsed };
  }
  if (kind === "judge") {
    const parsed = parseJudge(config);
    return "ok" in parsed ? parsed : { kind, config: parsed };
  }
  return fail("Choose a kind.");
}

/** A stored or submitted trace filter with only known keys; null when a value is malformed. */
export function parseFilter(raw: unknown): ScorerFilter | null {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) return null;
  const filter: ScorerFilter = {};
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
  if (raw.taskId !== undefined) {
    const taskId = text(raw.taskId, MAX_VALUE_CHARS);
    if (!taskId) return null;
    filter.taskId = taskId;
  }
  return filter;
}

function parseCheck(raw: Record<string, unknown>): CheckConfig | DraftProblem {
  const path = text(raw.path, MAX_PATH_CHARS);
  if (!path || !isPath(path))
    return fail("Choose what to read, and give an attribute its key.", "path");
  const op = CHECK_OPERATORS.find((candidate) => candidate === raw.op);
  if (!op) return fail("Choose an operator.", "op");
  if (op === "exists") return { path, op };
  const value = checkValue(raw.value);
  if (value === null) return fail("Give the check a value to compare with.", "value");
  if (
    ORDER_OPERATORS.includes(op) &&
    (typeof value === "boolean" || !Number.isFinite(Number(value)))
  )
    return fail("This operator compares with a number.", "value");
  return { path, op, value };
}

function parseJudge(raw: Record<string, unknown>): JudgeConfig | DraftProblem {
  const prompt = text(raw.prompt, MAX_PROMPT_CHARS);
  if (!prompt) return fail(`Write a question of up to ${MAX_PROMPT_CHARS} characters.`, "prompt");
  const output = JUDGE_OUTPUTS.find((candidate) => candidate === raw.output);
  return output
    ? { prompt, output }
    : fail("Choose the answer: pass or fail, or 1 to 5.", "output");
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

function fail(error: string, field?: DraftField): DraftProblem {
  return { ok: false, error, ...(field ? { field } : {}) };
}
