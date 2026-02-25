import "dotenv/config";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { describe, it, expect, afterAll } from "vitest";
import { scenarios } from "./scenarios/index.js";
import { toolRegistry } from "./tools/registry.js";
import { createToolExecutor } from "./tools/executor.js";
import { loadAgent, runScenario } from "./lib/harness.js";
import {
  ToolPrecision,
  ToolRecall,
  ToolF1,
  TaskCorrectness,
  NegativeCorrectness,
  HydrationRecall,
} from "./metrics/index.js";
import type {
  AgentSetupFn,
  BenchmarkOutput,
  BenchmarkRunResult,
  ScenarioResult,
  Scorer,
} from "./lib/types.js";
import { formatSlots } from "./lib/tool-slots.js";
import { computeCost } from "./lib/constants.js";

const agentPath = process.env.AGENT_PATH ?? "./agents/baseline.ts";
const agentName = agentPath.replace(/^.*\//, "").replace(/\.\w+$/, "");
const model = process.env.MODEL ?? "gpt-5";
const scenarioFilter = process.env.SCENARIO;

const scorers: Scorer[] = [
  ToolPrecision,
  ToolRecall,
  ToolF1,
  TaskCorrectness,
  NegativeCorrectness,
  HydrationRecall,
];

const collectedResults: ScenarioResult[] = [];
const resultsDir = process.env.RESULTS_DIR ?? new URL("./results", import.meta.url).pathname;
mkdirSync(resultsDir, { recursive: true });

describe("Context Base Benchmark", async () => {
  const agentModule = await import(agentPath);
  const setup: AgentSetupFn = agentModule.default;

  const toolExecutor = createToolExecutor();
  const harness = await loadAgent(setup, {
    tools: toolRegistry,
    toolExecutor,
  });

  afterAll(() => {
    if (collectedResults.length === 0) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runResult: BenchmarkRunResult = {
      agent: agentName,
      model,
      timestamp: new Date().toISOString(),
      scenarios: collectedResults,
    };

    const jsonPath = `${resultsDir}/${agentName}-${model}-${timestamp}.json`;
    writeFileSync(jsonPath, JSON.stringify(runResult, null, 2));
    console.log(`\nResults written to ${jsonPath}`);
  });

  const filtered = (scenarioFilter
    ? scenarios.filter((s) => String(s.id) === scenarioFilter)
    : scenarios
  ).filter((s) => !s.skip);

  for (const scenario of filtered) {
    it(`#${scenario.id}: ${scenario.query}`, async () => {
      const output: BenchmarkOutput = await runScenario(harness, scenario);

      if (output.response.debug) {
        const d = output.response.debug;
        console.log("\n=== DEBUG ===");
        console.log("System prompt:", d.systemPrompt);
        console.log(`Tools (${d.toolNames.length}):`, d.toolNames.join(", "));
        console.log("Response:", d.modelResponse);
        console.log("Tool calls:", JSON.stringify(d.toolCallsMade, null, 2));
        console.log("=== /DEBUG ===\n");
      }

      const results = await Promise.all(scorers.map((s) => s(output)));
      const f1 = results.find((r) => r.name === "Tool F1");
      const tc = results.find((r) => r.name === "Task Correctness");
      const hr = results.find((r) => r.name === "Hydration Recall");

      // Log results
      const toolsCalled = [
        ...new Set(output.response.toolCalls.map((tc) => tc.toolName)),
      ];
      const { inputTokens, outputTokens, cachedInputTokens, outputReasoningTokens } = output.response.usage;
      const cost = computeCost(inputTokens, cachedInputTokens ?? 0, outputTokens, model);
      console.log(
        `  [${scenario.type}] Tools: ${toolsCalled.join(", ") || "(none)"} | Expected: ${formatSlots(scenario.expectedTools)} | F1: ${f1?.score.toFixed(2)} | TC: ${tc?.score.toFixed(2)} | HR: ${hr?.score.toFixed(2)} | tokens: ${inputTokens}in/${outputTokens}out${cachedInputTokens ? ` cached:${cachedInputTokens}in` : ""}${outputReasoningTokens ? ` reasoning:${outputReasoningTokens}out` : ""} | ${Math.round(output.response.durationMs)}ms | $${cost.toFixed(4)}`,
      );
      if (tc?.reasoning) {
        console.log(`  TC reasoning: ${tc.reasoning}`);
      }

      // Collect structured result
      const scores: Record<string, number> = {};
      for (const r of results) scores[r.name] = r.score;

      const result: ScenarioResult = {
        scenarioId: scenario.id,
        query: scenario.query,
        type: scenario.type,
        category: scenario.category ?? scenario.type,
        expectedTools: scenario.expectedTools,
        toolsCalled,
        response: output.response.content,
        scores,
        tcReasoning: tc?.reasoning,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        outputReasoningTokens,
        durationMs: output.response.durationMs,
        cost,
      };
      collectedResults.push(result);
      appendFileSync(`${resultsDir}/${agentName}.jsonl`, JSON.stringify(result) + "\n");

      // Assertions
      if (scenario.type === "negative") {
        const neg = results.find((r) => r.name === "Negative Correctness");
        expect(neg?.score, "Should call no tools for out-of-scope queries").toBe(1);
      }
    }, 300_000);
  }
});
