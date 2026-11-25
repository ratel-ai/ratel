import { createHash } from "node:crypto";
import {
  ATTRIBUTE_PREFIX,
  type CheckConfig,
  OUTPUT_PATH,
  OUTPUT_PREFIX,
  TOOL_ARGUMENTS_PREFIX,
} from "@/lib/contracts/check";
import { runCheck } from "@/lib/views/scorers/check";
import type { ScorerDefinition, ScorerTrace } from "@/lib/views/scorers/types";
import type { CaseScorer } from "./case";

/** What one trial did: what the scorers read. */
export type TrialRecord = {
  output: unknown;
  toolCalls: ReadonlyArray<{ name: string; arguments: unknown; result?: unknown; error?: string }>;
  durationMs: number;
  /** Null when the agent did not report it. */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

/** The answer of the judge, or why there is none. */
export type JudgeOutcome =
  | { status: "answered"; passed: boolean; reason: string; confidence: number; model: string }
  | { status: "not_scored"; code: JudgeRefusal; reason: string };
export type JudgeRefusal = "not_configured" | "refused_budget" | "no_answer" | "call_failed";

export type ScorerResult = {
  scorerId: string;
  name: string;
  kind: ScorerDefinition["kind"];
  gating: boolean;
  status: "pass" | "fail" | "not_scored";
  reason: string;
  confidence?: number;
  model?: string;
};

export type TrialResult = "pass" | "fail" | "invalid";
export type TrialScore = {
  result: TrialResult;
  invalidReason: string | null;
  scorers: ScorerResult[];
};

/** A scorer as an experiment keeps it. */
export type ScorerSnapshot = CaseScorer & { hash: string };

/**
 * The result of a trial from its scorers. A gating scorer that fails makes it `fail`. Otherwise a
 * gating scorer with no result makes it `invalid`. An advisory scorer never changes it.
 */
export function scoreTrial(
  trial: TrialRecord,
  scorers: readonly CaseScorer[],
  judged: ReadonlyMap<string, JudgeOutcome>,
): TrialScore {
  const results = scorers.map((scorer) => scoreOne(trial, scorer, judged.get(scorer.id)));
  const gating = results.filter((result) => result.gating);
  const unscored = gating.find(({ status }) => status === "not_scored");
  if (gating.some(({ status }) => status === "fail")) {
    return { result: "fail", invalidReason: null, scorers: results };
  }
  if (unscored) {
    const invalidReason = `The gating scorer ${unscored.name} has no result: ${unscored.reason}`;
    return { result: "invalid", invalidReason, scorers: results };
  }
  return { result: "pass", invalidReason: null, scorers: results };
}

/** The content hash of a definition. The order of the keys does not matter. */
export function definitionHash(definition: ScorerDefinition): string {
  return createHash("sha256").update(canonical(definition)).digest("hex");
}

export function snapshotOf(scorer: CaseScorer): ScorerSnapshot {
  return { ...scorer, hash: definitionHash(scorer.definition) };
}

/** Runs one check of the shared contract on a trial. */
export function checkTrial(
  config: CheckConfig,
  trial: TrialRecord,
): { status: ScorerResult["status"]; reason: string } {
  const actual = valueAt(config.path, trial);
  const outcome = runOn(config, actual);
  const words = `${config.path} ${config.op}${config.value === undefined ? "" : ` ${config.value}`}`;
  if (outcome.status === "scored") {
    const status = outcome.score.passed ? "pass" : "fail";
    return { status, reason: `${words}: the value is ${shown(actual)}.` };
  }
  // The agent did not report its usage: that is no result. A missing answer or argument is.
  if (USAGE.has(config.path)) {
    return { status: "not_scored", reason: `The agent did not report ${config.path}.` };
  }
  return { status: "fail", reason: `${words}: the value is ${shown(actual)}.` };
}

const USAGE: ReadonlySet<string> = new Set([
  "cost_usd",
  "input_tokens",
  "output_tokens",
  "total_tokens",
]);
const ORDER: ReadonlySet<string> = new Set(["gt", "gte", "lt", "lte"]);
const SHOWN_CHARS = 300;

function scoreOne(
  trial: TrialRecord,
  { id, name, gating, definition }: CaseScorer,
  judged: JudgeOutcome | undefined,
): ScorerResult {
  const base = { scorerId: id, name, kind: definition.kind, gating };
  if (definition.kind === "check") return { ...base, ...checkTrial(definition.config, trial) };
  if (!judged) return { ...base, status: "not_scored", reason: "The judge did not run." };
  if (judged.status === "not_scored") {
    return { ...base, status: "not_scored", reason: judged.reason };
  }
  const { passed, reason, confidence, model } = judged;
  return { ...base, status: passed ? "pass" : "fail", reason, confidence, model };
}

/** An order on the values of some calls holds for each one. The other operators read the list. */
function runOn(config: CheckConfig, actual: unknown) {
  const run = (value: unknown) =>
    runCheck({ ...config, path: `${ATTRIBUTE_PREFIX}value` }, traceOf(value));
  if (!ORDER.has(config.op) || !Array.isArray(actual) || actual.length === 0) return run(actual);
  const outcomes = actual.map(run);
  return (
    outcomes.find((outcome) => outcome.status !== "scored" || !outcome.score.passed) ??
    run(actual[0])
  );
}

function valueAt(path: string, trial: TrialRecord): unknown {
  switch (path) {
    case "duration_ms":
      return trial.durationMs;
    case "cost_usd":
      return trial.costUsd;
    case "input_tokens":
      return trial.inputTokens;
    case "output_tokens":
      return trial.outputTokens;
    case "total_tokens":
      return trial.inputTokens === null || trial.outputTokens === null
        ? null
        : trial.inputTokens + trial.outputTokens;
    case "tools":
      return trial.toolCalls.map(({ name }) => name);
    case OUTPUT_PATH:
      return trial.output;
  }
  if (path.startsWith(OUTPUT_PREFIX)) return at(trial.output, path.slice(OUTPUT_PREFIX.length));
  if (path.startsWith(TOOL_ARGUMENTS_PREFIX)) {
    const rest = path.slice(TOOL_ARGUMENTS_PREFIX.length);
    // A tool name can have dots: the longest name with the argument is the tool.
    const tools = [...new Set(trial.toolCalls.map(({ name }) => name))]
      .filter((name) => rest.startsWith(`${name}.`))
      .sort((left, right) => right.length - left.length);
    for (const tool of tools) {
      const values = trial.toolCalls
        .filter(({ name }) => name === tool)
        .map((call) => at(call.arguments, rest.slice(tool.length + 1)))
        .filter((value) => value !== undefined);
      if (values.length > 0) return values;
    }
    return undefined;
  }
  return undefined;
}

function at(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** The value as the one attribute of a trace, which the shared check engine reads. */
function traceOf(value: unknown): ScorerTrace {
  return {
    traceId: "",
    startedAt: new Date(0),
    durationMs: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    error: false,
    models: [],
    tools: [],
    agents: [],
    mcpServers: [],
    service: null,
    environment: null,
    attributes: { value },
  };
}

function shown(value: unknown): string {
  if (value === undefined) return "not there";
  const text = JSON.stringify(value) ?? "not there";
  return text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}…` : text;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
