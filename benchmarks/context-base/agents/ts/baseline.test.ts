import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SendMessageBody, ToolDef } from "../../lib/protocol.js";

const mockGenerate = vi.fn();
vi.mock("@mastra/core/agent", () => ({
  Agent: class MockAgent {
    generate = mockGenerate;
  },
}));

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

  it("passes all tools via toolsets", async () => {
    mockGenerate.mockResolvedValueOnce({
      text: "Hello!",
      steps: [],
      usage: { inputTokens: 40, outputTokens: 10 },
    });

    const cbs = createCallbacks();
    await cbs.setup(mockTools.map((t) => ({ ...t, execute: vi.fn() })), mockConfig);

    const body: SendMessageBody = {
      history: [{ role: "user", content: "Hi" }],
      seed: 42,
    };
    const result = await cbs.sendMessage(body);

    expect(mockGenerate).toHaveBeenCalledOnce();
    const [, opts] = mockGenerate.mock.calls[0];
    expect(Object.keys(opts.toolsets.all).sort()).toEqual(["tool1", "tool2"]);
    expect(opts.seed).toBe(42);
    expect(result.content).toBe("Hello!");
    expect(result.toolCalls).toEqual([]);
  });

  it("does not call __setTools", async () => {
    mockGenerate.mockResolvedValueOnce({
      text: "ok",
      steps: [],
      usage: { inputTokens: 40, outputTokens: 10 },
    });

    const cbs = createCallbacks();
    await cbs.setup(mockTools.map((t) => ({ ...t, execute: vi.fn() })), mockConfig);

    // Agent mock doesn't have __setTools — if code calls it, it would throw
    await cbs.sendMessage({ history: [{ role: "user", content: "test" }], seed: 1 });

    expect(true).toBe(true);
  });

  it("collects tool calls from steps", async () => {
    mockGenerate.mockResolvedValueOnce({
      text: "Done.",
      steps: [
        { toolCalls: [{ toolCallId: "c1", toolName: "tool1", args: { id: "123" } }] },
        { toolCalls: [{ toolCallId: "c2", toolName: "tool2", args: {} }] },
      ],
      usage: { inputTokens: 80, outputTokens: 10 },
    });

    const cbs = createCallbacks();
    await cbs.setup(mockTools.map((t) => ({ ...t, execute: vi.fn() })), mockConfig);

    const result = await cbs.sendMessage({ history: [{ role: "user", content: "Do both" }], seed: 1 });

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].toolName).toBe("tool1");
    expect(result.toolCalls[1].toolName).toBe("tool2");
  });

  it("maps usage correctly", async () => {
    mockGenerate.mockResolvedValueOnce({
      text: "ok",
      steps: [],
      usage: { inputTokens: 40, outputTokens: 10, cachedInputTokens: 15, reasoningTokens: 5 },
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
