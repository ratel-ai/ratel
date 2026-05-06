// Metering: wraps an agent run, captures every metric we report on, and emits a
// CellResult ready for JSONL persistence. Structural typing on the result lets
// us swap providers/SDK versions without coupling the meter to a specific shape.

import { createRequire } from "node:module";
import { INVOKE_TOOL_ID, SEARCH_TOOLS_ID } from "@ratel-ai/sdk";
import type { Arm, CellResult, ProgrammaticVerdict, ToolCall } from "./types.js";

// Resolve the installed SDK version once. Used as the `ratel_version` row
// dimension and (downstream) cache-key component, so a campaign run is
// "ratel v0.1.4 ran on this corpus" rather than "whatever was on the tree".
export const SDK_VERSION: string = (() => {
  const requirePkg = createRequire(import.meta.url);
  const pkg = requirePkg("@ratel-ai/sdk/package.json") as { version: string };
  return pkg.version;
})();

/** Loose shape of `agent.generate()` output we depend on. Keeps us decoupled from AI SDK internals. */
export interface AgentLikeResult {
  text?: string;
  finishReason?: string;
  steps: Array<{
    toolCalls?: Array<{ toolName: string; input?: unknown }>;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      cacheCreationInputTokens?: number;
      totalTokens?: number;
    };
  }>;
}

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** USD per 1M cached input tokens (read). */
  cachedInputPer1M: number;
  /** USD per 1M cache-creation tokens (Anthropic). */
  cacheCreationPer1M: number;
}

export type PricingTable = Record<string, ModelPrice>;

/**
 * Default price table for v0.1.1 reporting. List prices as of mid-2026; update
 * when models change. Costs are estimates — the JSONL row keeps raw tokens, so
 * a stale price table is recoverable downstream.
 */
export const DEFAULT_PRICING: PricingTable = {
  "gpt-5.4-mini": {
    inputPer1M: 0.4,
    outputPer1M: 1.6,
    cachedInputPer1M: 0.1,
    cacheCreationPer1M: 0,
  },
  "gpt-5-mini": {
    inputPer1M: 0.4,
    outputPer1M: 1.6,
    cachedInputPer1M: 0.1,
    cacheCreationPer1M: 0,
  },
  "claude-sonnet-4-6": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cachedInputPer1M: 0.3,
    cacheCreationPer1M: 3.75,
  },
  "claude-haiku-4-5": {
    inputPer1M: 1.0,
    outputPer1M: 5.0,
    cachedInputPer1M: 0.1,
    cacheCreationPer1M: 1.25,
  },
};

export function dollarCost(
  modelId: string,
  tokens: {
    input: number;
    output: number;
    cachedInput: number;
    cacheCreation: number;
  },
  pricing: PricingTable = DEFAULT_PRICING,
): number {
  const price = pricing[modelId];
  // Unknown models (incl. `ollama:*` local runs) intentionally return $0 — the
  // caller can spot a stale price table by cross-referencing raw tokens with
  // expected provider rates. For local runs the $0 is real, not stale.
  if (!price) return 0;
  return (
    (tokens.input * price.inputPer1M +
      tokens.output * price.outputPer1M +
      tokens.cachedInput * price.cachedInputPer1M +
      tokens.cacheCreation * price.cacheCreationPer1M) /
    1_000_000
  );
}

export interface MeterContext {
  scenarioId: string;
  arm: Arm;
  model: string;
  runIndex: number;
  /** Tools the model directly sees this run (= `ToolBundle.activeToolIds.length`). */
  catalogSize: number;
  /**
   * Universe the BM25 ranked against this run (gold + distractors). `null` for
   * pool-size-agnostic arms (e.g. `control-oracle`), which the runner emits once
   * per scenario regardless of `--pool-sizes`.
   */
  poolSize: number | null;
  seed: number;
  /**
   * Map from AI-SDK function name → canonical tool id for direct (non-gateway)
   * tools. Provider tool-name pattern forces sanitization, so the trace's
   * `toolName` may differ from the canonical id; this map restores it.
   */
  nameToId?: ReadonlyMap<string, string>;
}

const GATEWAY_NAMES = new Set<string>([SEARCH_TOOLS_ID, INVOKE_TOOL_ID]);

/**
 * Run `generate`, time it, and roll the result into a `CellResult`. Returns the
 * row plus the trace of tool calls so judges can run on the same captured data
 * without re-driving the agent.
 */
