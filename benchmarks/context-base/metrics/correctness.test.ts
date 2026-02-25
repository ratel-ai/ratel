import { describe, it, expect } from "vitest";
import { computeActionCorrectness, computeNegativeCorrectness } from "./correctness.js";
import type { BenchmarkOutput } from "../lib/types.js";
import type { ToolCallPart } from "ai";

function makeToolCall(name: string, input: Record<string, unknown>): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId: `call-${name}`,
    toolName: name,
    input,
  };
}

function makeActionOutput(
  toolCalls: ToolCallPart[],
  expectedParams: Record<string, Record<string, unknown>>,
): BenchmarkOutput {
  return {
    scenario: {
      id: 9,
      query: "test action",
      expectedTools: toolCalls.map((tc) => tc.toolName),
      type: "action",
      seed: 1,
      expectedParams,
    },
    response: {
      content: "done",
      toolCalls,
      usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      durationMs: 0,
    },
  };
}

describe("correctness metrics", () => {
  describe("computeActionCorrectness", () => {
    it("returns 1 when all expected params match", () => {
      const out = makeActionOutput(
        [
          makeToolCall("getEmployee", { employeeId: "EMP-001" }),
          makeToolCall("updateEmployee", { email: "marco@newdomain.com" }),
        ],
        { updateEmployee: { email: "marco@newdomain.com" } },
      );
      expect(computeActionCorrectness(out)).toBe(1);
    });

    it("returns 0 when expected tool was not called", () => {
      const out = makeActionOutput(
        [makeToolCall("getEmployee", { employeeId: "EMP-001" })],
        { updateEmployee: { email: "marco@newdomain.com" } },
      );
      expect(computeActionCorrectness(out)).toBe(0);
    });

    it("returns 0 when params dont match", () => {
      const out = makeActionOutput(
        [makeToolCall("updateEmployee", { email: "wrong@email.com" })],
        { updateEmployee: { email: "marco@newdomain.com" } },
      );
      expect(computeActionCorrectness(out)).toBe(0);
    });

    it("returns 1 when expected params are subset of actual args", () => {
      const out = makeActionOutput(
        [
          makeToolCall("updateEmployee", {
            employeeId: "EMP-001",
            email: "marco@newdomain.com",
            name: "Marco",
          }),
        ],
        { updateEmployee: { email: "marco@newdomain.com" } },
      );
      expect(computeActionCorrectness(out)).toBe(1);
    });

    it("returns fraction for partial match across multiple tools", () => {
      const out = makeActionOutput(
        [
          makeToolCall("updateSalary", { baseSalary: 104500 }),
          makeToolCall("enrollBenefits", { planIds: ["WRONG"] }),
        ],
        {
          updateSalary: { baseSalary: 104500 },
          enrollBenefits: { planIds: ["PLAN-DENTAL"] },
        },
      );
      expect(computeActionCorrectness(out)).toBeCloseTo(0.5);
    });

    it("returns 1 when no expectedParams defined", () => {
      const out: BenchmarkOutput = {
        scenario: {
          id: 9,
          query: "test",
          expectedTools: ["getEmployee"],
          type: "action",
          seed: 1,
        },
        response: {
          content: "done",
          toolCalls: [makeToolCall("getEmployee", {})],
          usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
          durationMs: 0,
        },
      };
      expect(computeActionCorrectness(out)).toBe(1);
    });

    it("handles array params with deep equality", () => {
      const out = makeActionOutput(
        [makeToolCall("enrollBenefits", { planIds: ["PLAN-DENTAL"] })],
        { enrollBenefits: { planIds: ["PLAN-DENTAL"] } },
      );
      expect(computeActionCorrectness(out)).toBe(1);
    });
  });

  describe("computeNegativeCorrectness", () => {
    it("returns 1 when no tools were called", () => {
      const out: BenchmarkOutput = {
        scenario: {
          id: 21,
          query: "What's the weather?",
          expectedTools: [],
          type: "negative",
          seed: 1,
        },
        response: {
          content: "I can't help with weather",
          toolCalls: [],
          usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
          durationMs: 0,
        },
      };
      expect(computeNegativeCorrectness(out)).toBe(1);
    });

    it("returns 0 when tools were called", () => {
      const out: BenchmarkOutput = {
        scenario: {
          id: 21,
          query: "What's the weather?",
          expectedTools: [],
          type: "negative",
          seed: 1,
        },
        response: {
          content: "checking...",
          toolCalls: [makeToolCall("getEmployee", {})],
          usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
          durationMs: 0,
        },
      };
      expect(computeNegativeCorrectness(out)).toBe(0);
    });
  });
});
