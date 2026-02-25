import { describe, it, expect } from "vitest";
import type { BenchmarkOutput } from "../lib/types.js";
import type { ToolSlot } from "../lib/tool-slots.js";
import { computeHydrationRecall } from "./hydration.js";

function makeOutput(
  hydratedTools: string[] | undefined,
  expectedTools: ToolSlot[],
): BenchmarkOutput {
  return {
    scenario: {
      id: 1,
      query: "test",
      expectedTools,
      type: "retrieval",
      seed: 1,
    },
    response: {
      content: "",
      toolCalls: [],
      usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      durationMs: 0,
      hydratedTools,
    },
  };
}

describe("computeHydrationRecall", () => {
  it("returns 1 when all expected tools are hydrated", () => {
    const output = makeOutput(["getEmployee", "getSalary", "extra"], ["getEmployee", "getSalary"]);
    expect(computeHydrationRecall(output)).toBe(1);
  });

  it("returns fractional score for partial hydration", () => {
    const output = makeOutput(["getEmployee"], ["getEmployee", "getSalary"]);
    expect(computeHydrationRecall(output)).toBe(0.5);
  });

  it("returns 0 when no expected tools are hydrated", () => {
    const output = makeOutput(["unrelated"], ["getEmployee", "getSalary"]);
    expect(computeHydrationRecall(output)).toBe(0);
  });

  it("returns 1 when hydratedTools is undefined (no hydration)", () => {
    const output = makeOutput(undefined, ["getEmployee"]);
    expect(computeHydrationRecall(output)).toBe(1);
  });

  it("returns 1 when expectedTools is empty", () => {
    const output = makeOutput(["getEmployee"], []);
    expect(computeHydrationRecall(output)).toBe(1);
  });

  it("returns 1 when both are empty", () => {
    const output = makeOutput([], []);
    expect(computeHydrationRecall(output)).toBe(1);
  });

  it("satisfies alternative slot when any alternative hydrated", () => {
    const output = makeOutput(
      ["searchEmployees", "getSalary"],
      [["getEmployee", "searchEmployees"], "getSalary"],
    );
    expect(computeHydrationRecall(output)).toBe(1);
  });

  it("partial recall with alternative slot unsatisfied", () => {
    const output = makeOutput(
      ["getSalary"],
      [["getEmployee", "searchEmployees"], "getSalary"],
    );
    expect(computeHydrationRecall(output)).toBe(0.5);
  });
});
