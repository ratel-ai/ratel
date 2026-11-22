import jsonLogic from "json-logic-js";
import { VIEW_FIELDS, viewOf } from "./record";
import {
  CHECK_OPS,
  type CheckConfig,
  type CheckOp,
  type DecisionConfig,
  type ExpressionConfig,
  type JudgeConfig,
  SCORER_KINDS,
  type ScorerDefinition,
} from "./types";

/**
 * Save-time validation (RC-612). Every scorer that reaches the engine went
 * through `parseDefinition`, so the engine trusts its config. Messages name
 * the field and say what is allowed: a person or an agent reads them.
 */

export class ScorerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScorerConfigError";
  }
}

export const MAX_PATTERN_CHARS = 200;
const MAX_NAME_CHARS = 120;
const MAX_CRITERIA_CHARS = 5_000;
const MAX_QUESTION_CHARS = 1_000;
const MAX_OPTIONS = 20;
const MAX_EXPRESSION_DEPTH = 32;

/** JSONLogic operators the expression kind allows. `log` is left out: it writes to the console. */
export const EXPRESSION_OPS = [
  "var",
  "missing",
  "missing_some",
  "if",
  "?:",
  "==",
  "===",
  "!=",
  "!==",
  "!",
  "!!",
  "or",
  "and",
  ">",
  ">=",
  "<",
  "<=",
  "max",
  "min",
  "+",
  "-",
  "*",
  "/",
  "%",
  "map",
  "filter",
  "reduce",
  "all",
  "none",
  "some",
  "merge",
  "in",
  "cat",
  "substr",
] as const;

/** Operators whose second and later arguments read each array element, not the run. */
const ELEMENT_OPS = new Set(["map", "filter", "reduce", "all", "none", "some"]);
const VALUE_FREE_OPS = new Set<CheckOp>(["exists", "not_exists"]);
const NUMBER_OPS = new Set<CheckOp>(["lt", "lte", "gt", "gte"]);
const PATTERN_OPS = new Set<CheckOp>(["matches", "not_matches"]);

/** Validate a kind and its config. Throws `ScorerConfigError` with a clear message. */
export function parseDefinition(kind: unknown, config: unknown): ScorerDefinition {
  if (typeof kind !== "string" || !(SCORER_KINDS as readonly string[]).includes(kind)) {
    throw new ScorerConfigError(
      `Unknown scorer kind "${String(kind)}". Use one of: ${SCORER_KINDS.join(", ")}.`,
    );
  }
  const object = asObject(config, "config");
  switch (kind) {
    case "check":
      return { kind, config: parseCheck(object) };
    case "expression":
      return { kind, config: parseExpression(object) };
    case "judge":
      return { kind, config: parseJudge(object) };
    default:
      return { kind: "decision", config: parseDecision(object) };
  }
}

export function parseName(name: unknown): string {
  if (typeof name !== "string" || !name.trim())
    throw new ScorerConfigError("The scorer name is empty. Give the scorer a name.");
  if (name.trim().length > MAX_NAME_CHARS)
    throw new ScorerConfigError(
      `The scorer name is too long. Use ${MAX_NAME_CHARS} characters or fewer.`,
    );
  return name.trim();
}

export function parseThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ScorerConfigError("The good threshold must be a number from 0 to 1.");
  }
  return value;
}

function parseCheck(config: Record<string, unknown>): CheckConfig {
  const path = config.path;
  if (typeof path !== "string" || !path.trim())
    throw new ScorerConfigError(
      'The check has no path. Give a run field, for example "latencyMs".',
    );
  checkRoot(path.trim(), "The check path");
  const op = config.op;
  if (typeof op !== "string" || !(CHECK_OPS as readonly string[]).includes(op)) {
    throw new ScorerConfigError(
      `Unknown check operator "${String(op)}". Use one of: ${CHECK_OPS.join(", ")}.`,
    );
  }
  const checkOp = op as CheckOp;
  if (VALUE_FREE_OPS.has(checkOp)) return { path: path.trim(), op: checkOp };
  if (!("value" in config) || config.value === undefined)
    throw new ScorerConfigError(`The check operator "${op}" needs a value.`);
  if (
    NUMBER_OPS.has(checkOp) &&
    (typeof config.value !== "number" || !Number.isFinite(config.value))
  ) {
    throw new ScorerConfigError(`The check operator "${op}" needs a number value.`);
  }
  if (PATTERN_OPS.has(checkOp)) compilePattern(config.value);
  return { path: path.trim(), op: checkOp, value: config.value };
}

/** Compile a check's or an expression's regular expression. Throws `ScorerConfigError` when it is not valid. */
export function compilePattern(pattern: unknown): RegExp {
  if (typeof pattern !== "string" || !pattern)
    throw new ScorerConfigError("The pattern must be a non-empty string.");
  if (pattern.length > MAX_PATTERN_CHARS)
    throw new ScorerConfigError(
      `The pattern is too long. Use ${MAX_PATTERN_CHARS} characters or fewer.`,
    );
  try {
    return new RegExp(pattern, "i");
  } catch (error) {
    throw new ScorerConfigError(
      `The pattern is not a valid regular expression: ${(error as Error).message}.`,
    );
  }
}

