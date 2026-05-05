import { describe, it, expect } from "vitest";
import { computeTokenEfficiency, computeDurationMs } from "./efficiency.js";
import type { BenchmarkOutput } from "../lib/types.js";

function makeOutput(
  usage: { totalTokens: number; inputTokens: number; outputTokens: number; cachedInputTokens?: number },
  durationMs: number,
): BenchmarkOutput {
  return {
    scenario: {
      id: 1,
      query: "test",
      expectedTools: [],
      type: "retrieval",
      seed: 1,
    },
    response: {
      content: "ok",
      toolCalls: [],
      usage,
      durationMs,
    },
  };
}

describe("efficiency metrics", () => {
  describe("computeTokenEfficiency", () => {
    it("returns total tokens", () => {
      const out = makeOutput(
        { totalTokens: 1500, inputTokens: 1000, outputTokens: 500 },
        100,
      );
      expect(computeTokenEfficiency(out)).toEqual({
        totalTokens: 1500,
        inputTokens: 1000,
        outputTokens: 500,
      });
    });

    it("includes cached tokens when present", () => {
      const out = makeOutput(
        { totalTokens: 1500, inputTokens: 1000, outputTokens: 500, cachedInputTokens: 300 },
        100,
      );
      expect(computeTokenEfficiency(out)).toEqual({
        totalTokens: 1500,
        inputTokens: 1000,
        outputTokens: 500,
        cachedInputTokens: 300,
      });
    });
  });

  describe("computeDurationMs", () => {
    it("returns duration in milliseconds", () => {
      const out = makeOutput(
        { totalTokens: 100, inputTokens: 50, outputTokens: 50 },
        1234,
      );
      expect(computeDurationMs(out)).toBe(1234);
    });
  });
});
