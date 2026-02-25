import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { MastraAgent } from "@ag-ui/mastra";
import { AgentifiedMastraAdapter } from "@agentified/mastra";
import { Agentified } from "@agentified/sdk";
import type { DiscoverTool, DiscoverToolInput, RankedTool, ServerTool } from "@agentified/sdk";
import { z } from "zod";
import { buildMastraToolsFromRanked } from "./tools/mastra-tools.js";

interface CreateRequestAgentConfig {
  ranked: RankedTool[];
  agentifiedUrl: string;
  sdkTools: ServerTool[];
  systemPrompt: string;
}

export function createRequestAgent(config: CreateRequestAgentConfig) {
  // Mutable ref — adapter assigned after construction
  let adapter: AgentifiedMastraAdapter;

  const agentified = new Agentified({
    serverUrl: config.agentifiedUrl,
    tools: config.sdkTools,
    onEvent: (event) => adapter.onEvent(event),
  });

  const discoverMastraTool = wrapDiscoverTool(agentified.asDiscoverTool());
  const mastraTools = buildMastraToolsFromRanked(config.ranked);

  const coreAgent = new Agent({
    id: "quickhr",
    name: "quickhr",
    instructions: config.systemPrompt,
    model: "openai/gpt-5-nano",
    tools: { ...mastraTools, agentified_discover: discoverMastraTool },
  });

  const mastraAgent = new MastraAgent({ agent: coreAgent, resourceId: "quickhr" });
  adapter = new AgentifiedMastraAdapter({ mastraAgent });

  return { adapter };
}

export function wrapDiscoverTool(discoverTool: DiscoverTool) {
  return createTool({
    id: discoverTool.definition.name,
    description: discoverTool.definition.description,
    inputSchema: z.object({
      query: z.string(),
      limit: z.number().optional(),
    }),
    execute: async (input) =>
      discoverTool.execute(input as unknown as DiscoverToolInput),
  });
}
