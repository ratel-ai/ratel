import { describe, it, expect } from "vitest";
import {
  computePrecision,
  computeRecall,
  computeF1,
} from "./tool-selection.js";
import type { BenchmarkOutput } from "../lib/types.js";
import type { ToolSlot } from "../lib/tool-slots.js";

function makeOutput(
  toolNames: string[],
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
      content: "ok",
      toolCalls: toolNames.map((name) => ({
        type: "tool-call" as const,
        toolCallId: `call-${name}`,
        toolName: name,
        input: {},
      })),
      usage: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
      durationMs: 0,
    },
  };
}

describe("tool-selection metrics", () => {
  describe("computePrecision", () => {
    it("returns 1 when all selected tools are expected", () => {
      const out = makeOutput(["getEmployee", "getSalary"], ["getEmployee", "getSalary"]);
      expect(computePrecision(out)).toBe(1);
    });

    it("returns 0 when no selected tools are expected", () => {
      const out = makeOutput(["createEmployee"], ["getEmployee", "getSalary"]);
      expect(computePrecision(out)).toBe(0);
    });

    it("returns fraction when some selected tools are expected", () => {
      const out = makeOutput(
        ["getEmployee", "getSalary", "createEmployee"],
        ["getEmployee", "getSalary"],
      );
      expect(computePrecision(out)).toBeCloseTo(2 / 3);
    });

    it("returns 1 when no tools selected and none expected (negative scenario)", () => {
      const out = makeOutput([], []);
      expect(computePrecision(out)).toBe(1);
    });

    it("returns 0 when tools selected but none expected", () => {
      const out = makeOutput(["getEmployee"], []);
      expect(computePrecision(out)).toBe(0);
    });

    it("deduplicates repeated tool calls", () => {
      const out = makeOutput(
        ["getEmployee", "getEmployee", "getSalary"],
        ["getEmployee", "getSalary"],
      );
      expect(computePrecision(out)).toBe(1);
    });
  });

  describe("computeRecall", () => {
    it("returns 1 when all expected tools are selected", () => {
      const out = makeOutput(["getEmployee", "getSalary"], ["getEmployee", "getSalary"]);
      expect(computeRecall(out)).toBe(1);
    });

    it("returns 0 when no expected tools are selected", () => {
      const out = makeOutput(["createEmployee"], ["getEmployee", "getSalary"]);
      expect(computeRecall(out)).toBe(0);
    });

    it("returns fraction when some expected tools are selected", () => {
      const out = makeOutput(["getEmployee"], ["getEmployee", "getSalary"]);
      expect(computeRecall(out)).toBeCloseTo(0.5);
    });

    it("returns 1 when no tools expected and none selected (negative scenario)", () => {
      const out = makeOutput([], []);
      expect(computeRecall(out)).toBe(1);
    });

    it("returns 1 when no tools expected but some selected", () => {
      // recall = expected covered / expected total; 0/0 = 1
      const out = makeOutput(["getEmployee"], []);
      expect(computeRecall(out)).toBe(1);
    });
  });

  describe("computeF1", () => {
    it("returns 1 for perfect match", () => {
      const out = makeOutput(["getEmployee", "getSalary"], ["getEmployee", "getSalary"]);
      expect(computeF1(out)).toBe(1);
    });

    it("returns 0 when precision and recall are both 0", () => {
      const out = makeOutput(["createEmployee"], ["getEmployee"]);
      expect(computeF1(out)).toBe(0);
    });

    it("returns harmonic mean of precision and recall", () => {
      // selected: [getEmployee, createEmployee], expected: [getEmployee, getSalary]
      // precision: 1/2, recall: 1/2 → F1 = 2*(0.5*0.5)/(0.5+0.5) = 0.5
      const out = makeOutput(
        ["getEmployee", "createEmployee"],
        ["getEmployee", "getSalary"],
      );
      expect(computeF1(out)).toBeCloseTo(0.5);
    });

    it("returns 1 for negative scenario with no tools", () => {
      const out = makeOutput([], []);
      expect(computeF1(out)).toBe(1);
    });
  });

  describe("alternative tool slots", () => {
    it("recall: satisfies slot when any alternative called", () => {
      const out = makeOutput(
        ["searchEmployees", "getSalary"],
        [["getEmployee", "searchEmployees"], "getSalary"],
      );
      expect(computeRecall(out)).toBe(1);
    });

    it("recall: partial when one slot unsatisfied", () => {
      const out = makeOutput(
        ["searchEmployees"],
        [["getEmployee", "searchEmployees"], "getSalary"],
      );
      expect(computeRecall(out)).toBe(0.5);
    });

    it("precision: alternative match counts as valid", () => {
      const out = makeOutput(
        ["searchEmployees", "getSalary"],
        [["getEmployee", "searchEmployees"], "getSalary"],
      );
      expect(computePrecision(out)).toBe(1);
    });

    it("precision: extra tool beyond alternatives lowers score", () => {
      const out = makeOutput(
        ["searchEmployees", "getSalary", "createEmployee"],
        [["getEmployee", "searchEmployees"], "getSalary"],
      );
      expect(computePrecision(out)).toBeCloseTo(2 / 3);
    });

    it("F1: perfect with alternative used", () => {
      const out = makeOutput(
        ["getEmployee", "getSalary"],
        [["getEmployee", "searchEmployees"], "getSalary"],
      );
      expect(computeF1(out)).toBe(1);
    });
  });
});
