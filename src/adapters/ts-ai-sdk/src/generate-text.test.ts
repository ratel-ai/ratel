import { ratel, SEARCH_CAPABILITIES_ID } from "@ratel-ai/sdk";
import { generateText, type LanguageModel, type ModelMessage, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { aiSdk } from "./aisdk.js";

// The LanguageModelV3 usage/finishReason shape the mock returns per step (mirrors
// examples/ai-sdk/test/agent.test.ts, the repo's proven mock wiring).
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

describe("generateText integration (the real ai@7 loop)", () => {
  it("awaits the async prepareStep and applies its messages override on step 0", async () => {
    const view = ratel().adaptTo(aiSdk());
    view.tools.register({
      deploy_app: tool({
        description: "Deploy the app to production servers.",
        inputSchema: z.object({}),
        execute: async () => ({ deployed: true }),
      }),
    });

    // One-shot model: answer immediately, so exactly one step runs.
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: "deployed." }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }),
    });

    const result = await generateText({
      model: model as unknown as LanguageModel,
      tools: view.expose(),
      messages: [{ role: "user", content: "deploy to production" }] as ModelMessage[],
      prepareStep: view.prepareStep,
    });

    expect(result.text).toBe("deployed.");
    expect(model.doGenerateCalls).toHaveLength(1);

    // The step-0 prompt the model actually received carries the synthetic recall
    // pair — proving ai@7 awaited the async prepareStep and applied its messages
    // override. The input had no tool turn, so a `tool` message can only be the
    // injected recall result, and the query text is not in the tool defs (those
    // travel separately), so its presence here is the injection.
    const prompt = model.doGenerateCalls[0].prompt;
    expect(prompt.some((message) => message.role === "tool")).toBe(true);
    expect(JSON.stringify(prompt)).toContain(SEARCH_CAPABILITIES_ID);
  });
});
