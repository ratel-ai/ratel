import { ratel } from "@ratel-ai/sdk";
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { aiSdk } from "./aisdk.js";

interface ModelCall {
  prompt: unknown[];
}

class MockLanguageModelV2 {
  readonly specificationVersion = "v2";
  readonly provider = "mock-provider";
  readonly modelId = "mock-model";
  readonly supportedUrls = {};
  readonly doGenerateCalls: ModelCall[] = [];
  readonly doStreamCalls: ModelCall[] = [];

  constructor(
    private readonly generateResults: unknown[] = [],
    private readonly streamResults: unknown[] = [],
  ) {}

  async doGenerate(options: ModelCall): Promise<unknown> {
    const index = this.doGenerateCalls.push(options) - 1;
    return this.generateResults[index];
  }

  async doStream(options: ModelCall): Promise<unknown> {
    const index = this.doStreamCalls.push(options) - 1;
    return this.streamResults[index];
  }
}

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
};

describe("AI SDK loop integration", () => {
  it("keeps one recall pair in both prompts of a two-step generateText loop", async () => {
    const view = ratel().adaptTo(aiSdk());
    let executions = 0;
    await view.tools.register({
      deploy_app: tool({
        description: "Deploy the app to production servers.",
        inputSchema: z.object({}),
        execute: async () => {
          executions++;
          return { deployed: true };
        },
      }),
    });
    const model = new MockLanguageModelV2([
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "invoke-0",
            toolName: "invoke_tool",
            input: JSON.stringify({ toolId: "deploy_app", args: {} }),
          },
        ],
        finishReason: "tool-calls",
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "deployed." }],
        finishReason: "stop",
        usage,
        warnings: [],
      },
    ]);
    const messages: ModelMessage[] = [{ role: "user", content: "deploy to production" }];

    const result = await generateText({
      model: model as unknown as LanguageModel,
      tools: view.modelTools(),
      messages,
      prepareStep: view.prepareStep,
      stopWhen: stepCountIs(2),
    });

    expect(result.text).toBe("deployed.");
    expect(executions).toBe(1);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(recallIdOccurrences(model.doGenerateCalls[0].prompt, "recall_0")).toBe(2);
    expect(recallIdOccurrences(model.doGenerateCalls[1].prompt, "recall_0")).toBe(2);
    expect(messages).toEqual([{ role: "user", content: "deploy to production" }]);

    const next: ModelMessage[] = [{ role: "user", content: "deploy again" }];
    await view.appendRecall(next);
    expect(JSON.stringify(next)).toContain("recall_1");
  });

  it("keeps one recall pair in both prompts of a two-step streamText loop", async () => {
    const view = ratel().adaptTo(aiSdk());
    let executions = 0;
    await view.tools.register({
      deploy_app: tool({
        description: "Deploy the app to production servers.",
        inputSchema: z.object({}),
        execute: async () => {
          executions++;
          return { deployed: true };
        },
      }),
    });
    const model = new MockLanguageModelV2(
      [],
      [
        streamResult(
          {
            type: "tool-call",
            toolCallId: "invoke-0",
            toolName: "invoke_tool",
            input: JSON.stringify({ toolId: "deploy_app", args: {} }),
          },
          { type: "finish", finishReason: "tool-calls", usage },
        ),
        streamResult(
          { type: "text-start", id: "text-0" },
          { type: "text-delta", id: "text-0", delta: "deployed." },
          { type: "text-end", id: "text-0" },
          { type: "finish", finishReason: "stop", usage },
        ),
      ],
    );
    const messages: ModelMessage[] = [{ role: "user", content: "deploy to production" }];

    const result = streamText({
      model: model as unknown as LanguageModel,
      tools: view.modelTools(),
      messages,
      prepareStep: view.prepareStep,
      stopWhen: stepCountIs(2),
    });

    expect(await result.text).toBe("deployed.");
    expect(executions).toBe(1);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(recallIdOccurrences(model.doStreamCalls[0].prompt, "recall_0")).toBe(2);
    expect(recallIdOccurrences(model.doStreamCalls[1].prompt, "recall_0")).toBe(2);
    expect(messages).toEqual([{ role: "user", content: "deploy to production" }]);

    const next: ModelMessage[] = [{ role: "user", content: "deploy again" }];
    await view.appendRecall(next);
    expect(JSON.stringify(next)).toContain("recall_1");
  });
});

function recallIdOccurrences(prompt: unknown[], callId: string): number {
  return JSON.stringify(prompt).split(callId).length - 1;
}

function streamResult(...chunks: unknown[]): { stream: ReadableStream<unknown> } {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}
