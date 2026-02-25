import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolCallPart, ToolResultPart } from "ai";
import type { SetupParams, Message } from "../lib/types.js";
import setup from "./agentified.js";

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

const mockPrefetch = vi.fn();
const mockCaptureTurn = vi.fn();
vi.mock("@agentified/sdk", () => ({
  Agentified: class {
    prefetch = (...args: unknown[]) => mockPrefetch(...args);
    captureTurn = (...args: unknown[]) => mockCaptureTurn(...args);
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("agentified hybrid agent", () => {
  const mockTools = {
    getEmployee: { description: "Get employee", parameters: {} },
    getSalary: { description: "Get salary", parameters: {} },
    listEmployees: { description: "List employees", parameters: {} },
    getTimeOffBalance: { description: "Get time off balance", parameters: {} },
  } as unknown as SetupParams["tools"];
  const mockExecutor = vi.fn<(call: ToolCallPart) => Promise<ToolResultPart>>();
  const mockOnMetrics = vi.fn();

  const params: SetupParams = {
    tools: mockTools,
    toolExecutor: mockExecutor,
    onMetrics: mockOnMetrics,
  };

  function defaultGenerateResult(overrides: Record<string, any> = {}) {
    return {
      text: "Done",
      steps: [],
      usage: { totalTokens: 50, promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10 },
      ...overrides,
    };
  }

  function defaultPrefetchResult() {
    return [
      { name: "getEmployee", description: "Get employee", parameters: {}, score: 0.9 },
      { name: "getSalary", description: "Get salary", parameters: {}, score: 0.8 },
    ];
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls prefetch with correct params (limit=5)", async () => {
    mockPrefetch.mockResolvedValueOnce(defaultPrefetchResult());
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t1" });
    mockGenerateText.mockResolvedValueOnce(defaultGenerateResult());

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "What's Marco's salary?" }],
      42,
    );

    expect(mockPrefetch).toHaveBeenCalledOnce();
    expect(mockPrefetch).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: "What's Marco's salary?" }],
        limit: 5,
      }),
    );
  });

  it("passes seed to generateText", async () => {
    mockPrefetch.mockResolvedValueOnce(defaultPrefetchResult());
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t1" });
    mockGenerateText.mockResolvedValueOnce(defaultGenerateResult());

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
    );

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.seed).toBe(42);
  });

  it("step 0: activeTools = prefilled tools + discover_tools, no forced toolChoice", async () => {
    mockPrefetch.mockResolvedValueOnce(defaultPrefetchResult());
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t1" });
    mockGenerateText.mockResolvedValueOnce(defaultGenerateResult());

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "What's Marco's salary?" }],
      42,
    );

    const call = mockGenerateText.mock.calls[0][0];
    const step0 = call.prepareStep({
      stepNumber: 0,
      steps: [],
      model: {},
      messages: [],
    });

    expect(step0.activeTools).toContain("getEmployee");
    expect(step0.activeTools).toContain("getSalary");
    expect(step0.activeTools).toContain("discover_tools");
    expect(step0.activeTools).not.toContain("listEmployees");
    expect(step0.activeTools).not.toContain("getTimeOffBalance");
    expect(step0.toolChoice).toBeUndefined();
  });

  it("step 1+: if discover_tools called, activates union(prefilled, discovered) + discover_tools", async () => {
    mockPrefetch.mockResolvedValueOnce(defaultPrefetchResult());
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t1" });
    mockGenerateText.mockResolvedValueOnce(defaultGenerateResult());

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
    );

    const call = mockGenerateText.mock.calls[0][0];
    const step1 = call.prepareStep({
      stepNumber: 1,
      steps: [
        {
          toolResults: [
            {
              toolName: "discover_tools",
              output: {
                tools: [
                  { name: "listEmployees", description: "List employees" },
                  { name: "getTimeOffBalance", description: "Get time off" },
                ],
              },
            },
          ],
        },
      ],
      model: {},
      messages: [],
    });

    // Union of prefilled (getEmployee, getSalary) + discovered (listEmployees, getTimeOffBalance)
    expect(step1.activeTools).toContain("getEmployee");
    expect(step1.activeTools).toContain("getSalary");
    expect(step1.activeTools).toContain("listEmployees");
    expect(step1.activeTools).toContain("getTimeOffBalance");
    expect(step1.activeTools).toContain("discover_tools");
  });

  it("activeTools accumulate across multiple discover_tools calls", async () => {
    mockPrefetch.mockResolvedValueOnce(defaultPrefetchResult());
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t1" });
    mockGenerateText.mockResolvedValueOnce(defaultGenerateResult());

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
    );

    const call = mockGenerateText.mock.calls[0][0];
    const step2 = call.prepareStep({
      stepNumber: 2,
      steps: [
        {
          toolResults: [
            {
              toolName: "discover_tools",
              output: {
                tools: [
                  { name: "listEmployees", description: "List employees" },
                ],
              },
            },
          ],
        },
        {
          toolResults: [
            {
              toolName: "discover_tools",
              output: {
                tools: [
                  { name: "getTimeOffBalance", description: "Get time off" },
                ],
              },
            },
          ],
        },
      ],
      model: {},
      messages: [],
    });

    expect(step2.activeTools).toContain("getEmployee");
    expect(step2.activeTools).toContain("getSalary");
    expect(step2.activeTools).toContain("listEmployees");
    expect(step2.activeTools).toContain("getTimeOffBalance");
    expect(step2.activeTools).toContain("discover_tools");
  });

  it("discover_tools fetch uses limit=10", async () => {
    mockPrefetch.mockResolvedValueOnce(defaultPrefetchResult());
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t1" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tools: [{ name: "getEmployee", description: "Get employee" }] }),
    });
    mockGenerateText.mockResolvedValueOnce(defaultGenerateResult());

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
    );

    // Execute the discover_tools tool to trigger the fetch
    const call = mockGenerateText.mock.calls[0][0];
    await call.tools.discover_tools.execute({ queries: ["employee tools"] });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, fetchOpts] = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    expect(body.limit).toBe(10);
    expect(body.query).toBe("employee tools");
  });

  it("fallback: prefetch fails → forces discover_tools on step 0", async () => {
    mockPrefetch.mockRejectedValueOnce(new Error("Connection refused"));
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t1" });
    mockGenerateText.mockResolvedValueOnce(defaultGenerateResult());

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "test" }],
      1,
    );

    const call = mockGenerateText.mock.calls[0][0];
    const step0 = call.prepareStep({
      stepNumber: 0,
      steps: [],
      model: {},
      messages: [],
    });

    expect(step0.toolChoice).toEqual({
      type: "tool",
      toolName: "discover_tools",
    });
  });

  it("fallback step 1+: discovered tools persist from step 0", async () => {
    mockPrefetch.mockRejectedValueOnce(new Error("Connection refused"));
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t1" });
    mockGenerateText.mockResolvedValueOnce(defaultGenerateResult());

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "test" }],
      1,
    );

    const call = mockGenerateText.mock.calls[0][0];
    const step1 = call.prepareStep({
      stepNumber: 1,
      steps: [
        {
          toolResults: [
            {
              toolName: "discover_tools",
              output: {
                tools: [
                  { name: "getEmployee", description: "Get employee" },
                  { name: "getSalary", description: "Get salary" },
                ],
              },
            },
          ],
        },
      ],
      model: {},
      messages: [],
    });

    expect(step1.activeTools).toContain("getEmployee");
    expect(step1.activeTools).toContain("getSalary");
    expect(step1.activeTools).toContain("discover_tools");
    expect(step1.toolChoice).toBeUndefined();
  });

  it("hydratedTools = prefetch tools initially", async () => {
    mockPrefetch.mockResolvedValueOnce([
      { name: "getEmployee", description: "Get employee", parameters: {}, score: 0.9 },
      { name: "getSalary", description: "Get salary", parameters: {}, score: 0.8 },
    ]);
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t1" });
    mockGenerateText.mockResolvedValueOnce(defaultGenerateResult());

    const harness = await setup(params);
    const response = await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
    );

    expect(response.hydratedTools).toEqual(["getEmployee", "getSalary"]);
  });

  it("hydratedTools = union(prefill, discovered) when discover_tools called", async () => {
    mockPrefetch.mockResolvedValueOnce([
      { name: "getEmployee", description: "Get employee", parameters: {}, score: 0.9 },
    ]);
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t1" });
    mockGenerateText.mockResolvedValueOnce(
      defaultGenerateResult({
        steps: [
          {
            toolCalls: [
              { toolCallId: "call_discover", toolName: "discover_tools", args: { query: "salary" } },
            ],
            toolResults: [
              {
                toolName: "discover_tools",
                output: {
                  tools: [
                    { name: "getSalary", description: "Get salary" },
                    { name: "listEmployees", description: "List employees" },
                  ],
                },
              },
            ],
          },
          {
            toolCalls: [
              { toolCallId: "call_1", toolName: "getSalary", args: { id: "123" } },
            ],
          },
        ],
      }),
    );

    const harness = await setup(params);
    const response = await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
    );

    expect(response.hydratedTools).toContain("getEmployee");
    expect(response.hydratedTools).toContain("getSalary");
    expect(response.hydratedTools).toContain("listEmployees");
    expect(response.hydratedTools).toHaveLength(3);
  });

  it("excludes discover_tools from reported toolCalls", async () => {
    mockPrefetch.mockResolvedValueOnce(defaultPrefetchResult());
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t1" });
    mockGenerateText.mockResolvedValueOnce(
      defaultGenerateResult({
        steps: [
          {
            toolCalls: [
              { toolCallId: "call_discover", toolName: "discover_tools", args: { query: "salary" } },
            ],
          },
          {
            toolCalls: [
              { toolCallId: "call_1", toolName: "getEmployee", args: { name: "Marco" } },
              { toolCallId: "call_2", toolName: "getSalary", args: { id: "123" } },
            ],
          },
        ],
      }),
    );

    const harness = await setup(params);
    const response = await harness.sendMessage(
      [{ role: "user", content: "What's Marco's salary?" }],
      42,
    );

    expect(response.toolCalls).toHaveLength(2);
    expect(response.toolCalls[0].toolName).toBe("getEmployee");
    expect(response.toolCalls[1].toolName).toBe("getSalary");
  });

  it("wraps tools with executor", async () => {
    mockPrefetch.mockResolvedValueOnce(defaultPrefetchResult());
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t1" });
    mockExecutor.mockResolvedValue(
      makeToolResult("call_1", "getEmployee", { id: "123", name: "Marco" }),
    );
    mockGenerateText.mockResolvedValueOnce(defaultGenerateResult());

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
    );

    const call = mockGenerateText.mock.calls[0][0];
    await call.tools.getEmployee.execute({ name: "Marco" });

    expect(mockExecutor).toHaveBeenCalledOnce();
    const executorCall = mockExecutor.mock.calls[0][0];
    expect(executorCall.toolName).toBe("getEmployee");
  });

  it("calls onMetrics with usage including cachedInputTokens", async () => {
    mockPrefetch.mockResolvedValueOnce(defaultPrefetchResult());
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t1" });
    mockGenerateText.mockResolvedValueOnce(
      defaultGenerateResult({
        totalUsage: { inputTokens: 40, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 22 } },
      }),
    );

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
    );

    expect(mockOnMetrics).toHaveBeenCalledOnce();
    expect(mockOnMetrics).toHaveBeenCalledWith({
      totalTokens: 50,
      inputTokens: 40,
      outputTokens: 10,
      cachedInputTokens: 22,
    });
  });

  it("passes turnId to prefetch when provided", async () => {
    mockPrefetch.mockResolvedValueOnce(defaultPrefetchResult());
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "t2" });
    mockGenerateText.mockResolvedValueOnce(defaultGenerateResult());

    const harness = await setup(params);
    await harness.sendMessage(
      [{ role: "user", content: "follow up" }],
      42,
      undefined,
      "turn-abc",
    );

    expect(mockPrefetch).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "turn-abc" }),
    );
  });

  it("calls captureTurn after completion", async () => {
    mockPrefetch.mockResolvedValueOnce(defaultPrefetchResult());
    mockCaptureTurn.mockResolvedValueOnce({ turnId: "new-turn" });
    mockGenerateText.mockResolvedValueOnce(defaultGenerateResult());

    const harness = await setup(params);
    const response = await harness.sendMessage(
      [{ role: "user", content: "test" }],
      42,
    );

    expect(mockCaptureTurn).toHaveBeenCalledOnce();
    expect(mockCaptureTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        toolsLoaded: expect.arrayContaining(["getEmployee", "getSalary"]),
        message: "test",
      }),
    );
    expect(response.turnId).toBe("new-turn");
  });
});
