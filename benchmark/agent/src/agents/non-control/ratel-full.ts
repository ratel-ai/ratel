// ratel (full) — both Ratel layers active. BM25 top-K of the user prompt is
// pre-fetched from the catalog and registered as direct tools so the model
// sees its likely best moves up front; the `search_tools` / `invoke_tool`
// gateway tools are also exposed so the model can recover when pre-discovery
// missed the right tool. This is the canonical Ratel surface for ADR-0006
// mode (c) — every other Ratel arm is an ablation of this one.
//
// Read top-to-bottom this file is a worked example of "how to use
// `@ratel-ai/sdk` end-to-end": construct catalog → register pool → run
// `catalog.search` for pre-discovery → wire gateway tools → drive the AI
// SDK's tool loop.

import { invokeToolTool, searchToolsTool, ToolCatalog } from "@ratel-ai/sdk";
import type { AgentDescriptor, AgentRunInput, Scenario, ToolSpec } from "../../types.js";
import {
  emptyToolBundle,
  registerDirect,
  registerGateway,
  runMeteredLoop,
  type ToolBundle,
} from "../_shared.js";

const ID = "ratel-full";

/**
 * Construct the catalog + AI SDK tool bundle for one ratel-full cell. Exposed
 * (rather than inlined into `descriptor.run`) so the integration logic — the
 * load-bearing piece of this arm — is unit-testable without spinning up an
 * agent loop. The `descriptor.run` below is then a thin wrapper.
 */
export function buildRatelFullBundle(input: {
  scenario: Pick<Scenario, "prompt">;
  pool: ToolSpec[];
  topK: number;
}): { bundle: ToolBundle; catalog: ToolCatalog } {
  // 1. Catalog backs both layers: pre-discovery uses it for BM25, and the
  //    gateway tools call back into the same instance to search/invoke at
  //    agent runtime.
  const catalog = new ToolCatalog();
  for (const spec of input.pool) {
    catalog.register({
      id: spec.id,
      name: spec.name,
      description: spec.description,
      inputSchema: spec.input_schema,
      outputSchema: spec.output_schema ?? {},
      execute: async () => ({ _stub: "stubbed for benchmark", toolId: spec.id }),
    });
  }

  const bundle = emptyToolBundle();

  // 2. Gateway: expose `search_tools` + `invoke_tool`. The agent can call
  //    these mid-loop to find/invoke any tool in the full pool — not just
  //    the pre-discovered top-K — which makes pre-discovery best-effort
  //    rather than load-bearing.
  registerGateway(searchToolsTool(catalog), bundle);
  registerGateway(invokeToolTool(catalog), bundle);

  // 3. Pre-discovery: BM25 top-K of the prompt, registered as direct tools.
  //    Cheap context-window win when retrieval gets it right; the gateway
  //    above is the safety net when it doesn't.
  for (const hit of catalog.search(input.scenario.prompt, input.topK)) {
    const exec = catalog.getExecutable(hit.toolId);
    if (!exec) continue;
    const spec: ToolSpec = {
      id: exec.id,
      name: exec.name,
      description: exec.description,
      input_schema: exec.inputSchema as Record<string, unknown>,
      output_schema: (exec.outputSchema as Record<string, unknown>) ?? {},
    };
    registerDirect(spec, bundle);
  }

  return { bundle, catalog };
}

export const descriptor: AgentDescriptor = {
  id: ID,
  label: "ratel (full)",
  run: async (input: AgentRunInput) => {
    const { bundle } = buildRatelFullBundle(input);
    return runMeteredLoop(ID, input, bundle);
  },
};
