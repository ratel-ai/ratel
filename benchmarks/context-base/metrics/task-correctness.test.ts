import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BenchmarkOutput } from "../lib/types.js";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

vi.mock("@ai-sdk/google", () => ({
  google: vi.fn(() => "mocked-model"),
}));

import { generateObject } from "ai";
import { TaskCorrectness } from "./task-correctness.js";

const mockedGenerateObject = vi.mocked(generateObject);

function makeOutput(
  overrides: Partial<BenchmarkOutput["scenario"]> = {},
  responseOverrides: Partial<BenchmarkOutput["response"]> = {},
): BenchmarkOutput {
  return {
    scenario: {
      id: 1,
      query: "Get employee info for Marco",
      expectedTools: ["getEmployee"],
      type: "retrieval",
      seed: 1,
      ...overrides,
    },
    response: {
      content: "Here is Marco's info...",
      toolCalls: [
        {
          type: "tool-call" as const,
          toolCallId: "call-1",
          toolName: "getEmployee",
          args: { name: "Marco" },
        },
      ],
      usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
      durationMs: 500,
      ...responseOverrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TaskCorrectness (LLM judge path)", () => {
  it("returns score and reasoning from LLM judge", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { score: 1.0, reasoning: "Correctly retrieved employee info" },
    } as any);

    const result = await TaskCorrectness(makeOutput());

    expect(result.score).toBe(1.0);
    expect(result.reasoning).toBe("Correctly retrieved employee info");
    expect(mockedGenerateObject).toHaveBeenCalledOnce();
  });

  it("passes scenario context to LLM judge", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { score: 0.5, reasoning: "Partial match" },
    } as any);

    const output = makeOutput({ query: "Book a room", type: "action" });
    await TaskCorrectness(output);

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.prompt).toContain("Book a room");
  });

  it("includes tool coverage summary instead of raw expected tools", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { score: 0.8, reasoning: "Good" },
    } as any);

    const output = makeOutput(
      { expectedTools: ["getEmployee", "getSalary"] },
      {
        toolCalls: [
          {
            type: "tool-call" as const,
            toolCallId: "call-1",
            toolName: "getEmployee",
            args: {},
          },
        ],
      },
    );
    await TaskCorrectness(output);

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.prompt).toContain("Tool coverage: 50%");
    expect(call.prompt).toContain("Missing: getSalary");
    expect(call.prompt).toContain("Score ONLY the response correctness");
    expect(call.prompt).not.toContain("Expected tools:");
  });

  it("shows 100% coverage when all slots satisfied", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { score: 1.0, reasoning: "Perfect" },
    } as any);

    const output = makeOutput(
      { expectedTools: [["getEmployee", "searchEmployees"], "getSalary"] },
      {
        toolCalls: [
          { type: "tool-call" as const, toolCallId: "c1", toolName: "searchEmployees", args: {} },
          { type: "tool-call" as const, toolCallId: "c2", toolName: "getSalary", args: {} },
        ],
      },
    );
    await TaskCorrectness(output);

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.prompt).toContain("Tool coverage: 100%");
    expect(call.prompt).not.toContain("Missing:");
  });

  it("handles negative scenario — still uses behavioral evaluation", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { score: 1.0, reasoning: "Correctly declined" },
    } as any);

    const output = makeOutput(
      { type: "negative", expectedTools: [] },
      { toolCalls: [], content: "I cannot help with that" },
    );
    await TaskCorrectness(output);

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.prompt).toContain("negative");
    // negative/ambiguous still include tool info for behavioral evaluation
    expect(call.prompt).toContain("Tools called: (none)");
  });

  it("handles ambiguous scenario context", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { score: 0.8, reasoning: "Asked for clarification" },
    } as any);

    const output = makeOutput(
      { type: "ambiguous", expectedTools: ["getEmployee"] },
      { content: "Could you clarify which employee?" },
    );
    const result = await TaskCorrectness(output);
    expect(result.score).toBe(0.8);
    expect(result.reasoning).toBe("Asked for clarification");
  });

  it("returns 0 with failure reasoning on LLM error", async () => {
    mockedGenerateObject.mockRejectedValueOnce(new Error("API error"));

    const result = await TaskCorrectness(makeOutput());
    expect(result.score).toBe(0);
    expect(result.reasoning).toBe("Judge call failed");
  });
});

