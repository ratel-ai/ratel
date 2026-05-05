import type { BenchmarkOutput, TokenUsage } from "../lib/types.js";

export function computeTokenEfficiency(output: BenchmarkOutput): TokenUsage {
  const { usage } = output.response;
  const result: TokenUsage = {
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
  if (usage.cachedInputTokens != null) {
    result.cachedInputTokens = usage.cachedInputTokens;
  }
  return result;
}

export function computeDurationMs(output: BenchmarkOutput): number {
  return output.response.durationMs;
}
