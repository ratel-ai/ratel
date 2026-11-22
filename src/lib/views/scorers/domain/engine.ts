import jsonLogic from "json-logic-js";
import type { ScorerPorts } from "../ports";
import { compilePattern } from "./config";
import { type RunView, resolvePath, transcriptOf, viewOf } from "./record";
import type {
  CheckConfig,
  DecisionConfig,
  ExpressionConfig,
  RunRecord,
  ScoreResult,
  Scorer,
  ScorerOverride,
} from "./types";

/** Increase this version when the engine's reading of a scorer changes. */
export const SCORER_ENGINE_VERSION = 1;

/** Text a regular expression reads is cut to this many characters. */
const MATCH_SUBJECT_CHARS = 20_000;

/**
 * Score a run record with each scorer, in order. A value that is unknown, or
 * a model that is not configured, gives a skip. Model ports are called only
 * for the model-based kinds; the transcript is built once.
 */
export async function scoreRecord(
  record: RunRecord,
  scorers: readonly Scorer[],
  ports: ScorerPorts = {},
): Promise<ScoreResult[]> {
  const view = viewOf(record);
  let transcript: string | null = null;
  const text = () => (transcript ??= transcriptOf(record));
  const results: ScoreResult[] = [];
  for (const scorer of scorers) {
    const reading = await readOne(scorer, view, text, ports);
    results.push(
      reading.value === null
        ? {
            scorerId: scorer.id,
            kind: scorer.kind,
            status: "skip",
            value: null,
            detail: reading.detail,
          }
        : {
            scorerId: scorer.id,
            kind: scorer.kind,
            status: reading.value >= scorer.goodThreshold ? "pass" : "fail",
            value: reading.value,
            detail: reading.detail,
          },
    );
  }
  return results;
}

/**
 * The scorers that apply to one run: the task's and the suite's enabled
 * scorers, after the eval's own switches. An override wins over the scorer's
 * own switch. Suite scorers come after task scorers.
 */
export function applicableScorers(
  taskScorers: readonly Scorer[],
  suiteScorers: readonly Scorer[],
  overrides: readonly ScorerOverride[] = [],
): Scorer[] {
  const switches = new Map(overrides.map((override) => [override.scorerId, override.enabled]));
  const seen = new Set<string>();
  return [...taskScorers, ...suiteScorers].filter((scorer) => {
    if (seen.has(scorer.id)) return false;
    seen.add(scorer.id);
    return switches.get(scorer.id) ?? scorer.enabled;
  });
}

interface Reading {
  value: number | null;
  detail: string;
}

async function readOne(
  scorer: Scorer,
  view: RunView,
  transcript: () => string,
  ports: ScorerPorts,
): Promise<Reading> {
  switch (scorer.kind) {
    case "check":
      return readCheck(scorer.config, view);
    case "expression":
      return readExpression(scorer.config, view);
    case "judge": {
      if (!ports.judge) return notMeasured("not judged: no model configured");
      const verdict = await ports.judge.judge({
        criteria: scorer.config.criteria,
        transcript: transcript(),
      });
      if (!verdict) return notMeasured("not judged");
      return { value: clamp(verdict.value), detail: verdict.detail ?? "judged" };
    }
    case "decision":
      return readDecision(scorer.config, transcript, ports);
  }
}

function readCheck(config: CheckConfig, view: RunView): Reading {
  const actual = resolvePath(view, config.path);
  const known = actual !== undefined && actual !== null;
  if (config.op === "exists")
    return verdict(known, `${config.path} ${known ? "is set" : "is not set"}`);
  if (config.op === "not_exists")
    return verdict(!known, `${config.path} ${known ? "is set" : "is not set"}`);
  if (!known) return notMeasured("not measured");
  const shown = `${config.path} = ${short(actual)}`;
  switch (config.op) {
    case "eq":
      return verdict(same(actual, config.value), shown);
    case "ne":
      return verdict(!same(actual, config.value), shown);
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const numbers = (Array.isArray(actual) ? actual : [actual]).filter(
        (item) => item !== null && item !== undefined,
      );
      if (!numbers.every((item): item is number => typeof item === "number"))
        return notMeasured(`${config.path} is not a number`);
      const op = config.op;
      return verdict(
        numbers.every((item) => compare(item, op, config.value as number)),
        shown,
      );
    }
    case "contains":
      return verdict(contains(actual, config.value), shown);
    case "not_contains":
      return verdict(!contains(actual, config.value), shown);
    case "matches":
    case "not_matches": {
      const pattern = compilePattern(config.value);
      const texts = (Array.isArray(actual) ? actual : [actual]).filter(
        (item): item is string => typeof item === "string",
      );
      const hit = texts.some((item) => pattern.test(item.slice(0, MATCH_SUBJECT_CHARS)));
      return verdict(config.op === "matches" ? hit : !hit, shown);
    }
  }
}

function readExpression(config: ExpressionConfig, view: RunView): Reading {
  const result: unknown = jsonLogic.apply(
    config.logic as jsonLogic.RulesLogic,
    view as unknown as Record<string, unknown>,
  );
  if (result === null || result === undefined) return notMeasured("not measured");
  if (typeof result === "number")
    return Number.isFinite(result)
      ? { value: clamp(result), detail: `= ${short(result)}` }
      : notMeasured("not a number");
  return verdict(jsonLogic.truthy(result), `= ${short(result)}`);
}

async function readDecision(
  config: DecisionConfig,
  transcript: () => string,
  ports: ScorerPorts,
): Promise<Reading> {
  if (!ports.decision) return notMeasured("not decided: no model configured");
  const answer = await ports.decision.decide({
    question: config.question,
    options: config.options,
    transcript: transcript(),
  });
  if (!answer) return notMeasured("not decided");
  const label =
    config.options.find((option) => option.id === answer.choice)?.label ?? answer.choice;
  if (answer.probabilities) {
    const value = config.pass.reduce((sum, id) => sum + (answer.probabilities![id] ?? 0), 0);
    return { value: clamp(value), detail: label };
  }
  return { value: config.pass.includes(answer.choice) ? 1 : 0, detail: label };
}

function compare(actual: number, op: "lt" | "lte" | "gt" | "gte", expected: number): boolean {
  switch (op) {
    case "lt":
      return actual < expected;
    case "lte":
      return actual <= expected;
    case "gt":
      return actual > expected;
    case "gte":
      return actual >= expected;
  }
}

function contains(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string")
    return typeof expected === "string" && actual.toLowerCase().includes(expected.toLowerCase());
  if (Array.isArray(actual))
    return actual.some(
      (item) => same(item, expected) || contains(typeof item === "string" ? item : null, expected),
    );
  if (typeof actual === "object" && actual !== null)
    return typeof expected === "string" && Object.hasOwn(actual, expected);
  return false;
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function verdict(pass: boolean, detail: string): Reading {
  return { value: pass ? 1 : 0, detail };
}

function notMeasured(detail: string): Reading {
  return { value: null, detail };
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function short(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