describe("TaskCorrectness (deterministic path)", () => {
  it("returns 1.0 when tool called with correct params", async () => {
    const output = makeOutput(
      {
        type: "action",
        expectedTools: ["bookRoom"],
        expectedParams: { bookRoom: { roomId: "A1", date: "2026-03-01" } },
      },
      {
        toolCalls: [
          {
            type: "tool-call" as const,
            toolCallId: "call-1",
            toolName: "bookRoom",
            args: { roomId: "A1", date: "2026-03-01" },
          },
        ],
      },
    );

    const result = await TaskCorrectness(output);
    expect(result.score).toBe(1.0);
    expect(result.reasoning).toBeUndefined();
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });

  it("returns 0 when expected tool not called", async () => {
    const output = makeOutput(
      {
        type: "action",
        expectedTools: ["bookRoom"],
        expectedParams: { bookRoom: { roomId: "A1" } },
      },
      { toolCalls: [] },
    );

    const result = await TaskCorrectness(output);
    expect(result.score).toBe(0);
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });

  it("returns fractional score for partial match", async () => {
    const output = makeOutput(
      {
        type: "action",
        expectedTools: ["bookRoom", "sendNotification"],
        expectedParams: {
          bookRoom: { roomId: "A1" },
          sendNotification: { to: "alice" },
        },
      },
      {
        toolCalls: [
          {
            type: "tool-call" as const,
            toolCallId: "call-1",
            toolName: "bookRoom",
            args: { roomId: "A1" },
          },
        ],
      },
    );

    const result = await TaskCorrectness(output);
    expect(result.score).toBe(0.5);
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });

  it("matches params case-insensitively", async () => {
    const output = makeOutput(
      {
        type: "action",
        expectedTools: ["createNDA"],
        expectedParams: { createNDA: { scope: "shared product roadmap" } },
      },
      {
        toolCalls: [
          {
            type: "tool-call" as const,
            toolCallId: "call-1",
            toolName: "createNDA",
            args: { scope: "Shared product roadmap" },
          },
        ],
      },
    );

    const result = await TaskCorrectness(output);
    expect(result.score).toBe(1.0);
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });

  it("falls through to LLM judge when expectedParams is empty", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { score: 0.9, reasoning: "Good" },
    } as any);

    const output = makeOutput({
      type: "action",
      expectedTools: ["bookRoom"],
      expectedParams: {},
    });

    const result = await TaskCorrectness(output);
    expect(result.score).toBe(0.9);
    expect(result.reasoning).toBe("Good");
    expect(mockedGenerateObject).toHaveBeenCalledOnce();
  });

  it("falls through to LLM judge when expectedParams is undefined", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { score: 0.8, reasoning: "OK" },
    } as any);

    const output = makeOutput({
      type: "action",
      expectedTools: ["bookRoom"],
    });

    const result = await TaskCorrectness(output);
    expect(result.score).toBe(0.8);
    expect(result.reasoning).toBe("OK");
    expect(mockedGenerateObject).toHaveBeenCalledOnce();
  });
});

describe("TaskCorrectness scorer shape", () => {
  it("returns ScorerResult with name, score and reasoning", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { score: 0.75, reasoning: "Mostly correct" },
    } as any);

    const result = await TaskCorrectness(makeOutput());
    expect(result.name).toBe("Task Correctness");
    expect(result.score).toBe(0.75);
    expect(result.reasoning).toBe("Mostly correct");
  });
});
