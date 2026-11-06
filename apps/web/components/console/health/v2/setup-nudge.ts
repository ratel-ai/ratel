import type { CaptureLevel, CaptureUnlock, SourceMode } from "@/lib/readings/trace-signals/view";

/**
 * The older capture nudge, for readings stored before setup facts: what
 * content capture (or the OpenTelemetry options) would add. Pure, so the
 * server decides whether the page's one Callout holds it.
 */

export interface CaptureNudgeInput {
  unlocks: readonly CaptureUnlock[];
  captureLevel: CaptureLevel;
  mode: SourceMode;
}

/** "Turn on content capture to see 4 more kinds of issues", or the OpenTelemetry options still off. */
export function nudgeTitle(nudge: CaptureNudgeInput): string {
  const count = nudge.unlocks.length;
  if (nudge.mode === "otel")
    return `Turn on ${count} more OpenTelemetry ${count === 1 ? "option" : "options"} to see more`;
  return `Turn on content capture to see ${count} more ${count === 1 ? "kind" : "kinds"} of issues`;
}

/** Whether the nudge has anything to say: OpenTelemetry options still off, or content not captured. */
export function nudgeShown(nudge: CaptureNudgeInput | null): nudge is CaptureNudgeInput {
  if (!nudge || nudge.unlocks.length === 0) return false;
  return nudge.mode === "otel" || nudge.captureLevel !== "content";
}
