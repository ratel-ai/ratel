import type { StepKind } from "@/lib/synthesis/traces/v2/span-kind";

/**
 * One color per step kind, in the categorical palette's fixed order (DESIGN.md,
 * Data visualization): the color follows the kind everywhere it appears, the
 * run Panel's dots and the timeline's bars alike. Failure is a status, so it
 * wears danger instead, with a word beside it.
 */
export const KIND_DOT: Readonly<Record<StepKind, string>> = {
  model: "bg-chart-1",
  tool: "bg-chart-2",
  search: "bg-chart-3",
  agent: "bg-chart-4",
  step: "bg-fg-faint",
};

export const KIND_ORDER: readonly StepKind[] = ["model", "tool", "search", "agent", "step"];
