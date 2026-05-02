// Shared types. Mirror the Rust `Scenario` shape from
// `benchmark/retrieval/src/corpus.rs` so both layers consume the same JSONL
// files without an adapter.

import type { LanguageModel } from "ai";

export interface ToolSpec {
  id: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  prompt: string;
  candidate_pool: ToolSpec[];
  gold_tools: string[];
  judge_criteria?: string;
  category?: string;
}

/**
 * Arm id, matching `AgentDescriptor.id` of the agent that produced the row.
 * Loose string so the registry can grow (control-baseline, control-oracle,
 * ratel-full, ratel-pre-discovery, ratel-discovery-tool, claude-sdk-...).
 */
export type Arm = string;

export interface ToolCall {
  toolId: string;
  args: Record<string, unknown>;
}

export type ProgrammaticVerdict = "pass" | "fail" | "n/a";
export type JudgeVerdict = "pass" | "fail" | "partial" | "n/a";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

/**
 * Per-agent contract. Each file under `agents/` (control or non-control)
 * exports a `descriptor: AgentDescriptor`. The runner builds a registry
 * (`id` → descriptor) at startup, then dispatches each cell to
 * `descriptor.run(input)`. The agent function is end-to-end: it constructs
 * tools, runs the agent loop, calls `meter(...)`, and returns the metered
 * cell. The runner overlays the judging fields (programmatic + LLM) and the
 * cell's `arm` is set to the descriptor id.
 *
 * `skipForModel(modelId)` lets a descriptor opt out for incompatible models —
 * e.g. the claude-sdk arm declines non-Claude models.
 */
export interface AgentRunInput {
  scenario: Scenario;
  /** Expanded pool (gold + distractors) at config.poolSize. Same across arms in a cell. */
  pool: ToolSpec[];
  model: { id: string; model: LanguageModel };
  runIndex: number;
  topK: number;
  maxSteps: number;
  perRunTimeoutMs: number;
  seed: number;
  /** Optional pricing override (defaults applied inside metering). */
  pricing?: unknown;
}

export interface AgentDescriptor {
  /** Stable arm id; written verbatim to `CellResult.arm`. */
  id: string;
  /** Display label for logs and the report. */
  label: string;
  skipForModel?: (modelId: string) => boolean;
  run: (input: AgentRunInput) => Promise<CellResult>;
}

export interface CellResult {
  scenario_id: string;
  arm: Arm;
  model: string;
  run_index: number;
  /** Tools the model directly sees this run (= what its context pays for). */
  catalog_size: number;
  /** Universe the BM25 ranked against this run (gold + distractors). Same across arms in a cell. */
  pool_size: number;
  seed: number;
  // Tokens
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  // Tool dynamics
  tool_calls_total: number;
  tool_calls_unique: number;
  gateway_calls: number;
  non_gateway_calls: number;
  turns: number;
  /** Tool ids actually invoked (invoke_tool unwrapped to its inner toolId; search_tools dropped). */
  effective_tool_ids: string[];
  // Outcome
  programmatic_verdict: ProgrammaticVerdict;
  judge_verdict: JudgeVerdict;
  final_text: string;
  finish_reason: string;
  error: string | null;
  // Performance
  wall_ms: number;
  dollar_cost: number;
  // Trace
  tool_calls: ToolCall[];
}
