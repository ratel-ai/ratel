import type { BenchmarkOutput } from "../lib/types.js";
import { computePrecision, computeRecall, computeF1 } from "./tool-selection.js";
import { computeNegativeCorrectness } from "./correctness.js";

export interface ScorerResult {
  name: string;
  score: number;
  reasoning?: string;
}

export type Scorer = (output: BenchmarkOutput) => ScorerResult | Promise<ScorerResult>;

export const ToolPrecision: Scorer = (output) => ({
  name: "Tool Precision",
  score: computePrecision(output),
});

export const ToolRecall: Scorer = (output) => ({
  name: "Tool Recall",
  score: computeRecall(output),
});

export const ToolF1: Scorer = (output) => ({
  name: "Tool F1",
  score: computeF1(output),
});


export const NegativeCorrectness: Scorer = (output) => ({
  name: "Negative Correctness",
  score: output.scenario.type !== "negative" ? 1 : computeNegativeCorrectness(output),
});
