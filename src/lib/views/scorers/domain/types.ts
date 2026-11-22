/**
 * The scorer model (RC-612): one scorer reads anything in a run record and
 * returns a value in 0..1, which passes when it reaches the scorer's good
 * threshold. Deterministic kinds (`check`, `expression`) need no I/O;
 * model-based kinds (`judge`, `decision`) ask a port.
 */

export const SCORER_KINDS = ["check", "expression", "judge", "decision"] as const;
export type ScorerKind = (typeof SCORER_KINDS)[number];

export const SCORER_SCOPES = ["task", "suite"] as const;
export type ScorerScope = (typeof SCORER_SCOPES)[number];

export const CHECK_OPS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "not_contains",
  "matches",
  "not_matches",
  "exists",
  "not_exists",
] as const;
export type CheckOp = (typeof CHECK_OPS)[number];

export const DEFAULT_GOOD_THRESHOLD = 0.5;

export type Outcome = "ok" | "error" | "unknown";

export interface RunMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface RunToolCall {
  name: string;
  arguments: Record<string, unknown> | null;
  result: unknown;
  outcome: Outcome;
  /** This step's own latency. Null when unknown. */
  latencyMs: number | null;
}

export interface RunTokens {
  input: number;
  output: number;
}

/** Everything a scorer can read about one run. Null means unknown. */
export interface RunRecord {
  messages: readonly RunMessage[] | null;
  toolCalls: readonly RunToolCall[] | null;
  /** False when the calls' outcomes are unknown, so how the run ended is unknown too. */
  outcomesKnown?: boolean;
  finalAnswer: string | null;
  /** False when the run never gave a final answer. Null or absent when unknown. */
  answered?: boolean | null;
  latencyMs: number | null;
  costUsd: number | null;
  tokens: RunTokens | null;
  /** The first search's listed tool ids, when the run searched. */
  firstList?: readonly string[] | null;
  /** False when the first search's list could not be read. */
  listKnown?: boolean;
}

export interface CheckConfig {
  /** A dotted path into the run view, for example `latencyMs` or `toolCalls.*.arguments.query`. */
  path: string;
  op: CheckOp;
  value?: unknown;
}

export interface ExpressionConfig {
  /** A JSONLogic expression over the run view. */
  logic: Record<string, unknown>;
}

export interface JudgeConfig {
  criteria: string;
}

export interface DecisionOptionConfig {
  id: string;
  label: string;
}

export interface DecisionConfig {
  question: string;
  options: DecisionOptionConfig[];
  /** The option ids that count as a pass. */
  pass: string[];
}

export type ScorerDefinition =
  | { kind: "check"; config: CheckConfig }
  | { kind: "expression"; config: ExpressionConfig }
  | { kind: "judge"; config: JudgeConfig }
  | { kind: "decision"; config: DecisionConfig };

export type Scorer = ScorerDefinition & {
  id: string;
  name: string;
  scope: ScorerScope;
  /** Null for a suite scorer. */
  taskId: string | null;
  enabled: boolean;
  goodThreshold: number;
  version: number;
};

export interface ScoreResult {
  scorerId: string;
  kind: ScorerKind;
  status: "pass" | "fail" | "skip";
  /** Null when skipped. */
  value: number | null;
  detail: string;
}

/** A per-eval switch for one scorer. */
export interface ScorerOverride {
  scorerId: string;
  enabled: boolean;
}
