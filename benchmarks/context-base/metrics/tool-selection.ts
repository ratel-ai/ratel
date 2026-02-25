import type { BenchmarkOutput } from "../lib/types.js";
import { slotPrecision, slotRecall } from "../lib/tool-slots.js";

export function computePrecision(output: BenchmarkOutput): number {
  return slotPrecision(uniqueToolNames(output), output.scenario.expectedTools);
}

export function computeRecall(output: BenchmarkOutput): number {
  return slotRecall(uniqueToolNames(output), output.scenario.expectedTools);
}

export function computeF1(output: BenchmarkOutput): number {
  const p = computePrecision(output);
  const r = computeRecall(output);
  if (p + r === 0) return 0;
  return (2 * p * r) / (p + r);
}

function uniqueToolNames(output: BenchmarkOutput): string[] {
  return [...new Set(output.response.toolCalls.map((tc) => tc.toolName))];
}
