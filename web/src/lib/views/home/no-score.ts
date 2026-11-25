import type { NoScoreReason } from "@/lib/views/home/focused-load";

/** There is no score because data is missing, and nothing is being worked out. */
export const DATA_IS_MISSING: ReadonlySet<NoScoreReason> = new Set([
  "no_turns",
  "too_few",
  "no_tool_calls",
]);
