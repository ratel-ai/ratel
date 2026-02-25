import { describe, it, expect, vi } from "vitest";
import type {
  AgentResponse,
  Scenario,
  SetupParams,
  TestHarness,
} from "./types.js";
import { loadAgent, runScenario } from "./harness.js";

function createMockHarness(
  response: Partial<AgentResponse> = {},
): TestHarness {
  const defaults: AgentResponse = {
    content: "mock response",
    toolCalls: [],
    usage: {
      totalTokens: 100,
      inputTokens: 80,
      outputTokens: 20,
    },
    durationMs: 50,
  };
  return {
    sendMessage: vi.fn().mockResolvedValue({ ...defaults, ...response }),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

function createScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 1,
    query: "What's Marco Rossi's salary?",
    expectedTools: ["getEmployee", "getSalary"],
    type: "retrieval",
    seed: 42,
    ...overrides,
  };
}

describe("loadAgent", () => {
  it("calls agent module default export with setup params", async () => {
    const mockHarness = createMockHarness();
    const mockSetup = vi.fn().mockResolvedValue(mockHarness);

    const params: SetupParams = {
      tools: {},
      toolExecutor: vi.fn(),
    };

    const harness = await loadAgent(mockSetup, params);

    expect(mockSetup).toHaveBeenCalledWith(params);
    expect(harness).toBe(mockHarness);
  });

  it("propagates setup errors", async () => {
    const mockSetup = vi.fn().mockRejectedValue(new Error("setup failed"));
    const params: SetupParams = {
      tools: {},
      toolExecutor: vi.fn(),
    };

    await expect(loadAgent(mockSetup, params)).rejects.toThrow("setup failed");
  });
});

describe("runScenario", () => {
  it("sends scenario query as user message with seed", async () => {
    const harness = createMockHarness();
    const scenario = createScenario();

    await runScenario(harness, scenario);

    expect(harness.sendMessage).toHaveBeenCalledWith(
      [{ role: "user", content: scenario.query }],
      scenario.seed,
      scenario.expectedTools,
    );
  });

  it("returns BenchmarkOutput with response and scenario", async () => {
    const response: AgentResponse = {
      content: "Marco earns $120k",
      toolCalls: [
        {
          type: "tool-call",
          toolCallId: "1",
          toolName: "getEmployee",
          input: { name: "Marco Rossi" },
        },
      ],
      usage: { totalTokens: 200, inputTokens: 150, outputTokens: 50 },
      durationMs: 120,
    };
    const harness = createMockHarness(response);
    const scenario = createScenario();

    const result = await runScenario(harness, scenario);

    expect(result.scenario).toBe(scenario);
    expect(result.response.content).toBe("Marco earns $120k");
    expect(result.response.toolCalls).toHaveLength(1);
    expect(result.response.toolCalls[0].toolName).toBe("getEmployee");
  });

  it("handles multi-turn scenarios with followUps", async () => {
    const harness = createMockHarness();
    const scenario = createScenario({
      type: "multi-turn",
      followUps: ["What about his bonus?", "And his benefits?"],
    });

    const result = await runScenario(harness, scenario);

    // Should have been called 3 times: initial + 2 follow-ups
    expect(harness.sendMessage).toHaveBeenCalledTimes(3);

    // First call: just the initial query
    const firstCall = (harness.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(firstCall[0]).toEqual([
      { role: "user", content: scenario.query },
    ]);

    // Second call: history with first response + follow-up
    const secondCall = (harness.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[1];
    expect(secondCall[0]).toHaveLength(3); // user + assistant + user
    expect(secondCall[0][2].content).toBe("What about his bonus?");

    // Third call: full history + second follow-up
    const thirdCall = (harness.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[2];
    expect(thirdCall[0]).toHaveLength(5); // user + assistant + user + assistant + user
    expect(thirdCall[0][4].content).toBe("And his benefits?");
  });

  it("returns the final response for multi-turn scenarios", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        content: "first",
        toolCalls: [],
        usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
        durationMs: 50,
      })
      .mockResolvedValueOnce({
        content: "second",
        toolCalls: [],
        usage: { totalTokens: 150, inputTokens: 120, outputTokens: 30 },
        durationMs: 60,
      });

    const harness: TestHarness = { sendMessage };
    const scenario = createScenario({
      type: "multi-turn",
      followUps: ["follow-up"],
    });

    const result = await runScenario(harness, scenario);

    expect(result.response.content).toBe("second");
  });

  it("aggregates token usage across multi-turn", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        content: "first",
        toolCalls: [
          { type: "tool-call", toolCallId: "1", toolName: "getEmployee", input: {} },
        ],
        usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
        durationMs: 50,
      })
      .mockResolvedValueOnce({
        content: "second",
        toolCalls: [
          { type: "tool-call", toolCallId: "2", toolName: "getSalary", input: {} },
        ],
        usage: { totalTokens: 150, inputTokens: 120, outputTokens: 30 },
        durationMs: 60,
      });

    const harness: TestHarness = { sendMessage };
    const scenario = createScenario({
      type: "multi-turn",
      followUps: ["follow-up"],
    });

    const result = await runScenario(harness, scenario);

    // Aggregated usage
    expect(result.response.usage.totalTokens).toBe(250);
    expect(result.response.usage.inputTokens).toBe(200);
    expect(result.response.usage.outputTokens).toBe(50);
    // Aggregated duration
    expect(result.response.durationMs).toBe(110);
    // Aggregated tool calls
    expect(result.response.toolCalls).toHaveLength(2);
    expect(result.response.toolCalls[0].toolName).toBe("getEmployee");
    expect(result.response.toolCalls[1].toolName).toBe("getSalary");
  });
});
