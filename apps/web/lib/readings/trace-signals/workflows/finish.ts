import type { PlacedAsks } from "@/lib/readings/trace-signals/workflows/decide";

/**
 * A task's finish rate, the one definition the task pages and the Summary
 * share: the runs that ended without a failed call (the task's reading,
 * `reading.ts`; its health on runs stored before it), of every run that asked
 * for the task. The runs a request was judged to ask for but that called no
 * tool (`decide.ts`, `PlacedAsks`) never ran a step, so they count as
 * unfinished. Pure.
 */

export interface TaskFinish {
  finished: number;
  /** Runs placed in the task, plus the runs that asked for it and called no tool. */
  of: number;
  askedNoTool: number;
  /** Null without a run. */
  rate: number | null;
}

export function taskFinish(
  item: {
    health: { completedRuns: number; failedRuns: number };
    reading?: { runs: number; finishedRuns: number };
  },
  placed: Pick<PlacedAsks, "outside" | "outsideWithErrors"> | null | undefined,
): TaskFinish {
  // Without a reading, the health's own runs: the ones its completion is of.
  const runs = item.reading?.runs ?? item.health.completedRuns + item.health.failedRuns;
  const finished = item.reading?.finishedRuns ?? item.health.completedRuns;
  const outside = typeof placed?.outside === "number" ? placed.outside : 0;
  const withErrors = typeof placed?.outsideWithErrors === "number" ? placed.outsideWithErrors : 0;
  const askedNoTool = Math.max(0, outside - withErrors);
  const of = runs + askedNoTool;
  return { finished, of, askedNoTool, rate: of > 0 ? finished / of : null };
}
