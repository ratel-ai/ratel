// Starter template — copy this file to create a new benchmark agent.
import { startAgent, type ExecutableTool } from "../../scaffolding/ts/index.js";
import type { SetupBody, SendMessageBody, SendMessageResponse } from "../../lib/protocol.js";

export function createCallbacks() {
  let state: any = {};

  return {
    setup: async (tools: ExecutableTool[], config: SetupBody["config"]) => {
      state = {};
    },

    sendMessage: async (body: SendMessageBody): Promise<SendMessageResponse> => {
      if (!state) throw new Error("Agent not set up");

      return {
        content: "the result of your agent",
        toolCalls: [],
        usage: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          outputReasoningTokens: 0,
        },
        durationMs: 0,
        debug: {
          systemPrompt: "",
          toolNames: [],
          modelResponse: "",
          toolCallsMade: [],
        },
      };
    },
  };
}

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const cbs = createCallbacks();
  startAgent({ setup: cbs.setup, sendMessage: cbs.sendMessage });
}

