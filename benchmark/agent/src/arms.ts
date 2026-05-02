// Arm builders. Each one takes a scenario and the expanded tool pool (gold +
// distractors, sized + ordered by `pool.expandPool`) and returns the tool
// dictionary that gets handed to a Vercel AI SDK ToolLoopAgent. Every arm uses
// the same stub executor — there are no canned responses for v0.1.1's corpora —
// so the only variable across arms is *which tools the agent sees*.

import {
  type ExecutableTool,
  INVOKE_TOOL_ID,
  invokeToolTool,
  SEARCH_TOOLS_ID,
  searchToolsTool,
  ToolCatalog,
} from "@ratel-ai/sdk";
import { type Tool as AISDKTool, jsonSchema, tool } from "ai";
import type { Arm, Scenario, ToolSpec } from "./types.js";

export interface BuiltArm {
  arm: Arm;
  /** Map of (sanitized) tool name → AI SDK tool, ready for `new ToolLoopAgent({ tools })`. */
  tools: Record<string, AISDKTool>;
  /** Ids of every non-gateway tool exposed to the agent (= "what the model can directly see"). */
  activeToolIds: string[];
  /**
   * Sanitized-name → canonical-id, for direct (non-gateway) tools. Provider APIs
   * require tool names to match `^[a-zA-Z0-9_-]+$`, so ids with dots etc. get
   * rewritten before being handed to the SDK. Metering uses this to map the
   * trace's `toolName` back to the canonical id.
   */
  nameToId: Map<string, string>;
  /** Catalog backing the hybrid arm; defined only for hybrid (used by the gateway tools). */
  catalog?: ToolCatalog;
}

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Sanitize a tool id into a provider-acceptable function name. */
export function sanitizeToolName(id: string): string {
  if (TOOL_NAME_PATTERN.test(id)) return id;
  const replaced = id.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  if (replaced.length === 0) {
    throw new Error(`tool id "${id}" sanitizes to an empty function name`);
  }
  return replaced;
}

function registerDirect(
  spec: ToolSpec,
  tools: Record<string, AISDKTool>,
  nameToId: Map<string, string>,
  activeToolIds: string[],
): void {
  const exec = toExecutable(spec);
  const name = sanitizeToolName(exec.id);
  if (Object.hasOwn(tools, name)) {
    throw new Error(
      `tool name collision after sanitization: "${name}" is already registered ` +
        `(would clash with id "${exec.id}"). Rename one of the tool ids.`,
    );
  }
  tools[name] = toAISDK(exec);
  nameToId.set(name, exec.id);
  activeToolIds.push(exec.id);
}

/**
 * Bundle the executor with each tool definition. v0.1.1's MetaTool/ToolRet
 * corpora ship no canned responses, so the executor returns a fixed stub —
 * what matters is the agent's *selection*, not the response payload (per
 * ADR-0006).
 */
function toExecutable(spec: ToolSpec): ExecutableTool {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    inputSchema: spec.input_schema,
    outputSchema: spec.output_schema ?? {},
    execute: async (_args) => ({ _stub: "stubbed for benchmark", toolId: spec.id }),
  };
}

function toAISDK(exec: ExecutableTool): AISDKTool {
  return tool({
    description: exec.description,
    inputSchema: jsonSchema(normalizeInputSchema(exec.inputSchema)),
    execute: exec.execute,
  });
}

/**
 * MetaTool ships plugin tools with `input_schema: {}` (no parameters declared).
 * Anthropic's API rejects any tool whose input_schema lacks `type: "object"`,
 * so we default the type here at the provider-translation seam. An empty JSON
 * Schema means "anything"; for a function-call signature the practical
 * equivalent is "object with no required properties".
 */
function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  const obj = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
  if (typeof obj.type === "string") return obj;
  return { ...obj, type: "object" };
}

/** Control arm — every tool in the expanded pool, no Ratel layer. */
export function buildControl(_scenario: Scenario, pool: ToolSpec[]): BuiltArm {
  const tools: Record<string, AISDKTool> = {};
  const activeToolIds: string[] = [];
  const nameToId = new Map<string, string>();
  for (const spec of pool) {
    registerDirect(spec, tools, nameToId, activeToolIds);
  }
  return { arm: "control", tools, activeToolIds, nameToId };
}

/**
 * Oracle arm — only the gold tools. The "model can't do better than this"
 * upper bound. Pulls gold specs from `scenario.candidate_pool` (where the
 * ingest contract guarantees they're present); the expanded pool is irrelevant
 * because oracle never sees distractors.
 */
export function buildOracle(scenario: Scenario): BuiltArm {
  const goldSet = new Set(scenario.gold_tools);
  const tools: Record<string, AISDKTool> = {};
  const activeToolIds: string[] = [];
  const nameToId = new Map<string, string>();
  for (const spec of scenario.candidate_pool) {
    if (!goldSet.has(spec.id)) continue;
    registerDirect(spec, tools, nameToId, activeToolIds);
  }
  return { arm: "oracle", tools, activeToolIds, nameToId };
}

/** Hybrid arm — BM25 top-K from the expanded pool plus the two Ratel gateway tools. */
export function buildHybrid(scenario: Scenario, pool: ToolSpec[], topK: number): BuiltArm {
  const catalog = new ToolCatalog();
  for (const spec of pool) {
    catalog.register(toExecutable(spec));
  }
  const tools: Record<string, AISDKTool> = {
    [SEARCH_TOOLS_ID]: toAISDK(searchToolsTool(catalog)),
    [INVOKE_TOOL_ID]: toAISDK(invokeToolTool(catalog)),
  };
  const activeToolIds: string[] = [];
  const nameToId = new Map<string, string>();
  const hits = catalog.search(scenario.prompt, topK);
  for (const hit of hits) {
    const exec = catalog.getExecutable(hit.toolId);
    if (!exec) continue;
    // Re-register through the same path so sanitization + collision checks apply.
    registerDirect(
      {
        id: exec.id,
        name: exec.name,
        description: exec.description,
        input_schema: exec.inputSchema as Record<string, unknown>,
        output_schema: (exec.outputSchema as Record<string, unknown>) ?? {},
      },
      tools,
      nameToId,
      activeToolIds,
    );
  }
  return { arm: "hybrid", tools, activeToolIds, nameToId, catalog };
}

/** Convenience: build any arm by name. */
export function buildArm(arm: Arm, scenario: Scenario, pool: ToolSpec[], topK: number): BuiltArm {
  switch (arm) {
    case "control":
      return buildControl(scenario, pool);
    case "hybrid":
      return buildHybrid(scenario, pool, topK);
    case "oracle":
      return buildOracle(scenario);
  }
}
