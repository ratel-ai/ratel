import { describe, it, expect, vi, afterAll, beforeAll } from "vitest";
import { createServer } from "node:http";
import type { AgentResponse, Scenario, TestHarness } from "./types.js";
import { createHttpHarness, runScenario } from "./harness.js";

function createMockHarness(response: Partial<AgentResponse> = {}): TestHarness {
  const defaults: AgentResponse = {
    content: "mock response",
    toolCalls: [],
    usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
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

describe("createHttpHarness", () => {
  let server: ReturnType<typeof createServer>;
  const PORT = 19877;
  let lastBody: any;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        lastBody = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          content: "HTTP response",
          toolCalls: [{ toolCallId: "c1", toolName: "getEmployee", args: { id: "EMP001" } }],
          usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
          durationMs: 150,
          hydratedTools: ["getEmployee"],
          turnId: "turn-1",
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterAll(() => {
    server.close();
  });

  it("sends POST /send-message and parses response into AgentResponse", async () => {
    const harness = createHttpHarness(PORT);
    const response = await harness.sendMessage(
      [{ role: "user", content: "Hello" }],
      42,
      ["getEmployee"],
      "turn-abc",
    );

    expect(lastBody).toEqual({
      history: [{ role: "user", content: "Hello" }],
      seed: 42,
      expectedTools: ["getEmployee"],
      turnId: "turn-abc",
    });
    expect(response.content).toBe("HTTP response");
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].toolName).toBe("getEmployee");
    expect(response.usage.totalTokens).toBe(100);
    expect(response.durationMs).toBe(150);
    expect(response.hydratedTools).toEqual(["getEmployee"]);
    expect(response.turnId).toBe("turn-1");
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
        { toolCallId: "1", toolName: "getEmployee", args: { name: "Marco Rossi" } },
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
  });

  it("handles multi-turn scenarios with followUps", async () => {
    const harness = createMockHarness();
    const scenario = createScenario({
      type: "multi-turn",
      followUps: ["What about his bonus?", "And his benefits?"],
    });
    await runScenario(harness, scenario);

    expect(harness.sendMessage).toHaveBeenCalledTimes(3);
    const firstCall = (harness.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall[0]).toEqual([{ role: "user", content: scenario.query }]);

    const secondCall = (harness.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[0]).toHaveLength(3);
    expect(secondCall[0][2].content).toBe("What about his bonus?");
  });

  it("aggregates token usage across multi-turn", async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({
        content: "first",
        toolCalls: [{ toolCallId: "1", toolName: "getEmployee", args: {} }],
        usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
        durationMs: 50,
      })
      .mockResolvedValueOnce({
        content: "second",
        toolCalls: [{ toolCallId: "2", toolName: "getSalary", args: {} }],
        usage: { totalTokens: 150, inputTokens: 120, outputTokens: 30 },
        durationMs: 60,
      });

    const harness: TestHarness = { sendMessage };
    const scenario = createScenario({ type: "multi-turn", followUps: ["follow-up"] });
    const result = await runScenario(harness, scenario);

    expect(result.response.usage.totalTokens).toBe(250);
    expect(result.response.durationMs).toBe(110);
    expect(result.response.toolCalls).toHaveLength(2);
  });
});
