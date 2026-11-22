/**
 * Task segments over a session's drawn steps, and the plain name of a typed
 * step. No imports: the session chat model also runs in the MCP replay view's
 * browser bundle.
 */

/** A stored task segment, as a band reads it: its task and its first and last step. */
export interface BandSegment {
  id: string;
  workflowId: string;
  startTurnId: string;
  startOrdinal: number;
  endTurnId: string;
  endOrdinal: number;
}

/** Where a drawn step sits: its turn, and its stored ordinal (null for a step with no ledger row, such as a joined model call). */
export interface StepPosition {
  turnId: string;
  ordinal: number | null;
}

/** One task segment over a session's drawn steps: the first and last step it covers, as indexes into the steps. */
export interface SegmentBand {
  segmentId: string;
  workflowId: string;
  first: number;
  last: number;
}

/**
 * The bands a session's task segments draw over its steps, in step order. A
 * segment covers the stored steps from its first (turn, ordinal) to its last,
 * across turns, every step drawn between them (a joined model call) and the
 * joined steps right after its last one in the same turn (the answer). The
 * turn order is the order the steps list the turns in. A segment with no step
 * left in the list draws no band.
 */
export function segmentBands(
  steps: readonly StepPosition[],
  segments: readonly BandSegment[],
): SegmentBand[] {
  const turnRank = new Map<string, number>();
  for (const step of steps)
    if (!turnRank.has(step.turnId)) turnRank.set(step.turnId, turnRank.size);
  const out: SegmentBand[] = [];
  for (const segment of segments) {
    const start = turnRank.get(segment.startTurnId);
    const end = turnRank.get(segment.endTurnId);
    let first = -1;
    let last = -1;
    steps.forEach((step, index) => {
      if (step.ordinal === null) return;
      const rank = turnRank.get(step.turnId)!;
      const afterStart =
        start === undefined
          ? false
          : rank > start || (rank === start && step.ordinal >= segment.startOrdinal);
      const beforeEnd =
        end === undefined
          ? false
          : rank < end || (rank === end && step.ordinal <= segment.endOrdinal);
      if (!afterStart || !beforeEnd) return;
      if (first < 0) first = index;
      last = index;
    });
    if (first < 0) continue;
    // A joined step right after the last one (the model's answer) closes the same task.
    while (
      last + 1 < steps.length &&
      steps[last + 1]!.ordinal === null &&
      steps[last + 1]!.turnId === steps[last]!.turnId
    )
      last += 1;
    out.push({ segmentId: segment.id, workflowId: segment.workflowId, first, last });
  }
  return out.sort((a, b) => a.first - b.first || a.last - b.last);
}

/** A typed step's name with engine names kept out: "User message", "Model call", "Load cart", "Handoff to billing agent". */
export function typedStepName(
  kind: "user_message" | "model_call" | "code" | "handoff",
  name: string | null,
): string {
  if (kind === "user_message") return "User message";
  if (kind === "model_call") return "Model call";
  const words = (name ?? kind).replace(/[_.]+/g, " ");
  return kind === "handoff"
    ? `Handoff to ${words}`
    : words.charAt(0).toUpperCase() + words.slice(1);
}
