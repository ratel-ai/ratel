// Helpers shared across every agent file (control + non-control). Each agent
// file is otherwise self-contained — it imports these utilities, builds its
// tool dictionary, runs the agent loop via `meter(...)`, and returns the
// CellResult. Keeping the boilerplate here means the agent files read like
// "this is how you wire up Ratel" instead of being mostly schema-normalization.

import type { ExecutableTool } from "@ratel-ai/sdk";
import { type Tool as AISDKTool, jsonSchema, stepCountIs, ToolLoopAgent, tool } from "ai";
import { type AgentLikeResult, meter, type PricingTable } from "../metering.js";
import type { AgentRunInput, CellResult, ToolSpec } from "../types.js";

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

/**
 * Bundle the executor with each tool definition. The benchmark corpora ship no
 * canned responses, so the executor returns a fixed stub — what matters is the
 * agent's *selection*, not the response payload (per ADR-0006).
 */
export function toExecutable(spec: ToolSpec): ExecutableTool {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    inputSchema: spec.input_schema,
    outputSchema: spec.output_schema ?? {},
    execute: async (_args) => ({ _stub: "stubbed for benchmark", toolId: spec.id }),
  };
}

export function toAISDK(exec: ExecutableTool): AISDKTool {
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
export function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  const obj = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
  if (typeof obj.type === "string") return obj;
  return { ...obj, type: "object" };
}

export interface ToolBundle {
  /** Map of (sanitized) tool name → AI SDK tool, ready for `new ToolLoopAgent({ tools })`. */
  tools: Record<string, AISDKTool>;
  /**
   * Canonical ids of every tool exposed to the agent — both direct tools and
   * gateway tools (`search_tools` / `invoke_tool`). This is the "what did the
   * agent see" count surfaced as the `catalog` column in the report.
   */
  activeToolIds: string[];
  /**
   * Sanitized-name → canonical-id, for direct (non-gateway) tools. Provider APIs
   * require tool names to match `^[a-zA-Z0-9_-]+$`, so ids with dots etc. get
   * rewritten before being handed to the SDK. Metering uses this to map the
   * trace's `toolName` back to the canonical id.
   */
  nameToId: Map<string, string>;
}

/** Register one ToolSpec into the bundle, sanitizing its id and detecting collisions. */
export function registerDirect(spec: ToolSpec, bundle: ToolBundle): void {
  const exec = toExecutable(spec);
  const name = sanitizeToolName(exec.id);
  if (Object.hasOwn(bundle.tools, name)) {
    throw new Error(
      `tool name collision after sanitization: "${name}" is already registered ` +
        `(would clash with id "${exec.id}"). Rename one of the tool ids.`,
    );
  }
  bundle.tools[name] = toAISDK(exec);
  bundle.nameToId.set(name, exec.id);
  bundle.activeToolIds.push(exec.id);
}

/**
 * Register a gateway tool (`search_tools` / `invoke_tool`) into the bundle.
 * Like `registerDirect` but skips the sanitization+nameToId path (gateway ids
 * are already provider-safe and don't need invoke-trace unwrapping). Pushes
 * onto `activeToolIds` so the catalog count includes gateway tools.
 */
export function registerGateway(exec: ExecutableTool, bundle: ToolBundle): void {
  if (Object.hasOwn(bundle.tools, exec.name)) {
    throw new Error(`gateway tool "${exec.name}" is already registered`);
  }
  bundle.tools[exec.name] = toAISDK(exec);
  bundle.activeToolIds.push(exec.id);
}

/** Build a fresh `ToolBundle` containing every spec in `specs`. */
export function buildToolBundle(specs: ToolSpec[]): ToolBundle {
  const bundle: ToolBundle = {
    tools: {},
    activeToolIds: [],
    nameToId: new Map(),
  };
  for (const spec of specs) {
    registerDirect(spec, bundle);
  }
  return bundle;
}

/** Empty bundle for agents whose tool surface is gateway-only (or otherwise non-spec-driven). */
export function emptyToolBundle(): ToolBundle {
  return { tools: {}, activeToolIds: [], nameToId: new Map() };
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`run timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

/**
 * Run the metered agent loop over `bundle.tools` and return a `CellResult` with
 * judging fields left as `n/a` (the runner overlays those). Each agent file
 * builds its own bundle (with whatever Ratel/SDK wiring it wants to demonstrate)
 * and then hands off to this helper for the loop + metering boilerplate, which
 * is identical across arms.
 */
export async function runMeteredLoop(
  armId: string,
  input: AgentRunInput,
  bundle: ToolBundle,
): Promise<CellResult> {
  const agent = new ToolLoopAgent({
    model: input.model.model,
    tools: bundle.tools,
    toolChoice: "auto",
    stopWhen: stepCountIs(input.maxSteps),
  });

  const generate = async (): Promise<AgentLikeResult> => {
    const result = await withTimeout(
      agent.generate({ prompt: input.scenario.prompt }),
      input.perRunTimeoutMs,
    );
    return result as unknown as AgentLikeResult;
  };

  const { cell } = await meter(
    {
      scenarioId: input.scenario.id,
      arm: armId,
      model: input.model.id,
      runIndex: input.runIndex,
      catalogSize: bundle.activeToolIds.length,
      poolSize: input.poolSize,
      seed: input.seed,
      nameToId: bundle.nameToId,
    },
    generate,
    input.pricing as PricingTable | undefined,
  );
  return cell;
}
