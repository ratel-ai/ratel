import { TURN_NOUN } from "@/lib/synthesis/traces/v2/run-noun";

/** What a Traces list holds, for its empty states. */
export type TracesEmptyUnit = "runs" | "spans" | "logs";

/** The plural an empty Traces list names ("turns", "spans", "logs"). */
export function emptyNoun(unit: TracesEmptyUnit): string {
  return unit === "runs" ? TURN_NOUN.lowerMany : unit;
}
