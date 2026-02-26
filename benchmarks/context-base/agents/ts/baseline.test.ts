import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SendMessageBody, SendMessageResponse, ToolDef } from "../../lib/protocol.js";

const mockGenerateText = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: (...args: unknown[]) => mockGenerateText(...args),
    stepCountIs: actual.stepCountIs,
  };
});

const { createCallbacks } = await import("./baseline.js");

describe("baseline agent (HTTP)", () => {
  const mockTools: ToolDef[] = [
    { name: "tool1", description: "tool1", parameters: { type: "object", properties: { id: { type: "string" } } }, script: "/fake/tool1.sh" },
    { name: "tool2", description: "tool2", parameters: { type: "object", properties: {} }, script: "/fake/tool2.sh" },
  ];
  const mockConfig = { model: "gpt-5", systemPrompt: "You are helpful", maxSteps: 10 };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("setup stores tools and config", async () => {
    const cbs = createCallbacks();
    const execTools = mockTools.map((t) => ({ ...t, execute: vi.fn() }));
    await cbs.setup(execTools, mockConfig);
    // No error = success
  });

  it("sendMessage calls generateText with all tools", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Hello!",
      steps: [],
      usage: { promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10, inputTokenDetails: {}, outputTokenDetails: {} },
    });

    const cbs = createCallbacks();
    const execTools = mockTools.map((t) => ({ ...t, execute: vi.fn() }));
    await cbs.setup(execTools, mockConfig);

    const body: SendMessageBody = {
      history: [{ role: "user", content: "Hi" }],
      seed: 42,
    };
    const result = await cbs.sendMessage(body);

    expect(mockGenerateText).toHaveBeenCalledOnce();
    const call = mockGenerateText.mock.calls[0][0];
    expect(Object.keys(call.tools)).toEqual(["tool1", "tool2"]);
    expect(call.seed).toBe(42);
    expect(result.content).toBe("Hello!");
    expect(result.toolCalls).toEqual([]);
  });

  it("collects tool calls from steps", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Done.",
      steps: [
        { toolCalls: [{ toolCallId: "c1", toolName: "tool1", args: { id: "123" } }] },
        { toolCalls: [{ toolCallId: "c2", toolName: "tool2", args: {} }] },
      ],
      usage: { promptTokens: 80, completionTokens: 10 },
      totalUsage: { inputTokens: 80, outputTokens: 10, inputTokenDetails: {}, outputTokenDetails: {} },
    });

    const cbs = createCallbacks();
    const execTools = mockTools.map((t) => ({ ...t, execute: vi.fn() }));
    await cbs.setup(execTools, mockConfig);

    const result = await cbs.sendMessage({ history: [{ role: "user", content: "Do both" }], seed: 1 });

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].toolName).toBe("tool1");
    expect(result.toolCalls[1].toolName).toBe("tool2");
  });

  it("maps usage correctly", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "ok",
      steps: [],
      usage: { promptTokens: 40, completionTokens: 10 },
      totalUsage: {
        inputTokens: 40,
        outputTokens: 10,
        inputTokenDetails: { cacheReadTokens: 15 },
        outputTokenDetails: { reasoningTokens: 5 },
      },
    });

    const cbs = createCallbacks();
    await cbs.setup(mockTools.map((t) => ({ ...t, execute: vi.fn() })), mockConfig);

    const result = await cbs.sendMessage({ history: [{ role: "user", content: "test" }], seed: 1 });

    expect(result.usage).toEqual({
      totalTokens: 50,
      inputTokens: 40,
      outputTokens: 10,
      cachedInputTokens: 15,
      outputReasoningTokens: 5,
    });
  });
});
