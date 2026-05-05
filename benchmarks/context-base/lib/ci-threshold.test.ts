import { describe, it, expect } from "vitest";
import { checkThresholds, type ThresholdConfig, type EvaliteExportedOutput } from "./ci-threshold.js";

const makeOutput = (scores: Record<string, number[]>): EvaliteExportedOutput => ({
  run: { id: 1, runType: "full", createdAt: "2026-01-01T00:00:00Z" },
  suites: [
    {
      name: "Context Base Benchmark",
      evals: Object.values(scores)[0]?.map((_, i) => ({
        scores: Object.entries(scores).map(([name, values]) => ({
          name,
          score: values[i] ?? 0,
        })),
      })) ?? [],
    },
  ],
});

describe("checkThresholds", () => {
  it("passes when all averages meet thresholds", () => {
    const output = makeOutput({
      "Tool F1": [0.8, 0.9, 0.7],
      "Tool Precision": [0.9, 0.85, 0.95],
    });
    const thresholds: ThresholdConfig = {
      "Tool F1": 0.7,
      "Tool Precision": 0.8,
    };
    const { passed, details } = checkThresholds(output, thresholds);
    expect(passed).toBe(true);
    expect(details).toHaveLength(2);
    expect(details.every((d) => d.passed)).toBe(true);
  });

  it("fails when an average is below threshold", () => {
    const output = makeOutput({ "Tool F1": [0.3, 0.2, 0.1] });
    const thresholds: ThresholdConfig = { "Tool F1": 0.5 };
    const { passed, details } = checkThresholds(output, thresholds);
    expect(passed).toBe(false);
    expect(details[0].passed).toBe(false);
    expect(details[0].average).toBeCloseTo(0.2, 5);
  });

  it("returns correct averages", () => {
    const output = makeOutput({ "Tool F1": [1.0, 0.5, 0.5] });
    const thresholds: ThresholdConfig = { "Tool F1": 0.6 };
    const { details } = checkThresholds(output, thresholds);
    expect(details[0].average).toBeCloseTo(2 / 3, 5);
    expect(details[0].passed).toBe(true);
  });

  it("handles missing scorer gracefully", () => {
    const output = makeOutput({ "Tool Precision": [0.9] });
    const thresholds: ThresholdConfig = { "Tool F1": 0.5 };
    const { passed, details } = checkThresholds(output, thresholds);
    expect(passed).toBe(false);
    expect(details[0].average).toBe(0);
    expect(details[0].passed).toBe(false);
  });

  it("passes with empty thresholds", () => {
    const output = makeOutput({ "Tool F1": [0.1] });
    const { passed, details } = checkThresholds(output, {});
    expect(passed).toBe(true);
    expect(details).toHaveLength(0);
  });

  it("handles exact threshold match", () => {
    const output = makeOutput({ "Tool F1": [0.5] });
    const thresholds: ThresholdConfig = { "Tool F1": 0.5 };
    const { passed, details } = checkThresholds(output, thresholds);
    expect(passed).toBe(true);
    expect(details[0].passed).toBe(true);
  });
});
