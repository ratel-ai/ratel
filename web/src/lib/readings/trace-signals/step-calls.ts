import type { StepDraft } from "@/lib/ledger/types";
import { nodeIdOf } from "@/lib/readings/tool-explorer/units";

/**
 * A turn's calls as the readings walk them (outcomes, hallucinations): each
 * invoke step with its node id (`nodeIdOf`), and the `trace_events` ids a
 * step's facts are read from. Pure.
 */

export interface StepCall {
  step: StepDraft;
  node: string;
}

/** The turn's calls, in order: searches and other steps left out. */
export function stepCalls(steps: readonly StepDraft[]): StepCall[] {
  return steps.flatMap((step) => {
    const node = nodeIdOf(step);
    return node === null ? [] : [{ step, node }];
  });
}

/** The events a step's facts are on: its start, and its end when it has one. */
export const stepEventIds = (
  step: Pick<StepDraft, "traceEventId" | "endTraceEventId">,
): string[] =>
  step.endTraceEventId ? [step.traceEventId, step.endTraceEventId] : [step.traceEventId];
