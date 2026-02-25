import { describe, it, expect } from "vitest";
import {
  ToolPrecision,
  ToolRecall,
  ToolF1,
  NegativeCorrectness,
} from "./scorers.js";
import type { BenchmarkOutput } from "../lib/types.js";

function makeOutput(
  toolNames: string[],
  expectedTools: string[],
  type: "retrieval" | "action" | "negative" = "retrieval",
  expectedParams?: Record<string, Record<string, unknown>>,
): BenchmarkOutput {
  return {
    scenario: {
      id: 1,
      query: "test",
      expectedTools,
      type,
      seed: 1,
      expectedParams,
    },
    response: {
      content: "ok",
      toolCalls: toolNames.map((name) => ({
        type: "tool-call" as const,
        toolCallId: `call-${name}`,
        toolName: name,
        input: {},
      })),
      usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
      durationMs: 500,
    },
  };
}

describe("scorers", () => {
  it("ToolPrecision returns score", async () => {
    const out = makeOutput(["getEmployee", "getSalary"], ["getEmployee", "getSalary"]);
    const result = await ToolPrecision(out);
    expect(result.score).toBe(1);
    expect(result.name).toBe("Tool Precision");
  });

  it("ToolRecall returns score", async () => {
    const out = makeOutput(["getEmployee"], ["getEmployee", "getSalary"]);
    const result = await ToolRecall(out);
    expect(result.score).toBeCloseTo(0.5);
  });

  it("ToolF1 returns score", async () => {
    const out = makeOutput(["getEmployee", "getSalary"], ["getEmployee", "getSalary"]);
    const result = await ToolF1(out);
    expect(result.score).toBe(1);
  });

  it("NegativeCorrectness returns 1 for non-negative scenarios", async () => {
    const out = makeOutput(["getEmployee"], ["getEmployee"], "retrieval");
    const result = await NegativeCorrectness(out);
    expect(result.score).toBe(1);
  });

  it("NegativeCorrectness evaluates negative scenarios", async () => {
    const out = makeOutput([], [], "negative");
    const result = await NegativeCorrectness(out);
    expect(result.score).toBe(1);
  });

  it("NegativeCorrectness fails when tools called in negative scenario", async () => {
    const out = makeOutput(["getEmployee"], [], "negative");
    const result = await NegativeCorrectness(out);
    expect(result.score).toBe(0);
  });
});
