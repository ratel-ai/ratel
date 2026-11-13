import type { SourceMode } from "@/lib/readings/trace-signals/view";

/**
 * The words of "What your agent calls first": its two views in plain words,
 * the one line each keeps on hover, and the lane a reading came from with
 * what that lane can draw. Pure, shared by the server section and its
 * client drawing.
 */

export type CallOrderView = "needs" | "all";

/** The two views, in plain words. */
export const VIEW_LABELS: Readonly<Record<CallOrderView, string>> = {
  needs: "What comes before",
  all: "Every call",
};

/** The hover on "What comes before": the one line that says what the view keeps. */
export function beforeHint(windowMinutes: number | null): string {
  const within =
    windowMinutes === null
      ? ""
      : ` within ${windowMinutes} ${windowMinutes === 1 ? "minute" : "minutes"}`;
  return `Each tool that almost always follows another${within}, with the tool it follows.`;
}

/** The hover on "Every call". */
export const EVERY_CALL_HINT = "Every turn, call by call, left to right.";

/** The lane a reading came from, as the badge names it. */
export const LANE_LABEL: Readonly<Record<SourceMode, string>> = {
  otel: "OpenTelemetry",
  sdk: "Ratel SDK",
  mixed: "OpenTelemetry and Ratel SDK",
};

/** What each lane can draw, in one line on the badge's hover. */
export const LANE_HINT: Readonly<Record<SourceMode, string>> = {
  otel: "Read from OpenTelemetry tool spans. Searches arrive only through the Ratel SDK, so no tool is marked for its searches here.",
  sdk: "Read from the Ratel SDK's events: each search and tool call, in order.",
  mixed:
    "Read from OpenTelemetry tool spans and the Ratel SDK's events. Search marks come from the SDK's runs.",
};

/** A share of turns as the chains say it: "10%", "<1%". */
export function chainShareText(share: number): string {
  const percent = share * 100;
  return `${percent < 1 ? "<1" : Math.round(percent)}%`;
}
