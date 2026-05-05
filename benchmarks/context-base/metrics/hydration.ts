import type { BenchmarkOutput } from "../lib/types.js";
import type { Scorer, ScorerResult } from "./scorers.js";
import { slotRecall } from "../lib/tool-slots.js";

export function computeHydrationRecall(output: BenchmarkOutput): number {
  const { hydratedTools } = output.response;
  if (!hydratedTools) return 1;
  return slotRecall(hydratedTools, output.scenario.expectedTools);
}

export const HydrationRecall: Scorer = (output): ScorerResult => ({
  name: "Hydration Recall",
  score: computeHydrationRecall(output),
});
