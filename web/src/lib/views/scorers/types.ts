import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";

/** A project-level scorer: what it reads on a trace, which traces, and how many of them. */

export const SCORER_KINDS = ["check", "judge"] as const;
export type ScorerKind = (typeof SCORER_KINDS)[number];

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

export type CheckValue = string | number | boolean;

/** `value` is absent for `exists` only. */
export interface CheckConfig {
  path: string;
  op: CheckOperator;
  value?: CheckValue;
}

/** `boolean` answers pass or fail; `numeric` answers 1 to 5. */
export const JUDGE_OUTPUTS = ["boolean", "numeric"] as const;
export type JudgeOutput = (typeof JUDGE_OUTPUTS)[number];

export interface JudgeConfig {
  prompt: string;
  output: JudgeOutput;
}

export type ScorerDefinition =
  | { kind: "check"; config: CheckConfig }
  | { kind: "judge"; config: JudgeConfig };

/** Which traces a scorer takes: the Traces filter, and the task whose runs it scores. */
export interface ScorerFilter extends TraceFilter {
  /** The traces of one task's turns (`trace_turns.workflow_id`); every task without it. */
  taskId?: string;
}

/** What a person writes. */
export type ScorerDraft = ScorerDefinition & {
  name: string;
  filter: ScorerFilter;
  /** Percent of the matching traces, 1 to 100. */
  sampleRate: number;
  enabled: boolean;
};

export type Scorer = ScorerDraft & {
  id: string;
  projectId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** What a scorer reads of one trace: its summary row and its root span's attributes. */
export interface ScorerTrace {
  traceId: string;
  startedAt: Date;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  error: boolean;
  models: readonly string[];
  tools: readonly string[];
  agents: readonly string[];
  mcpServers: readonly string[];
  service: string | null;
  environment: string | null;
  attributes: Readonly<Record<string, unknown>>;
}

/** One measured result. `passed` is null for a numeric judge; `confidence` is null for a check. */
export interface TraceScore {
  value: number;
  passed: boolean | null;
  confidence: number | null;
}

/** A result, or the reason a trace has none. A skip is never stored. */
export type ScoreOutcome =
  | { status: "scored"; score: TraceScore }
  | { status: "skipped"; reason: SkipReason };

export type SkipReason =
  | "missing_attribute"
  | "not_a_number"
  | "no_engine"
  | "no_content"
  | "budget_spent"
  | "no_answer";
