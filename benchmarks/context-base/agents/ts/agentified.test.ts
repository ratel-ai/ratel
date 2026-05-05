import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SendMessageBody, ToolDef } from "../../lib/protocol.js";

const mockGenerate = vi.fn();
const mockRegister = vi.fn();
vi.mock("@agentified/mastra", () => ({
  AgentifiedMastra: vi.fn(() => ({
    generate: mockGenerate,
    register: mockRegister,
  })),
  jsonSchemaToZod: vi.fn(),
}));

vi.mock("@mastra/core/agent", () => ({
  Agent: vi.fn(() => ({})),
}));

const { createCallbacks } = await import("./agentified.js");

describe("agentified agent (HTTP)", () => {
  const mockTools: ToolDef[] = [
    { name: "getEmployee", description: "Get employee", parameters: { type: "object", properties: { id: { type: "string" } } }, script: "/fake/getEmployee.sh" },
    { name: "getSalary", description: "Get salary", parameters: { type: "object", properties: { id: { type: "string" } } }, script: "/fake/getSalary.sh" },
  ];
  const mockConfig = {
    agentifiedEndpoint: "http://localhost:9119",
    model: "gpt-5",
    systemPrompt: "You are helpful",
    maxSteps: 10,
  };

  function defaultGenerateResult(overrides: Record<string, any> = {}) {
    return {
      text: "Done",
      toolCalls: [],
      steps: [],
      usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
      hydratedTools: [],
      durationMs: 100,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerate.mockResolvedValue(defaultGenerateResult());
    mockRegister.mockResolvedValue(undefined);
  });

  it("setup calls register()", async () => {
    const cbs = createCallbacks();
    const execTools = mockTools.map((t) => ({ ...t, execute: vi.fn() }));
    await cbs.setup(execTools, mockConfig);
    expect(mockRegister).toHaveBeenCalledOnce();
  });

  it("sendMessage calls generate with correct params", async () => {
    const cbs = createCallbacks();
    await cbs.setup(mockTools.map((t) => ({ ...t, execute: vi.fn() })), mockConfig);

    const body: SendMessageBody = {
      history: [{ role: "user", content: "What's Marco's salary?" }],
      seed: 42,
      turnId: "turn-abc",
    };
    await cbs.sendMessage(body);

    expect(mockGenerate).toHaveBeenCalledOnce();
    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: "What's Marco's salary?" }],
        seed: 42,
        turnId: "turn-abc",
      }),
    );
  });

  it("maps generate result to SendMessageResponse", async () => {
    mockGenerate.mockResolvedValueOnce(
      defaultGenerateResult({
        text: "Salary is $95k",
        toolCalls: [{ toolName: "getSalary", toolCallId: "c1", args: { id: "EMP001" } }],
        hydratedTools: ["getEmployee", "getSalary"],
        turnId: "new-turn",
        durationMs: 250,
      }),
    );

    const cbs = createCallbacks();
    await cbs.setup(mockTools.map((t) => ({ ...t, execute: vi.fn() })), mockConfig);

    const result = await cbs.sendMessage({
      history: [{ role: "user", content: "test" }],
      seed: 1,
    });

    expect(result.content).toBe("Salary is $95k");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe("getSalary");
    expect(result.hydratedTools).toEqual(["getEmployee", "getSalary"]);
    expect(result.turnId).toBe("new-turn");
    expect(result.durationMs).toBe(250);
  });

  it("maps usage correctly", async () => {
    mockGenerate.mockResolvedValueOnce(
      defaultGenerateResult({
        usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50, cachedInputTokens: 20, reasoningTokens: 5 },
      }),
    );

    const cbs = createCallbacks();
    await cbs.setup(mockTools.map((t) => ({ ...t, execute: vi.fn() })), mockConfig);

    const result = await cbs.sendMessage({ history: [{ role: "user", content: "test" }], seed: 1 });

    expect(result.usage).toEqual({
      totalTokens: 50,
      inputTokens: 40,
      outputTokens: 10,
      cachedInputTokens: 20,
      outputReasoningTokens: 5,
    });
  });
});
