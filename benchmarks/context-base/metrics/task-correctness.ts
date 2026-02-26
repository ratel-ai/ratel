import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import type { BenchmarkOutput } from "../lib/types.js";
import type { Scorer, ScorerResult } from "./scorers.js";
import { computeActionCorrectness } from "./correctness.js";
import { toolMatchesSlot, formatSlots, type ToolSlot } from "../lib/tool-slots.js";

const JUDGE_MODEL = "gemini-3-flash-preview";

const judgeSchema = z.object({
  score: z.number().min(0).max(1),
  reasoning: z.string(),
});

function buildPrompt(output: BenchmarkOutput): string {
  const { scenario, response } = output;
  const toolsCalled = response.toolCalls.map((tc) => tc.toolName).join(", ") || "(none)";
  const toolArgs = response.toolCalls
    .map((tc) => `${tc.toolName}(${JSON.stringify(tc.args)})`)
    .join("\n  ") || "(none)";

  const isBehavioral = scenario.type === "negative" || scenario.type === "ambiguous";

  if (isBehavioral) {
    return buildBehavioralPrompt(scenario, toolsCalled, toolArgs, response.content);
  }
  return buildResponsePrompt(output, toolArgs);
}

function buildBehavioralPrompt(
  scenario: BenchmarkOutput["scenario"],
  toolsCalled: string,
  toolArgs: string,
  content: string,
): string {
  const criteria = scenario.type === "negative"
    ? `- 1.0 if no tools are called\n  - 0.0 if it called some tools for some reason`
    : `- 1.0 if it asked for clarification appropriately\n  - 0.5 if it answered from his knowledge, without asking for clarification, but did not use any tools\n  - 0.0 if it used any tools`;

  return `You are evaluating an AI agent's response to a user query.
Score from 0.0 to 1.0 where 1.0 = fully correct, 0.0 = wrong/failed.

User query: ${scenario.query}
Type: ${scenario.type}
Tools called: ${toolsCalled}
Tool calls with args:
  ${toolArgs}
Agent response: ${content}

Evaluation criteria:
  ${criteria}

Return a score and brief reasoning.`;
}

function buildResponsePrompt(output: BenchmarkOutput, toolArgs: string): string {
  const { scenario, response } = output;
  const called = new Set(response.toolCalls.map((tc) => tc.toolName));
  const { coveragePct, missing } = computeCoverage(called, scenario.expectedTools);

  let coverageLine = `Tool coverage: ${coveragePct}% of expected tools called.`;
  if (missing.length > 0) {
    coverageLine += ` Missing: ${missing.join(", ")}`;
  }

  const outcomeBlock = scenario.expectedOutcome
    ? `\n<expected-outcome>${scenario.expectedOutcome}</expected-outcome>`
    : "";

  return `You are evaluating an AI agent's response to a user query.
Score from 0.0 to 1.0 where 1.0 = fully correct, 0.5 = partially correct, 0.0 = wrong/failed.

User query: ${scenario.query}
${coverageLine}
Tool calls with args:
  ${toolArgs}
Agent response: ${response.content}
${outcomeBlock}
Evaluation criteria:
- Score ONLY the response correctness based on the expected outcome
- Do NOT evaluate tool usage (scored separately)

Return a score and brief reasoning.`;
}

function computeCoverage(
  called: Set<string>,
  slots: ToolSlot[],
): { coveragePct: number; missing: string[] } {
  if (slots.length === 0) return { coveragePct: 100, missing: [] };

  const missing: string[] = [];
  let satisfied = 0;
  for (const slot of slots) {
    const matched = [...called].some((t) => toolMatchesSlot(t, slot));
    if (matched) {
      satisfied++;
    } else {
      missing.push(formatSlots([slot]));
    }
  }
  return { coveragePct: Math.round((satisfied / slots.length) * 100), missing };
}

function hasDeterministicExpectedParams(output: BenchmarkOutput): boolean {
  const { expectedParams } = output.scenario;
  return !!expectedParams && Object.keys(expectedParams).length > 0;
}

export const TaskCorrectness: Scorer = async (output): Promise<ScorerResult> => {
  if (hasDeterministicExpectedParams(output)) {
    return { name: "Task Correctness", score: computeActionCorrectness(output) };
  }

  try {
    const result = await generateObject({
      model: google(JUDGE_MODEL),
      schema: judgeSchema,
      prompt: buildPrompt(output),
    });
    return { name: "Task Correctness", score: result.object.score, reasoning: result.object.reasoning };
  } catch {
    return { name: "Task Correctness", score: 0, reasoning: "Judge call failed" };
  }
};
