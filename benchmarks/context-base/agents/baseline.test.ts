import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolCallPart, ToolResultPart } from "ai";
import type { SetupParams, Message } from "../lib/types.js";
import setup from "./baseline.js";

function makeToolResult(
  toolCallId: string,
  toolName: string,
  result: unknown = { ok: true },
): ToolResultPart {
  return {
    type: "tool-result",
    toolCallId,
    toolName,
    result: result as ToolResultPart["result"],
  };
}

// Mock AI SDK generateText — with stopWhen, it's called once and returns all steps
const mockGenerateText = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: (...args: unknown[]) => mockGenerateText(...args),
    stepCountIs: actual.stepCountIs,
  };
});

describe("baseline agent", () => {
  const mockTools = {
    tool1: { description: "tool1", inputSchema: {} },
    tool2: { description: "tool2", inputSchema: {} },
  } as unknown as SetupParams["tools"];
  const mockExecutor = vi.fn<(call: ToolCallPart) => Promise<ToolResultPart>>();
  const mockOnMetrics = vi.fn();

  const params: SetupParams = {
    tools: mockTools,
    toolExecutor: mockExecutor,
    onMetrics: mockOnMetrics,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns text response when model produces no tool calls", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Hello!",
      steps: [],
      usage: { totalTokens: 50, promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 15 } },
    });

    const harness = await setup(params);
    const history: Message[] = [{ role: "user", content: "Hi" }];
    const response = await harness.sendMessage(history, 42);

    expect(response.content).toBe("Hello!");
    expect(response.toolCalls).toEqual([]);
    expect(response.usage.inputTokens).toBe(40);
    expect(response.usage.outputTokens).toBe(10);
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("collects tool calls from steps", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Marco is an engineer.",
      steps: [
        {
          toolCalls: [
            { toolCallId: "call_1", toolName: "tool1", args: { id: "123" } },
          ],
          toolResults: [{ output: { name: "Marco" } }],
        },
      ],
      usage: { totalTokens: 80, promptTokens: 70, completionTokens: 10 },
      totalUsage: { inputTokens: 70, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 30 } },
    });

    const harness = await setup(params);
    const response = await harness.sendMessage(
      [{ role: "user", content: "Who is Marco?" }],
      42,
    );

    expect(response.content).toBe("Marco is an engineer.");
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].toolName).toBe("tool1");
  });

  it("collects tool calls from multiple steps", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Done.",
      steps: [
        {
          toolCalls: [
            { toolCallId: "call_1", toolName: "tool1", args: {} },
          ],
        },
        {
          toolCalls: [
            { toolCallId: "call_2", toolName: "tool2", args: {} },
          ],
        },
      ],
      usage: { totalTokens: 90, promptTokens: 80, completionTokens: 10 },
      totalUsage: { inputTokens: 80, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 40 } },
    });

    const harness = await setup(params);
    const response = await harness.sendMessage(
      [{ role: "user", content: "Do both" }],
      42,
    );

    expect(response.content).toBe("Done.");
    expect(response.toolCalls).toHaveLength(2);
    expect(response.toolCalls[0].toolName).toBe("tool1");
    expect(response.toolCalls[1].toolName).toBe("tool2");
  });

  it("wraps tools with execute functions and passes stopWhen", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "ok",
      steps: [],
      usage: { totalTokens: 10, promptTokens: 8, completionTokens: 2 },
      totalUsage: { inputTokens: 8, outputTokens: 2, inputTokenDetails: { cacheReadTokens: 0 } },
    });

    const harness = await setup(params);
    await harness.sendMessage([{ role: "user", content: "test" }], 99);

    const callArgs = mockGenerateText.mock.calls[0][0];
    // Tools should have execute functions added
    expect(typeof callArgs.tools.tool1.execute).toBe("function");
    expect(typeof callArgs.tools.tool2.execute).toBe("function");
    // stopWhen should be set
    expect(callArgs.stopWhen).toBeDefined();
  });

  it("execute function calls toolExecutor", async () => {
    mockExecutor.mockResolvedValueOnce(
      makeToolResult("call_tool1", "tool1", { name: "Marco" }),
    );

    mockGenerateText.mockResolvedValueOnce({
      text: "ok",
      steps: [],
      usage: { totalTokens: 10, promptTokens: 8, completionTokens: 2 },
      totalUsage: { inputTokens: 8, outputTokens: 2, inputTokenDetails: { cacheReadTokens: 0 } },
    });

    const harness = await setup(params);
    await harness.sendMessage([{ role: "user", content: "test" }], 99);

    // Call the execute function directly to verify it delegates to toolExecutor
    const callArgs = mockGenerateText.mock.calls[0][0];
    const result = await callArgs.tools.tool1.execute({ id: "123" });

    expect(mockExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool-call",
        toolName: "tool1",
        args: { id: "123" },
      }),
    );
    expect(result).toEqual({ name: "Marco" });
  });

  it("includes improved system prompt", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Done",
      steps: [],
      usage: { totalTokens: 50, promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 20 } },
    });

    const harness = await setup(params);
    await harness.sendMessage([{ role: "user", content: "test" }], 42);

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[0].content).toContain("HR assistant");
    expect(call.messages[0].content).toContain("ALWAYS consider using the tools");
  });

  it("passes seed to generateText", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Done",
      steps: [],
      usage: { totalTokens: 50, promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 20 } },
    });

    const harness = await setup(params);
    await harness.sendMessage([{ role: "user", content: "test" }], 42);

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.seed).toBe(42);
  });

  it("calls onMetrics callback with final usage", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "done",
      steps: [],
      usage: { totalTokens: 30, promptTokens: 25, completionTokens: 5 },
      totalUsage: { inputTokens: 25, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 12 } },
    });

    const harness = await setup(params);
    await harness.sendMessage([{ role: "user", content: "x" }], 1);

    expect(mockOnMetrics).toHaveBeenCalledWith({
      totalTokens: 30,
      inputTokens: 25,
      outputTokens: 5,
      cachedInputTokens: 12,
    });
  });
});
