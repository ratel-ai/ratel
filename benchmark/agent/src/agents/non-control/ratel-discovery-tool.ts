// ratel (discovery-tool only) — only the `search_tools` / `invoke_tool`
// gateway is exposed, with no BM25 pre-fetch. The model has to discover
// every tool it wants to use via the gateway. Ablation that answers: "given
// a strong index, can the agent find tools on its own?"
//
// If this arm matches `ratel-full`, pre-discovery is just a latency hack — the
// agent could have found everything itself; if it lags noticeably (extra
// turns, more search calls, lower selection accuracy), pre-discovery is
// where the headline savings actually come from.

import { invokeToolTool, searchToolsTool, ToolCatalog } from "@ratel-ai/sdk";
import type { AgentDescriptor, AgentRunInput, ToolSpec } from "../../types.js";
import { emptyToolBundle, registerGateway, runMeteredLoop, type ToolBundle } from "../_shared.js";

const ID = "ratel-discovery-tool";

/**
 * Construct the AI SDK tool bundle for one ratel-discovery-tool cell. Exposed
 * for unit testing; `descriptor.run` is a thin wrapper around it.
 */
export function buildRatelDiscoveryToolBundle(input: { pool: ToolSpec[] }): {
  bundle: ToolBundle;
  catalog: ToolCatalog;
} {
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

  // Gateway only — no pre-fetched direct tools. The agent has to call
  // `search_tools` to find anything; this is the "BM25 quality + agent
  // self-discovery" probe.
  const bundle = emptyToolBundle();
  registerGateway(searchToolsTool(catalog), bundle);
  registerGateway(invokeToolTool(catalog), bundle);

  return { bundle, catalog };
}

export const descriptor: AgentDescriptor = {
  id: ID,
  label: "ratel (discovery-tool only)",
  run: async (input: AgentRunInput) => {
    const { bundle } = buildRatelDiscoveryToolBundle(input);
    return runMeteredLoop(ID, input, bundle);
  },
};
