import type { TraceTurnStepRow } from "@/lib/ledger/schema";
import { formatDuration } from "@/lib/readings/trace-signals/claims";
import { typedStepName } from "@/lib/views/tasks/session-bands";

export {
  type BandSegment,
  type SegmentBand,
  type StepPosition,
  segmentBands,
} from "@/lib/views/tasks/session-bands";

/**
 * One session turn by turn, as the session page draws it (Tool craft's
 * drill-down, now reached from a task's example runs): each turn a row, its
 * searches and calls in the order they happened. Pure.
 */

/** The step kinds the typed-steps reading adds to a session. */
export type TypedSessionStepKind = "model_call" | "code" | "handoff" | "user_message";

export interface SessionStep {
  key: number;
  kind: "search" | "call" | TypedSessionStepKind;
  /** The called tool's id (`skill:<id>` for a skill); null for a search. */
  toolId: string | null;
  label: string;
  /** What a pointer rest shows: the duration and the outcome. Tool names and counts only. */
  title: string;
  failed: boolean;
}

const TYPED_KINDS: ReadonlySet<string> = new Set<TypedSessionStepKind>([
  "model_call",
  "code",
  "handoff",
  "user_message",
]);

/** One step of a turn as the timeline draws it. With typed steps, model calls, code, handoffs and user messages read by kind. */
export function sessionStep(
  step: Pick<
    TraceTurnStepRow,
    "ordinal" | "kind" | "targetId" | "targetType" | "outcome" | "tookMs" | "hitCount"
  >,
  names: Record<string, string>,
  options: { typedSteps?: boolean } = {},
): SessionStep {
  if (options.typedSteps && TYPED_KINDS.has(step.kind)) return typedStep(step);
  const isCall = step.kind === "invoke" && step.targetId !== null;
  if (!isCall) {
    const listed =
      step.hitCount !== null ? `${step.hitCount.toLocaleString("en-US")} listed` : null;
    return {
      key: step.ordinal,
      kind: "search",
      toolId: null,
      label: "Search",
      title: listed ? `Search, ${listed}` : "Search",
      failed: false,
    };
  }
  const id = step.targetType === "skill" ? `skill:${step.targetId}` : step.targetId!;
  const label = names[id] ?? id;
  const failed = step.outcome === "error";
  const took = step.tookMs !== null ? `, ${formatDuration(step.tookMs)}` : "";
  return {
    key: step.ordinal,
    kind: "call",
    toolId: id,
    label,
    title: `${label}${took}${failed ? ", failed" : ""}`,
    failed,
  };
}

/** The tools to mark, from `?tools=a,b` (at most eight). */
export function parseMarkedTools(value: string | string[] | undefined): string[] {
  const first = Array.isArray(value) ? value[0] : value;
  return (first ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0 && tool.length <= 200)
    .slice(0, 8);
}

function typedStep(
  step: Pick<TraceTurnStepRow, "ordinal" | "kind" | "targetId" | "outcome" | "tookMs">,
): SessionStep {
  const kind = step.kind as TypedSessionStepKind;
  const label = typedStepName(kind, step.targetId);
  const failed = step.outcome === "error";
  const took = step.tookMs !== null ? `, ${formatDuration(step.tookMs)}` : "";
  return {
    key: step.ordinal,
    kind,
    toolId: null,
    label,
    title: `${label}${took}${failed ? ", failed" : ""}`,
    failed,
  };
}
