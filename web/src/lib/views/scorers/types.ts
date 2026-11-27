import type { CheckConfig } from "@/lib/contracts/check";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";

/** A project-level scorer: what it reads on a trace, which traces, and how many of them. */

export const SCORER_KINDS = ["check", "judge", "preset"] as const;
export type ScorerKind = (typeof SCORER_KINDS)[number];

export {
  ATTRIBUTE_PREFIX,
  CHECK_OPERATORS,
  type CheckConfig,
  type CheckOperator,
  type CheckValue,
  TRACE_FIELDS,
  type TraceField,
} from "@/lib/contracts/check";

/** `boolean` answers pass or fail; `numeric` answers 1 to 5. */
export const JUDGE_OUTPUTS = ["boolean", "numeric"] as const;
export type JudgeOutput = (typeof JUDGE_OUTPUTS)[number];

export interface JudgeConfig {
  prompt: string;
  output: JudgeOutput;
}

/**
 * A task kind of `views/task-scorers` that grades one run of a task. A preset scores the traces of
 * its tasks with the run (`trace_turns`) each belongs to, as `task-scorers/engine.ts` grades it.
 * `judge_criteria` is no preset: it is a judge.
 */
export const PRESET_KINDS = [
  "ends_well",
  "max_self_corrections",
  "max_latency_ms",
  "max_cost_usd",
  "expected_tool",
  "max_tool_calls",
] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];

/** A preset as stored: the task kind under `preset`, with its setting. */
export type PresetConfig =
  | { preset: "ends_well" }
  | {
      preset: "max_self_corrections" | "max_latency_ms" | "max_cost_usd" | "max_tool_calls";
      max: number;
    }
  | { preset: "expected_tool"; tool: string };

export type ScorerDefinition =
  | { kind: "check"; config: CheckConfig }
  | { kind: "judge"; config: JudgeConfig }
  | { kind: "preset"; config: PresetConfig };

/** The Traces filter, as a scorer stores it. */
export type ScorerFilter = TraceFilter;

export type ScorerScope = "all" | "tasks";

/** Which traces a scorer takes. */
export interface ScorerTarget {
  filter: ScorerFilter;
  /**
   * Null: the traces of every task and of none. Otherwise only the traces of these tasks' turns
   * (`trace_turns.workflow_id`), so an empty list takes no trace.
   */
  tasks: readonly string[] | null;
}

/** What a person writes. */
export type ScorerDraft = ScorerDefinition &
  ScorerTarget & {
    name: string;
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
  /** The model answered, with nothing that can be stored. */
  | "no_answer"
  /** The call failed, so there is no answer yet. */
  | "call_failed"
  /** Preset only: the trace belongs to no closed run of the scorer's tasks. */
  | "no_run"
  /** Preset only: the run does not have the measurement. */
  | "not_measured";
