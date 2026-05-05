import { describe, it, expect } from "vitest";
import type { BenchmarkRunResult, ScenarioResult } from "./types.js";
import { summarizeRun, generateComparisonReport } from "./report.js";

function makeScenario(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    scenarioId: 1,
    query: "Get employee info",
    type: "retrieval",
    category: "retrieval",
    expectedTools: ["getEmployee"],
    toolsCalled: ["getEmployee"],
    scores: { "Tool F1": 1.0, "Tool Precision": 1.0, "Tool Recall": 1.0, "Task Correctness": 0.9, "Negative Correctness": 1.0 },
    inputTokens: 500,
    outputTokens: 100,
    cachedInputTokens: 200,
    durationMs: 1200,
    cost: 0.0014,
    response: "Marco Rossi info...",
    ...overrides,
  };
}

function makeRun(overrides: Partial<BenchmarkRunResult> = {}): BenchmarkRunResult {
  return {
    agent: "baseline",
    model: "gpt-5",
    timestamp: "2026-01-01T00:00:00Z",
    scenarios: [
      makeScenario({ scenarioId: 1, category: "retrieval" }),
      makeScenario({ scenarioId: 2, category: "retrieval", scores: { "Tool F1": 0.5, "Tool Precision": 0.5, "Tool Recall": 0.5, "Task Correctness": 0.6, "Negative Correctness": 1.0 } }),
      makeScenario({ scenarioId: 3, category: "negative", type: "negative", scores: { "Tool F1": 1.0, "Tool Precision": 1.0, "Tool Recall": 1.0, "Task Correctness": 1.0, "Negative Correctness": 1.0 } }),
    ],
    ...overrides,
  };
}

describe("summarizeRun", () => {
  it("computes overall averages across all scenarios", () => {
    const run = makeRun();
    const summary = summarizeRun(run);

    expect(summary.agent).toBe("baseline");
    expect(summary.overall["Tool F1"]).toBeCloseTo(0.833, 2);
    expect(summary.overall["Task Correctness"]).toBeCloseTo(0.833, 2);
  });

  it("computes per-category averages", () => {
    const run = makeRun();
    const summary = summarizeRun(run);

    expect(summary.byCategory["retrieval"]["Tool F1"]).toBeCloseTo(0.75, 2);
    expect(summary.byCategory["negative"]["Tool F1"]).toBe(1.0);
  });

  it("includes token, duration, and cost totals", () => {
    const run = makeRun();
    const summary = summarizeRun(run);

    // 3 scenarios × 500/100/200/1200
    expect(summary.overall.totalInputTokens).toBe(1500);
    expect(summary.overall.totalOutputTokens).toBe(300);
    expect(summary.overall.totalCachedInputTokens).toBe(600);
    expect(summary.overall.totalDurationMs).toBe(3600);
    // Should sum pre-computed scenario.cost (3 × 0.0014 = 0.0042)
    expect(summary.overall.totalCost).toBeCloseTo(0.0042, 6);
  });

  it("sums pre-computed scenario costs instead of recomputing from tokens", () => {
    // Scenario costs are pre-computed at benchmark time with correct model pricing.
    // summarizeRun must sum those, not recompute via hardcoded gpt-5 pricing.
    const run = makeRun({
      model: "gpt-5-mini",
      scenarios: [
        makeScenario({ scenarioId: 1, cost: 0.10 }),
        makeScenario({ scenarioId: 2, cost: 0.20 }),
      ],
    });
    const summary = summarizeRun(run);
    expect(summary.overall.totalCost).toBeCloseTo(0.30, 6);
  });
});

describe("generateComparisonReport", () => {
  it("generates markdown with overall summary table", () => {
    const runs = [makeRun(), makeRun({ agent: "agentified" })];
    const md = generateComparisonReport(runs);

    expect(md).toContain("# Benchmark Comparison");
    expect(md).toContain("baseline (gpt-5)");
    expect(md).toContain("agentified (gpt-5)");
    expect(md).toContain("Tool F1");
    expect(md).toContain("Task Correctness");
    expect(md).toContain("Cached In");
    expect(md).toContain("Cost ($)");
  });

  it("distinguishes same agent with different models in labels", () => {
    const runs = [
      makeRun({ agent: "agentified", model: "gpt-5" }),
      makeRun({ agent: "agentified", model: "gpt-5-mini" }),
    ];
    const md = generateComparisonReport(runs);

    expect(md).toContain("agentified (gpt-5)");
    expect(md).toContain("agentified (gpt-5-mini)");
  });

  it("generates per-category tables with cached input tokens and cost", () => {
    const runs = [makeRun()];
    const md = generateComparisonReport(runs);

    expect(md).toContain("retrieval");
    expect(md).toContain("negative");
    const categorySection = md.split("## By Category")[1]!.split("## Per Scenario")[0]!;
    expect(categorySection).toContain("Cached In");
    expect(categorySection).toContain("Input Tokens");
    expect(categorySection).toContain("Output Tokens");
    expect(categorySection).toContain("Cost ($)");
    // Should NOT have "Avg" prefix
    expect(categorySection).not.toContain("Avg ");
  });

  it("generates per-scenario detail table", () => {
    const runs = [makeRun()];
    const md = generateComparisonReport(runs);

    expect(md).toContain("#1");
    expect(md).toContain("#2");
    expect(md).toContain("#3");
  });

  it("handles single run", () => {
    const runs = [makeRun()];
    const md = generateComparisonReport(runs);

    expect(md).toContain("baseline (gpt-5)");
    expect(md).not.toContain("undefined");
  });

  it("handles scenarios with alternative tool slots", () => {
    const runs = [makeRun({
      scenarios: [
        makeScenario({
          scenarioId: 1,
          expectedTools: [["getEmployee", "searchEmployees"], "getSalary"],
          toolsCalled: ["searchEmployees", "getSalary"],
        }),
      ],
    })];
    const md = generateComparisonReport(runs);
    expect(md).toContain("#1");
  });
});
