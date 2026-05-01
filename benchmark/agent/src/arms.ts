// Arm builders. Each one takes a scenario and returns the tool dictionary that
// gets handed to a Vercel AI SDK ToolLoopAgent. Every arm uses the same stub
// executor so the only variable across arms is *which tools the agent sees*.

import {
  type ExecutableTool,
  INVOKE_TOOL_ID,
  invokeToolTool,
  SEARCH_TOOLS_ID,
  searchToolsTool,
  ToolCatalog,
} from "@ratel-ai/sdk";
import { type Tool as AISDKTool, jsonSchema, tool } from "ai";
import type { Arm, GoldCall, Scenario, ToolSpec } from "./types.js";

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
  stubs: Map<string, unknown>,
  tools: Record<string, AISDKTool>,
  nameToId: Map<string, string>,
  activeToolIds: string[],
): void {
  const exec = toExecutable(spec, stubs);
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

/** Bundle the executor + stub responses with each tool definition. */
function toExecutable(spec: ToolSpec, stubResponses: Map<string, unknown>): ExecutableTool {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    inputSchema: spec.input_schema,
    outputSchema: spec.output_schema ?? {},
    execute: async (_args) => {
      const canned = stubResponses.get(spec.id);
      if (canned !== undefined) return canned;
      return { _stub: "no canned response for this tool", toolId: spec.id };
    },
  };
}

function buildStubMap(goldTrace: GoldCall[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const call of goldTrace) {
    if (!map.has(call.tool_id)) {
      map.set(call.tool_id, call.response ?? {});
    }
  }
  return map;
}

function toAISDK(exec: ExecutableTool): AISDKTool {
  return tool({
    description: exec.description,
    inputSchema: jsonSchema(exec.inputSchema as Record<string, unknown>),
    execute: exec.execute,
  });
}

/** Control arm — every tool in the candidate pool, no Ratel layer. */
export function buildControl(scenario: Scenario): BuiltArm {
  const stubs = buildStubMap(scenario.gold_trace);
  const tools: Record<string, AISDKTool> = {};
  const activeToolIds: string[] = [];
  const nameToId = new Map<string, string>();
  for (const spec of scenario.candidate_pool) {
    registerDirect(spec, stubs, tools, nameToId, activeToolIds);
  }
  return { arm: "control", tools, activeToolIds, nameToId };
}

/** Oracle arm — only the gold tools. The "model can't do better than this" upper bound. */
export function buildOracle(scenario: Scenario): BuiltArm {
  const stubs = buildStubMap(scenario.gold_trace);
  const goldSet = new Set(scenario.gold_tools);
  const tools: Record<string, AISDKTool> = {};
  const activeToolIds: string[] = [];
  const nameToId = new Map<string, string>();
  for (const spec of scenario.candidate_pool) {
    if (!goldSet.has(spec.id)) continue;
    registerDirect(spec, stubs, tools, nameToId, activeToolIds);
  }
  return { arm: "oracle", tools, activeToolIds, nameToId };
}

/** Hybrid arm — BM25 top-K from the candidate pool plus the two Ratel gateway tools. */
export function buildHybrid(scenario: Scenario, topK: number): BuiltArm {
  const stubs = buildStubMap(scenario.gold_trace);
  const catalog = new ToolCatalog();
  for (const spec of scenario.candidate_pool) {
    catalog.register(toExecutable(spec, stubs));
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
      stubs,
      tools,
      nameToId,
      activeToolIds,
    );
  }
  return { arm: "hybrid", tools, activeToolIds, nameToId, catalog };
}

/** Convenience: build any arm by name. */
export function buildArm(arm: Arm, scenario: Scenario, topK: number): BuiltArm {
  switch (arm) {
    case "control":
      return buildControl(scenario);
    case "hybrid":
      return buildHybrid(scenario, topK);
    case "oracle":
      return buildOracle(scenario);
  }
}
