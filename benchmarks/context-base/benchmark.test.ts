import { config } from "dotenv";
config(); // load local .env
config({ path: "../../.env" }); // load root .env (API keys)
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { z } from "zod";
import { scenarios } from "./scenarios/index.js";
import { toolRegistry } from "./tools/registry.js";
import {
  spawnAgent,
  sendSetup,
  killAgent,
  createHttpHarness,
  runScenario,
  type AgentProcess,
} from "./lib/harness.js";
import {
  ToolPrecision,
  ToolRecall,
  ToolF1,
  TaskCorrectness,
  NegativeCorrectness,
  HydrationRecall,
} from "./metrics/index.js";
import type {
  BenchmarkOutput,
  BenchmarkRunResult,
  ScenarioResult,
  Scorer,
} from "./lib/types.js";
import type { ToolDef, SetupBody } from "./lib/protocol.js";
import { formatSlots } from "./lib/tool-slots.js";
import { computeCost, MODEL, SYSTEM_PROMPT, MAX_STEPS } from "./lib/constants.js";

const agentCmd = process.env.AGENT_CMD ?? "tsx agents/ts/baseline.ts";
const agentName = agentCmd.replace(/^.*\//, "").replace(/\.\w+$/, "");
const model = process.env.MODEL ?? MODEL;
const scenarioFilter = process.env.SCENARIO;
const agentPort = 9200 + Math.floor(Math.random() * 800);

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

function buildToolDefs(): ToolDef[] {
  const scriptsDir = resolve(import.meta.dirname, "tools", "scripts");
  return Object.entries(toolRegistry).map(([name, t]) => ({
    name,
    description: (t as any).description ?? "",
    parameters: z.toJSONSchema((t as any).inputSchema) as Record<string, unknown>,
    script: resolve(scriptsDir, `${name}.sh`),
  }));
}

describe("Context Base Benchmark", () => {
  let agent: AgentProcess;

  beforeAll(async () => {
    agent = await spawnAgent(agentCmd, agentPort);
    const tools = buildToolDefs();
    const setupBody: SetupBody = {
      tools,
      config: {
        agentifiedEndpoint: process.env.AGENTIFIED_ENDPOINT,
        model,
        systemPrompt: SYSTEM_PROMPT,
        maxSteps: MAX_STEPS,
      },
    };
    await sendSetup(agentPort, setupBody);
  }, 60_000);

  afterAll(async () => {
    if (collectedResults.length > 0) {
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
    }
    await killAgent(agent);
  });

  const harness = createHttpHarness(agentPort);

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

      if (scenario.type === "negative") {
        const neg = results.find((r) => r.name === "Negative Correctness");
        expect(neg?.score, "Should call no tools for out-of-scope queries").toBe(1);
      }
    }, 300_000);
  }
});
