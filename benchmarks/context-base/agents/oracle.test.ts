import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolCallPart, ToolResultPart } from "ai";
import type { SetupParams, Message } from "../lib/types.js";
import setup from "./oracle.js";

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

const mockGenerateText = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: (...args: unknown[]) => mockGenerateText(...args),
    stepCountIs: actual.stepCountIs,
  };
});

describe("oracle agent", () => {
  const mockTools = {
    getEmployee: { description: "Get employee", parameters: {} },
    getSalary: { description: "Get salary", parameters: {} },
    listEmployees: { description: "List employees", parameters: {} },
    requestTimeOff: { description: "Request time off", parameters: {} },
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

  it("filters tools to only expectedTools", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Done",
      steps: [],
      usage: { totalTokens: 50, promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10 },
    });

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "What's Marco's salary?" }],
      42,
      ["getEmployee", "getSalary"],
    );

    const call = mockGenerateText.mock.calls[0][0];
    const toolNames = Object.keys(call.tools);
    expect(toolNames).toEqual(["getEmployee", "getSalary"]);
  });

  it("passes no tools when expectedTools is empty", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "I cannot do that.",
      steps: [],
      usage: { totalTokens: 30, promptTokens: 25, completionTokens: 5 },
      totalUsage: { inputTokens: 25, outputTokens: 5 },
    });

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "Do something impossible" }],
      42,
      [],
    );

    const call = mockGenerateText.mock.calls[0][0];
    expect(Object.keys(call.tools)).toHaveLength(0);
  });

  it("passes all tools when expectedTools is undefined", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Done",
      steps: [],
      usage: { totalTokens: 50, promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10 },
    });

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
    );

    const call = mockGenerateText.mock.calls[0][0];
    expect(Object.keys(call.tools)).toHaveLength(4);
  });

  it("reports hydratedTools matching expectedTools", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Done",
      steps: [],
      usage: { totalTokens: 50, promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10 },
    });

    const harness = await setup(params);
    const response = await harness.sendMessage(
      [{ role: "user", content: "What's Marco's salary?" }],
      42,
      ["getEmployee", "getSalary"],
    );

    expect(response.hydratedTools).toEqual(["getEmployee", "getSalary"]);
  });

  it("flattens alternative tool slots for filtering and hydration", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Done",
      steps: [],
      usage: { totalTokens: 50, promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10 },
    });

    const harness = await setup(params);
    // Pass ToolSlot[] with alternatives — oracle should flatten
    const response = await harness.sendMessage(
      [{ role: "user", content: "What's Marco's salary?" }],
      42,
      [["getEmployee", "searchEmployees"], "getSalary"] as any,
    );

    const call = mockGenerateText.mock.calls[0][0];
    const toolNames = Object.keys(call.tools);
    // Should include both alternatives + getSalary (searchEmployees not in mock tools, so skipped)
    expect(toolNames).toContain("getEmployee");
    expect(toolNames).toContain("getSalary");
    // hydratedTools should be the flattened list (including names not in registry)
    expect(response.hydratedTools).toEqual(["getEmployee", "searchEmployees", "getSalary"]);
  });

  it("collects tool calls from steps", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Marco earns $95k",
      steps: [
        {
          toolCalls: [
            { toolCallId: "call_1", toolName: "getEmployee", args: { name: "Marco" } },
          ],
        },
        {
          toolCalls: [
            { toolCallId: "call_2", toolName: "getSalary", args: { employeeId: "123" } },
          ],
        },
      ],
      usage: { totalTokens: 100, promptTokens: 80, completionTokens: 20 },
      totalUsage: { inputTokens: 80, outputTokens: 20 },
    });

    const harness = await setup(params);
    const response = await harness.sendMessage(
      [{ role: "user", content: "What's Marco's salary?" }],
      42,
      ["getEmployee", "getSalary"],
    );

    expect(response.toolCalls).toHaveLength(2);
    expect(response.toolCalls[0].toolName).toBe("getEmployee");
    expect(response.toolCalls[1].toolName).toBe("getSalary");
  });

  it("includes system prompt in messages", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Done",
      steps: [],
      usage: { totalTokens: 50, promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10 },
    });

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
      ["getEmployee"],
    );

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
      totalUsage: { inputTokens: 40, outputTokens: 10 },
    });

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
      ["getEmployee"],
    );

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.seed).toBe(42);
  });

  it("wraps filtered tools with executor", async () => {
    mockExecutor.mockResolvedValue(
      makeToolResult("call_1", "getEmployee", { id: "123", name: "Marco" }),
    );

    mockGenerateText.mockResolvedValueOnce({
      text: "Done",
      steps: [],
      usage: { totalTokens: 50, promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10 },
    });

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
      ["getEmployee"],
    );

    const call = mockGenerateText.mock.calls[0][0];
    const result = await call.tools.getEmployee.execute({ name: "Marco" });

    expect(mockExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool-call",
        toolName: "getEmployee",
        args: { name: "Marco" },
      }),
    );
    expect(result).toEqual({ id: "123", name: "Marco" });
  });

  it("calls onMetrics callback", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Done",
      steps: [],
      usage: { totalTokens: 50, promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 18 } },
    });

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
      ["getEmployee"],
    );

    expect(mockOnMetrics).toHaveBeenCalledWith({
      totalTokens: 50,
      inputTokens: 40,
      outputTokens: 10,
      cachedInputTokens: 18,
    });
  });
});
