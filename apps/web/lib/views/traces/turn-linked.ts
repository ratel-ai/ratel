import { formatDuration } from "@/lib/readings/trace-signals/claims";
import { formatUsd } from "@/lib/views/health/tiles";

/**
 * An SDK run's linked OpenTelemetry model calls as its Traces page shows them
 * (read by `turn-detail-linked.ts`). Pure, so a component can import it.
 */

export interface TurnLinked {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Null when the model has no known price. */
  costUsd: number | null;
  modelMs: number;
  /** The user's ask from the model calls; null when content capture is off. */
  asked: string | null;
  /** The run's first captured search query; null without one. */
  searched: string | null;
}

/** "4 model calls · $0.03 · 6.2 s in the model". */
export function linkedModelText(
  linked: Pick<TurnLinked, "modelCalls" | "costUsd" | "modelMs">,
): string {
  return [
    `${linked.modelCalls} model ${linked.modelCalls === 1 ? "call" : "calls"}`,
    linked.costUsd === null ? null : formatUsd(linked.costUsd),
    `${formatDuration(linked.modelMs)} in the model`,
  ]
    .filter(Boolean)
    .join(" · ");
}
