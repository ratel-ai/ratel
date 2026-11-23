import type { HallucinationGroup } from "@/lib/readings/trace-signals/hallucinations/kinds";

/** The one sentence under the page title, shared by the page and its skeleton. */
export const HALLUCINATIONS_DESCRIPTION =
  "What your agent made up: tools that don't exist, inputs that don't, and work it said was done.";

/** Each group's color, the same in the ring and the table: categorical slots, in a fixed order. */
export const GROUP_COLOR: Record<HallucinationGroup, string> = {
  tool: "bg-chart-1",
  input: "bg-chart-3",
  completion: "bg-chart-5",
};

/** The same colors as an SVG stroke, for the ring's slices. */
export const GROUP_STROKE: Record<HallucinationGroup, string> = {
  tool: "stroke-chart-1",
  input: "stroke-chart-3",
  completion: "stroke-chart-5",
};

/** Each group in one word, for the middle of the ring. */
export const GROUP_SHORT: Record<HallucinationGroup, string> = {
  tool: "Tool",
  input: "Input",
  completion: "Completion",
};
