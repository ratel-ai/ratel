import { isCheckPath, isComparable, MAX_PATH_CHARS, MAX_VALUE_CHARS } from "@/lib/contracts/check";
import { hasNoNul } from "@/lib/contracts/json-text";
import {
  CHECK_OPERATORS,
  type CheckConfig,
  type CheckValue,
  JUDGE_OUTPUTS,
  type JudgeConfig,
  PRESET_KINDS,
  type PresetConfig,
  type ScorerDefinition,
  type ScorerDraft,
  type ScorerFilter,
} from "./types";

export { MAX_PATH_CHARS, MAX_VALUE_CHARS };
export const MAX_NAME_CHARS = 100;
export const MAX_PROMPT_CHARS = 5_000;
/**
 * The scorers a project's people may have. Every scorer of every project takes its turn in one
 * sweep. The scorers the system makes for tasks (`TASK_SCORERS_ACTOR`) do not count.
 */
export const MAX_SCORERS = 100;
/** Who creates the scorers that stand for a task's scorers (the migration names them the same). */
export const TASK_SCORERS_ACTOR = "system:task-scorers";
export const MAX_TASKS = 50;
/** The task kind a preset draft may name besides `PRESET_KINDS`: it becomes a pass-or-fail judge. */
export const CRITERIA_PRESET = "judge_criteria";
const MAX_TOOL_CHARS = 500;
const MAX_FILTER_VALUES = 50;
const FILTER_LISTS = [
  "models",
  "tools",
  "services",
  "environments",
  "agents",
  "mcpServers",
] as const;

/** The form control a problem belongs to. */
export type DraftField =
  | "name"
  | "path"
  | "op"
  | "value"
  | "prompt"
  | "output"
  | "preset"
  | "max"
  | "tool"
  | "tasks"
  | "sampleRate";
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
  const tasks = parseTasks(raw.tasks);
  if (tasks === undefined) return fail("The scorer settings are invalid.");
  if (tasks?.length === 0 || (tasks && tasks.length > MAX_TASKS))
    return fail(`Choose from 1 to ${MAX_TASKS} tasks, or every trace.`, "tasks");
  const definition = parseDefinition(raw.kind, raw.config);
  if ("ok" in definition) return definition;
  if (raw.kind === "preset" && tasks === null)
    return fail("A task preset scores the runs of its tasks. Choose them.", "tasks");
  return { ok: true, draft: { name, sampleRate, enabled, filter, tasks, ...definition } };
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
  if (kind === "preset") {
    if (config.preset === CRITERIA_PRESET) {
      const prompt = text(config.criteria, MAX_PROMPT_CHARS);
      return prompt
        ? { kind: "judge", config: { prompt, output: "boolean" } }
        : fail(`Write the task criteria in up to ${MAX_PROMPT_CHARS} characters.`, "prompt");
    }
    const parsed = parsePreset(config);
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
  return filter;
}

/** Null: every trace. The task ids without repeats otherwise; undefined when it is malformed. */
export function parseTasks(raw: unknown): string[] | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.map(parseTaskId);
  return ids.includes(null) ? undefined : [...new Set(ids as string[])];
}

export function parseTaskId(raw: unknown): string | null {
  return text(raw, MAX_VALUE_CHARS);
}

function parseCheck(raw: Record<string, unknown>): CheckConfig | DraftProblem {
  const path = text(raw.path, MAX_PATH_CHARS);
  if (!path || !isCheckPath(path))
    return fail("Choose what to read, and give an attribute its key.", "path");
  const op = CHECK_OPERATORS.find((candidate) => candidate === raw.op);
  if (!op) return fail("Choose an operator.", "op");
  if (op === "exists") return { path, op };
  const value = checkValue(raw.value);
  if (value === null) return fail("Give the check a value to compare with.", "value");
  if (!isComparable(op, value)) return fail("This operator compares with a number.", "value");
  return { path, op, value };
}

/** A task kind and its setting, with the rules of `task-scorers/actions.ts`. */
function parsePreset(raw: Record<string, unknown>): PresetConfig | DraftProblem {
  const preset = PRESET_KINDS.find((candidate) => candidate === raw.preset);
  if (!preset) return fail("Choose a task preset.", "preset");
  switch (preset) {
    case "ends_well":
      return { preset };
    case "expected_tool": {
      const tool = text(raw.tool, MAX_TOOL_CHARS);
      return tool ? { preset, tool } : fail("Give the tool the run must call.", "tool");
    }
    default: {
      const { max } = raw;
      const whole = preset === "max_tool_calls" || preset === "max_self_corrections";
      if (
        typeof max !== "number" ||
        !Number.isFinite(max) ||
        max < 0 ||
        (whole && !Number.isSafeInteger(max))
      )
        return fail(
          whole
            ? "The limit is a whole number of 0 or more."
            : "The limit is a number of 0 or more.",
          "max",
        );
      return { preset, max };
    }
  }
}

function parseJudge(raw: Record<string, unknown>): JudgeConfig | DraftProblem {
  const prompt = text(raw.prompt, MAX_PROMPT_CHARS);
  if (!prompt) return fail(`Write a question of up to ${MAX_PROMPT_CHARS} characters.`, "prompt");
  const output = JUDGE_OUTPUTS.find((candidate) => candidate === raw.output);
  return output
    ? { prompt, output }
    : fail("Choose the answer: pass or fail, or 1 to 5.", "output");
}

function checkValue(raw: unknown): CheckValue | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  return text(raw, MAX_VALUE_CHARS);
}

function text(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= max && hasNoNul(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(error: string, field?: DraftField): DraftProblem {
  return { ok: false, error, ...(field ? { field } : {}) };
}
