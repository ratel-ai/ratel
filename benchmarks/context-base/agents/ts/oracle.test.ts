import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SendMessageBody, ToolDef } from "../../lib/protocol.js";

const mockGenerateText = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: (...args: unknown[]) => mockGenerateText(...args),
    stepCountIs: actual.stepCountIs,
  };
});

const { createCallbacks } = await import("./oracle.js");

describe("oracle agent (HTTP)", () => {
  const mockTools: ToolDef[] = [
    { name: "getEmployee", description: "Get employee", parameters: { type: "object", properties: { id: { type: "string" } } }, script: "/fake/getEmployee.sh" },
    { name: "getSalary", description: "Get salary", parameters: { type: "object", properties: { id: { type: "string" } } }, script: "/fake/getSalary.sh" },
    { name: "listEmployees", description: "List employees", parameters: { type: "object", properties: {} }, script: "/fake/listEmployees.sh" },
  ];
  const mockConfig = { model: "gpt-5", systemPrompt: "You are helpful", maxSteps: 10 };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters tools to only expectedTools", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Salary is $95k",
      steps: [{ toolCalls: [{ toolCallId: "c1", toolName: "getSalary", args: { id: "EMP001" } }] }],
      usage: { promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10, inputTokenDetails: {}, outputTokenDetails: {} },
    });

    const cbs = createCallbacks();
    await cbs.setup(mockTools.map((t) => ({ ...t, execute: vi.fn() })), mockConfig);

    const body: SendMessageBody = {
      history: [{ role: "user", content: "What's Marco's salary?" }],
      seed: 42,
      expectedTools: ["getEmployee", "getSalary"],
    };
    await cbs.sendMessage(body);

    const call = mockGenerateText.mock.calls[0][0];
    expect(Object.keys(call.tools).sort()).toEqual(["getEmployee", "getSalary"]);
  });

  it("returns hydratedTools matching expectedTools", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "ok",
      steps: [],
      usage: { promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10, inputTokenDetails: {}, outputTokenDetails: {} },
    });

    const cbs = createCallbacks();
    await cbs.setup(mockTools.map((t) => ({ ...t, execute: vi.fn() })), mockConfig);

    const result = await cbs.sendMessage({
      history: [{ role: "user", content: "test" }],
      seed: 1,
      expectedTools: ["getSalary"],
    });

    expect(result.hydratedTools).toEqual(["getSalary"]);
  });

  it("uses all tools when no expectedTools provided", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "ok",
      steps: [],
      usage: { promptTokens: 40, completionTokens: 10 },
      totalUsage: { inputTokens: 40, outputTokens: 10, inputTokenDetails: {}, outputTokenDetails: {} },
    });

    const cbs = createCallbacks();
    await cbs.setup(mockTools.map((t) => ({ ...t, execute: vi.fn() })), mockConfig);

    await cbs.sendMessage({ history: [{ role: "user", content: "test" }], seed: 1 });

    const call = mockGenerateText.mock.calls[0][0];
    expect(Object.keys(call.tools).sort()).toEqual(["getEmployee", "getSalary", "listEmployees"]);
  });
});