export async function meter(
  ctx: MeterContext,
  generate: () => Promise<AgentLikeResult>,
  pricing: PricingTable = DEFAULT_PRICING,
): Promise<{ cell: CellResult; raw: AgentLikeResult | null }> {
  const startedAt = Date.now();
  let raw: AgentLikeResult | null = null;
  let error: string | null = null;
  try {
    raw = await generate();
  } catch (err) {
    error = (err as Error).message ?? String(err);
  }
  const wallMs = Date.now() - startedAt;

  const summary = summarize(raw, ctx.nameToId);
  const dollars = dollarCost(
    ctx.model,
    {
      input: summary.inputTokens,
      output: summary.outputTokens,
      cachedInput: summary.cachedInputTokens,
      cacheCreation: summary.cacheCreationTokens,
    },
    pricing,
  );

  const cell: CellResult = {
    scenario_id: ctx.scenarioId,
    arm: ctx.arm,
    model: ctx.model,
    run_index: ctx.runIndex,
    ratel_version: SDK_VERSION,
    catalog_size: ctx.catalogSize,
    pool_size: ctx.poolSize,
    seed: ctx.seed,
    input_tokens: summary.inputTokens,
    output_tokens: summary.outputTokens,
    cached_input_tokens: summary.cachedInputTokens,
    cache_creation_tokens: summary.cacheCreationTokens,
    total_tokens: summary.totalTokens,
    tool_calls_total: summary.toolCallsTotal,
    tool_calls_unique: summary.toolCallsUnique,
    gateway_calls: summary.gatewayCalls,
    non_gateway_calls: summary.nonGatewayCalls,
    turns: summary.turns,
    effective_tool_ids: summary.effectiveToolIds,
    programmatic_verdict: "n/a" as ProgrammaticVerdict,
    judge_verdict: "n/a",
    final_text: raw?.text ?? "",
    finish_reason: raw?.finishReason ?? (error ? "error" : "unknown"),
    error,
    wall_ms: wallMs,
    dollar_cost: dollars,
    tool_calls: summary.toolCalls,
  };
  return { cell, raw };
}

interface Summary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  toolCallsTotal: number;
  toolCallsUnique: number;
  gatewayCalls: number;
  nonGatewayCalls: number;
  turns: number;
  toolCalls: ToolCall[];
  effectiveToolIds: string[];
}

/**
 * Unwrap `invoke_tool` calls into the underlying tool that was actually invoked.
 * `search_tools` is dropped (it's a lookup, not an invocation). Direct tool calls
 * (no gateway) pass through unchanged. This is what the programmatic judge
 * compares against the gold trace.
 */
export function effectiveToolIds(calls: ToolCall[]): string[] {
  const out: string[] = [];
  for (const call of calls) {
    if (call.toolId === SEARCH_TOOLS_ID) continue;
    if (call.toolId === INVOKE_TOOL_ID) {
      const inner = call.args?.toolId;
      if (typeof inner === "string") out.push(inner);
      continue;
    }
    out.push(call.toolId);
  }
  return out;
}

export function summarize(
  result: AgentLikeResult | null,
  nameToId?: ReadonlyMap<string, string>,
): Summary {
  if (!result) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      toolCallsTotal: 0,
      toolCallsUnique: 0,
      gatewayCalls: 0,
      nonGatewayCalls: 0,
      turns: 0,
      toolCalls: [],
      effectiveToolIds: [],
    };
  }
  let input = 0;
  let output = 0;
  let cached = 0;
  let cacheCreation = 0;
  let total = 0;
  const calls: ToolCall[] = [];
  let gateway = 0;
  let nonGateway = 0;
  for (const step of result.steps) {
    const u = step.usage;
    if (u) {
      input += u.inputTokens ?? 0;
      output += u.outputTokens ?? 0;
      cached += u.cachedInputTokens ?? 0;
      cacheCreation += u.cacheCreationInputTokens ?? 0;
      total += u.totalTokens ?? 0;
    }
    for (const call of step.toolCalls ?? []) {
      const args =
        typeof call.input === "object" && call.input !== null
          ? (call.input as Record<string, unknown>)
          : {};
      // Map sanitized function names back to canonical ids for direct tools;
      // gateway tools (search_tools / invoke_tool) pass through unchanged.
      const canonical = nameToId?.get(call.toolName) ?? call.toolName;
      calls.push({ toolId: canonical, args });
      if (GATEWAY_NAMES.has(canonical)) gateway++;
      else nonGateway++;
    }
  }
  // Some providers don't surface `totalTokens`; fall back to input + output.
  if (total === 0) total = input + output + cached;
  const unique = new Set(calls.map((c) => c.toolId)).size;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    cacheCreationTokens: cacheCreation,
    totalTokens: total,
    toolCallsTotal: calls.length,
    toolCallsUnique: unique,
    gatewayCalls: gateway,
    nonGatewayCalls: nonGateway,
    turns: result.steps.length,
    toolCalls: calls,
    effectiveToolIds: effectiveToolIds(calls),
  };
}
