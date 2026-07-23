import { ratel } from "@ratel-ai/sdk";
import { aiSdk } from "@ratel-ai/vercel-ai-sdk";
import { type LanguageModel, stepCountIs, ToolLoopAgent } from "ai";
import { tools } from "./tools.js";

export type AgentResult = {
  text: string;
  steps: number;
  activeTools: string[];
  finishReason: string;
};

export type RatelWiring = Awaited<ReturnType<typeof createRatelView>>;

// One core + one AI SDK view over it: the adapter ingests the AI SDK-native
// `tool()` definitions straight into the shared catalog — no conversion glue.
export async function createRatelView() {
  const core = ratel();
  const view = core.adaptTo(aiSdk());
  await view.tools.register(tools);
  return { core, view };
}

export async function runAgent(args: {
  prompt: string;
  model: LanguageModel;
  view: RatelWiring["view"];
  maxSteps?: number;
}): Promise<AgentResult> {
  const { prompt, model, view } = args;
  const maxSteps = args.maxSteps ?? 8;

  // The model sees only the three capability tools; everything else stays in
  // the catalog and is reached through search_capabilities / invoke_tool.
  // `prepareStep` injects the per-turn recall pair (top-ranked catalog hits
  // for the user prompt) on step 0 and keeps it present across loop steps.
  const modelTools = view.modelTools();

  console.log(`model tools: ${Object.keys(modelTools).join(", ")}`);

  const agent = new ToolLoopAgent({
    model,
    tools: modelTools,
    toolChoice: "auto",
    stopWhen: stepCountIs(maxSteps),
    prepareStep: view.prepareStep,
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
    activeTools: Object.keys(modelTools),
    finishReason: result.finishReason,
  };
}
