import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SendMessageBody, ToolDef } from "../../lib/protocol.js";

const mockGenerate = vi.fn();
vi.mock("@mastra/core/agent", () => ({
  Agent: class MockAgent {
    generate = mockGenerate;
  },
}));

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

  it("passes only expectedTools via toolsets", async () => {
    mockGenerate.mockResolvedValueOnce({
      text: "Salary is $95k",
      steps: [{ toolCalls: [{ toolCallId: "c1", toolName: "getSalary", args: { id: "EMP001" } }] }],
      usage: { inputTokens: 40, outputTokens: 10 },
    });

    const cbs = createCallbacks();
    await cbs.setup(mockTools.map((t) => ({ ...t, execute: vi.fn() })), mockConfig);

    const body: SendMessageBody = {
      history: [{ role: "user", content: "What's Marco's salary?" }],
      seed: 42,
      expectedTools: ["getEmployee", "getSalary"],
    };
    await cbs.sendMessage(body);

    const [, opts] = mockGenerate.mock.calls[0];
    const toolsetNames = Object.keys(opts.toolsets.active);
    expect(toolsetNames.sort()).toEqual(["getEmployee", "getSalary"]);
  });

  it("returns hydratedTools matching expectedTools", async () => {
    mockGenerate.mockResolvedValueOnce({
      text: "ok",
      steps: [],
      usage: { inputTokens: 40, outputTokens: 10 },
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

  it("passes all tools via toolsets when no expectedTools", async () => {
    mockGenerate.mockResolvedValueOnce({
      text: "ok",
      steps: [],
      usage: { inputTokens: 40, outputTokens: 10 },
    });

    const cbs = createCallbacks();
    await cbs.setup(mockTools.map((t) => ({ ...t, execute: vi.fn() })), mockConfig);

    await cbs.sendMessage({ history: [{ role: "user", content: "test" }], seed: 1 });

    const [, opts] = mockGenerate.mock.calls[0];
    const toolsetNames = Object.keys(opts.toolsets.active);
    expect(toolsetNames.sort()).toEqual(["getEmployee", "getSalary", "listEmployees"]);
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
    await cbs.sendMessage({
      history: [{ role: "user", content: "test" }],
      seed: 1,
      expectedTools: ["getSalary"],
    });

    // If we got here without error, __setTools was not called
    expect(true).toBe(true);
  });
});
