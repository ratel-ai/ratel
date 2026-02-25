import type { BenchmarkOutput } from "../lib/types.js";

export function computeActionCorrectness(output: BenchmarkOutput): number {
  const { expectedParams } = output.scenario;
  if (!expectedParams || Object.keys(expectedParams).length === 0) return 1;

  const entries = Object.entries(expectedParams);
  let matched = 0;

  for (const [toolName, params] of entries) {
    const call = output.response.toolCalls.find((tc) => tc.toolName === toolName);
    if (!call) continue;
    const actual = (call as any).input ?? call.args ?? {};
    if (paramsMatch(actual as Record<string, unknown>, params)) {
      matched++;
    }
  }

  return matched / entries.length;
}

export function computeNegativeCorrectness(output: BenchmarkOutput): number {
  return output.response.toolCalls.length === 0 ? 1 : 0;
}

function paramsMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (!deepEqual(actual[key], value)) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  if (a == null || b == null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = Object.keys(bObj);
    return keys.every((k) => deepEqual(aObj[k], bObj[k]));
  }
  return false;
}
