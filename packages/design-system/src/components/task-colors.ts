/**
 * One color per task, the same on every page: the three busiest tasks wear chart-1 (blue),
 * chart-5 (magenta) and chart-4 (yellow), in that order; every other task is neutral. That
 * three-color subset passed an all-pairs color-blind check against the canvas (DESIGN.md, Data
 * visualization), so any two of them can sit side by side. Never a fourth hue: a fourth task is
 * gray.
 *
 * Text never wears these (DESIGN.md: text wears text tokens); a colored mark next to the task's
 * name carries the identity.
 */

export const TASK_COLOR_SLOTS = ["chart-1", "chart-5", "chart-4"] as const;
export type TaskColorSlot = (typeof TASK_COLOR_SLOTS)[number];

/** Tailwind classes per slot, spelled out so the compiler sees them. */
export const TASK_COLOR_CLASSES: Record<
  TaskColorSlot | "neutral",
  { fill: string; stroke: string; bg: string; bgSubtle: string }
> = {
  "chart-1": {
    fill: "fill-chart-1",
    stroke: "stroke-chart-1",
    bg: "bg-chart-1",
    bgSubtle: "bg-chart-1/15",
  },
  "chart-5": {
    fill: "fill-chart-5",
    stroke: "stroke-chart-5",
    bg: "bg-chart-5",
    bgSubtle: "bg-chart-5/15",
  },
  "chart-4": {
    fill: "fill-chart-4",
    stroke: "stroke-chart-4",
    bg: "bg-chart-4",
    bgSubtle: "bg-chart-4/15",
  },
  neutral: {
    fill: "fill-fg-subtle",
    stroke: "stroke-fg-subtle",
    bg: "bg-fg-subtle",
    bgSubtle: "bg-fg/5",
  },
};

/** The color slot of each of the busiest tasks, busiest first; ties go to the smaller id so the answer is stable. */
export function taskColors(
  tasks: ReadonlyArray<{ id: string; runs: number }>,
): Map<string, TaskColorSlot> {
  const ranked = [...tasks].sort(
    (a, b) => b.runs - a.runs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return new Map(
    ranked.slice(0, TASK_COLOR_SLOTS.length).map((task, i) => [task.id, TASK_COLOR_SLOTS[i]!]),
  );
}
