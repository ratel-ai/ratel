import type { FunnelCondition, FunnelQuery } from "@/lib/contracts/query";
import type { TraceSample, TraceStep } from "@/lib/synthesis/metrics/steps";

/**
 * The funnel kind. The entity is the trace: it passes a step when it passed the one before and
 * meets the step's condition. Pure: what a trace did and which of its facts hold are read by
 * `views/scorers/funnel`, which owns the check engine and the scorer results.
 */

export interface FunnelTrace {
  /** What it did, in order. */
  steps: readonly TraceStep[];
  /** Per step of the query: whether the condition holds for the trace as a whole. Unread for a tool or a skill. */
  holds: readonly boolean[];
}

export interface FunnelStepResult {
  name: string;
  /** Traces that passed this step and every one before. */
  count: number;
  /** Of the traces of the step before. Null for the first step, and after an empty one. */
  conversion: number | null;
}

export interface FunnelResult {
  kind: "funnel";
  steps: FunnelStepResult[];
  sample: TraceSample;
}

export function funnelSteps(
  traces: readonly FunnelTrace[],
  query: Pick<FunnelQuery, "steps" | "order">,
): FunnelStepResult[] {
  const passed = traces.map((trace) => passedSteps(trace, query));
  const counts = query.steps.map((_, index) => passed.filter((steps) => steps > index).length);
  return query.steps.map(({ name }, index) => {
    const before = counts[index - 1];
    return { name, count: counts[index], conversion: before ? counts[index] / before : null };
  });
}

/**
 * How many steps a trace passed. In order, a tool or a skill must come after the one that met a
 * step before; a fact of the whole trace has no place in it and holds anywhere.
 */
export function passedSteps(
  { steps, holds }: FunnelTrace,
  { steps: wanted, order }: Pick<FunnelQuery, "steps" | "order">,
): number {
  let from = 0;
  for (const [index, { condition }] of wanted.entries()) {
    if (!isUse(condition)) {
      if (!holds[index]) return index;
      continue;
    }
    const at = steps.findIndex(
      ({ kind, name }, place) =>
        place >= from && kind === condition.type && name === condition.name,
    );
    if (at < 0) return index;
    if (order === "in_order") from = at + 1;
  }
  return wanted.length;
}

export function isUse(
  condition: FunnelCondition,
): condition is Extract<FunnelCondition, { type: "tool" | "skill" }> {
  return condition.type === "tool" || condition.type === "skill";
}
