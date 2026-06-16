import { invokeToolTool, searchCapabilitiesTool, type ToolCatalog } from "@ratel-ai/sdk";
import { type LanguageModel, stepCountIs, type Tool, ToolLoopAgent } from "ai";
import { toAISDKTool } from "./tools.js";

export type AgentResult = {
  text: string;
  steps: number;
  activeTools: string[];
  finishReason: string;
};

export async function runAgent(args: {
  prompt: string;
  model: LanguageModel;
  catalog: ToolCatalog;
  initialTopK?: number;
  maxSteps?: number;
}): Promise<AgentResult> {
  const { prompt, model, catalog } = args;
  const initialTopK = args.initialTopK ?? 3;
  const maxSteps = args.maxSteps ?? 8;

  const tools: Record<string, Tool> = {
    search_capabilities: toAISDKTool(searchCapabilitiesTool(catalog)),
    invoke_tool: toAISDKTool(invokeToolTool(catalog)),
  };
  for (const hit of catalog.search(prompt, initialTopK)) {
    const exec = catalog.getExecutable(hit.toolId);
    if (exec) tools[exec.id] = toAISDKTool(exec);
  }

  console.log(`active tools: ${Object.keys(tools).join(", ")}`);

  const agent = new ToolLoopAgent({
    model,
    tools,
    toolChoice: "auto",
    stopWhen: stepCountIs(maxSteps),
  });

  const result = await agent.generate({ prompt });

  result.steps.forEach((step, i) => {
    if (step.toolCalls.length === 0) return;
    console.log(`step ${i + 1}:`);
    for (const call of step.toolCalls) {
      console.log(`  → ${call.toolName}(${JSON.stringify(call.input)})`);
    }
  });

  return {
    text: result.text,
    steps: result.steps.length,
    activeTools: Object.keys(tools),
    finishReason: result.finishReason,
  };
}
