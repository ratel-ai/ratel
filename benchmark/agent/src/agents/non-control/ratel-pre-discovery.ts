// ratel (pre-discovery only) — BM25 top-K of the user prompt is pre-fetched
// from the catalog and registered as direct tools, but the `search_tools` /
// `invoke_tool` gateway is *not* exposed. Ablation that answers: "did the
// pre-fetch alone suffice, or does the agent rely on the gateway as a
// fallback?"
//
// If this arm matches `ratel-full` on selection accuracy and tokens, the
// gateway is dead weight in this regime; if it lags, the gateway is doing
// real work for borderline retrievals.

import { ToolCatalog } from "@ratel-ai/sdk";
import type { AgentDescriptor, AgentRunInput, Scenario, ToolSpec } from "../../types.js";
import { emptyToolBundle, registerDirect, runMeteredLoop, type ToolBundle } from "../_shared.js";

const ID = "ratel-pre-discovery";

/**
 * Construct the AI SDK tool bundle for one ratel-pre-discovery cell. Exposed
 * for unit testing; `descriptor.run` is a thin wrapper around it.
 */
export function buildRatelPreDiscoveryBundle(input: {
  scenario: Pick<Scenario, "prompt">;
  pool: ToolSpec[];
  topK: number;
}): { bundle: ToolBundle; catalog: ToolCatalog } {
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

  // BM25 top-K only — no gateway, so the agent can't reach beyond what we
  // pre-fetched. This is the "is pre-discovery alone enough?" probe.
  const bundle = emptyToolBundle();
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
  label: "ratel (pre-discovery only)",
  run: async (input: AgentRunInput) => {
    const { bundle } = buildRatelPreDiscoveryBundle(input);
    return runMeteredLoop(ID, input, bundle);
  },
};
