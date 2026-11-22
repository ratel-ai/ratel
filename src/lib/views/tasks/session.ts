import type { TraceTurnStepRow } from "@/lib/ledger/schema";
import { formatDuration } from "@/lib/readings/trace-signals/claims";

/**
 * One session turn by turn, as the session page draws it (Tool craft's
 * drill-down, now reached from a task's example runs): each turn a row, its
 * searches and calls in the order they happened. Pure.
 */

export interface SessionStep {
  key: number;
  kind: "search" | "call";
  /** The called tool's id (`skill:<id>` for a skill); null for a search. */
  toolId: string | null;
  label: string;
  /** What a pointer rest shows: the duration and the outcome. Tool names and counts only. */
  title: string;
  failed: boolean;
}

/** One step of a turn as the timeline draws it. */
export function sessionStep(
  step: Pick<
    TraceTurnStepRow,
    "ordinal" | "kind" | "targetId" | "targetType" | "outcome" | "tookMs" | "hitCount"
  >,
  names: Record<string, string>,
): SessionStep {
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
