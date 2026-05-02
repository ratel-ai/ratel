import { invokeToolTool, searchToolsTool, type ToolCatalog } from "@ratel-ai/sdk";
import {
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  type Tool,
  ToolLoopAgent,
} from "ai";
import { toAISDKTool } from "./tools.js";

const SYSTEM_PROMPT =
  "You are a helpful assistant with access to tools from one or more MCP servers. " +
  "When useful, call tools by name; otherwise answer directly. " +
  "If the requested capability isn't in your direct tool list, use search_tools to find it, then invoke_tool to call it.";

const TRUNCATE = 280;
function truncate(s: string): string {
  return s.length <= TRUNCATE ? s : `${s.slice(0, TRUNCATE)}…(+${s.length - TRUNCATE} chars)`;
}

export interface ChatOptions {
  model: LanguageModel;
  catalog: ToolCatalog;
  initialTopK?: number;
  maxSteps?: number;
}

export class Chat {
  private readonly history: ModelMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  constructor(private readonly opts: ChatOptions) {}

  async send(userText: string): Promise<string> {
    const { model, catalog } = this.opts;
    const initialTopK = this.opts.initialTopK ?? 3;
    const maxSteps = this.opts.maxSteps ?? 8;

    const tools: Record<string, Tool> = {
      search_tools: toAISDKTool(searchToolsTool(catalog)),
      invoke_tool: toAISDKTool(invokeToolTool(catalog)),
    };
    const directHits = catalog.search(userText, initialTopK);
    for (const hit of directHits) {
      const exec = catalog.getExecutable(hit.toolId);
      if (exec) tools[exec.id] = toAISDKTool(exec);
    }

    const direct = directHits.map((h) => h.toolId);
    console.log(
      `\n[ratel] loaded tools for this turn: ${[...direct, "search_tools", "invoke_tool"].join(", ")}`,
    );

    this.history.push({ role: "user", content: userText });

    const agent = new ToolLoopAgent({
      model,
      tools,
      toolChoice: "auto",
      stopWhen: stepCountIs(maxSteps),
    });

    const result = await agent.generate({ messages: this.history });

    result.steps.forEach((step, i) => {
      for (const call of step.toolCalls) {
        console.log(`[step ${i + 1}] → ${call.toolName}(${JSON.stringify(call.input)})`);
      }
      for (const tr of step.toolResults) {
        console.log(`[step ${i + 1}] ← ${tr.toolName}: ${truncate(JSON.stringify(tr.output))}`);
      }
    });

    this.history.push(...result.response.messages);
    return result.text;
  }
}
