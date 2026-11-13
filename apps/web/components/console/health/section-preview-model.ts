import type { SetupKey } from "@/lib/readings/trace-signals/setup-facts";

/**
 * What a section shows when the data it needs is not there: its usual layout
 * with example rows, dimmed, under one line of what is missing and a button
 * that opens the setup guide for it. Pure copy, so the section only lays it out.
 * No em dashes.
 */

export type PreviewReason = "no_tool_calls" | "mixed_runs" | "no_asks";

export interface PreviewCopy {
  title: string;
  body: string;
  /** The setup card pill whose guide the button opens. */
  setupKey: SetupKey;
  action: string;
}

export function previewCopy(reason: PreviewReason, lane: "sdk" | "otel"): PreviewCopy {
  switch (reason) {
    case "no_tool_calls":
      return {
        title: "No tool calls recorded",
        body: "Run shapes, tasks and the tool map all start from the tools your agent calls. Send tool calls to see yours here.",
        setupKey: lane === "otel" ? "otel_tool_spans" : "sdk_tool_calls",
        action: "How to send tool calls",
      };
    case "mixed_runs":
      return {
        title: "Runs are mixed together",
        body: "Without turn ids, calls from different users land in one run, so run shapes, tasks and the tool map would be guesses. Send turn ids and they are read from the fixed runs.",
        setupKey: "sdk_turn_ids",
        action: "How to send turn ids",
      };
    case "no_asks":
      return {
        title: "No asks captured",
        body: "Send what people ask to see the asks no task or tool handles.",
        setupKey: lane === "otel" ? "otel_content" : "sdk_user_messages",
        action: "How to send them",
      };
  }
}

/** "Read from runs since Oct 3, when turn ids started. 412 earlier runs left out." */
export function readingSinceText(since: string, excludedRuns: number, locale = "en-US"): string {
  const day = new Date(since).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const left =
    excludedRuns > 0
      ? ` ${excludedRuns.toLocaleString(locale)} earlier ${excludedRuns === 1 ? "run" : "runs"} left out.`
      : "";
  return `Read from runs since ${day}, when turn ids started.${left}`;
}

/** The line under workflows when requests were read from the agent's searches. */
export const SEARCH_ASKS_TEXT =
  "Requests are read from the agent's searches. Send users' messages for the real wording.";
