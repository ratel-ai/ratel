import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { mastra } from "@ratel-ai/mastra";
import { ratel, type RatelConfig } from "@ratel-ai/sdk";
import { tools } from "./tools.js";

export type AgentResult = {
  text: string;
  /** The model-facing tools — Ratel's three capability tools, not the app's six. */
  exposedTools: string[];
};

/** A Ratel core adapted to Mastra with the example's tools registered. */
export function buildView(config?: RatelConfig) {
  const view = ratel(config).adaptTo(mastra());
  view.tools.register(tools);
  return view;
}

/**
 * Wire the adapted view into a Mastra Agent and run one turn. The Agent only ever
 * sees the three capability tools (`view.modelTools()`); `recallProcessor()` injects a
 * ranked `search_capabilities` result for the prompt before the model runs.
 */
export async function runAgent(args: {
  prompt: string;
  model: MastraModelConfig;
  view: ReturnType<typeof buildView>;
}): Promise<AgentResult> {
  const agent = new Agent({
    id: "ratel-mastra-example",
    name: "ratel-mastra-example",
    instructions:
      "You are a coding assistant. Your tools are hidden behind `search_capabilities` — " +
      "call it to find the right tool, then `invoke_tool` to run it. Answer once the task is done.",
    model: args.model,
    tools: args.view.modelTools(),
    inputProcessors: [args.view.recallProcessor()],
  });
  const result = await agent.generate(args.prompt);
  return { text: result.text, exposedTools: Object.keys(args.view.modelTools()) };
}