function parseExpression(config: Record<string, unknown>): ExpressionConfig {
  const logic = config.logic;
  if (!jsonLogic.is_logic(logic as jsonLogic.RulesLogic)) {
    throw new ScorerConfigError(
      'The expression is not JSONLogic. Give an object with one operator, for example {"<=": [{"var": "latencyMs"}, 3000]}.',
    );
  }
  walkLogic(logic, true, 0);
  try {
    jsonLogic.apply(
      logic as jsonLogic.RulesLogic,
      viewOf({
        messages: [],
        toolCalls: [],
        finalAnswer: null,
        latencyMs: 0,
        costUsd: 0,
        tokens: { input: 0, output: 0 },
      }) as unknown as Record<string, unknown>,
    );
  } catch (error) {
    throw new ScorerConfigError(
      `The expression fails on an empty run: ${(error as Error).message}.`,
    );
  }
  return { logic: logic as Record<string, unknown> };
}

function walkLogic(node: unknown, readsRun: boolean, depth: number): void {
  if (depth > MAX_EXPRESSION_DEPTH)
    throw new ScorerConfigError(
      `The expression is too deep. Use ${MAX_EXPRESSION_DEPTH} levels or fewer.`,
    );
  if (Array.isArray(node)) {
    for (const item of node) walkLogic(item, readsRun, depth + 1);
    return;
  }
  if (!jsonLogic.is_logic(node as jsonLogic.RulesLogic)) return;
  const op = jsonLogic.get_operator(node as Record<string, unknown>);
  if (!(EXPRESSION_OPS as readonly string[]).includes(op)) {
    throw new ScorerConfigError(
      `Unknown JSONLogic operator "${op}". Use one of: ${EXPRESSION_OPS.join(", ")}.`,
    );
  }
  const args = (node as Record<string, unknown>)[op];
  if (op === "var" && readsRun) {
    const path = Array.isArray(args) ? args[0] : args;
    if (typeof path === "string" && path !== "") checkRoot(path, "The expression variable");
  }
  const list = Array.isArray(args) ? args : [args];
  list.forEach((arg, index) =>
    walkLogic(arg, ELEMENT_OPS.has(op) && index > 0 ? false : readsRun, depth + 1),
  );
}

function checkRoot(path: string, what: string): void {
  const root = path.split(".")[0]!;
  if (!(VIEW_FIELDS as readonly string[]).includes(root)) {
    throw new ScorerConfigError(
      `${what} "${path}" does not start with a run field. Use one of: ${VIEW_FIELDS.join(", ")}.`,
    );
  }
}

function parseJudge(config: Record<string, unknown>): JudgeConfig {
  const criteria = config.criteria;
  if (typeof criteria !== "string" || !criteria.trim())
    throw new ScorerConfigError("The judge has no criteria. Say what a good run does.");
  if (criteria.length > MAX_CRITERIA_CHARS)
    throw new ScorerConfigError(
      `The criteria are too long. Use ${MAX_CRITERIA_CHARS} characters or fewer.`,
    );
  return { criteria: criteria.trim() };
}

function parseDecision(config: Record<string, unknown>): DecisionConfig {
  const question = config.question;
  if (typeof question !== "string" || !question.trim())
    throw new ScorerConfigError("The decision has no question. Ask one question about the run.");
  if (question.length > MAX_QUESTION_CHARS)
    throw new ScorerConfigError(
      `The question is too long. Use ${MAX_QUESTION_CHARS} characters or fewer.`,
    );
  if (
    !Array.isArray(config.options) ||
    config.options.length < 2 ||
    config.options.length > MAX_OPTIONS
  ) {
    throw new ScorerConfigError(`The decision needs from 2 to ${MAX_OPTIONS} options.`);
  }
  const options = config.options.map((option, index) => {
    const item = asObject(option, `option ${index + 1}`);
    if (typeof item.id !== "string" || !item.id.trim() || item.id.length > 64)
      throw new ScorerConfigError(`Option ${index + 1} needs an id of 1 to 64 characters.`);
    if (typeof item.label !== "string" || !item.label.trim() || item.label.length > 500)
      throw new ScorerConfigError(`Option ${index + 1} needs a label of 1 to 500 characters.`);
    return { id: item.id.trim(), label: item.label.trim() };
  });
  const ids = new Set(options.map((option) => option.id));
  if (ids.size !== options.length)
    throw new ScorerConfigError("Two options have the same id. Give each option its own id.");
  if (!Array.isArray(config.pass) || config.pass.length === 0)
    throw new ScorerConfigError(
      "The decision has no passing option. Name at least one option id in pass.",
    );
  const pass = config.pass.map((id) => {
    if (typeof id !== "string" || !ids.has(id))
      throw new ScorerConfigError(`The passing option "${String(id)}" is not one of the options.`);
    return id;
  });
  if (pass.length === options.length)
    throw new ScorerConfigError("Every option passes. Leave at least one option that fails.");
  return { question: question.trim(), options, pass: [...new Set(pass)] };
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ScorerConfigError(`The ${what} must be an object.`);
  return value as Record<string, unknown>;
}
