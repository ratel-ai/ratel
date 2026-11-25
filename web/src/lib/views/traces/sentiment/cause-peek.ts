import type { DissatisfactionProblem } from "@/lib/views/traces/sentiment/overview";

/** The URL parameter that holds the open cause of dissatisfaction. */
export const CAUSE_PEEK = "open";
/** The open id of the unsatisfied turns no cause was named for. */
export const NO_CAUSE_ID = "no-cause";

type Problem = Pick<DissatisfactionProblem, "cause">;

export const problemPeekId = (problem: Problem): string => problem.cause ?? NO_CAUSE_ID;

/** The problem an address opens; null when the window's dissatisfaction holds none by that id. */
export function openProblem<T extends Problem>(
  problems: readonly T[],
  id: string | null,
): T | null {
  return id === null ? null : (problems.find((problem) => problemPeekId(problem) === id) ?? null);
}
