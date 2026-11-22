/**
 * Why a signal run was asked for. The vocabulary lives in the ledger because a queued
 * build may carry a reading request (`BuildJobRequest.reading`) that the run above it
 * (L4, `compute_trace_signals`) honours once the build has caught up. `data_fixed`:
 * enough fixed data (turn ids, tool calls, users' messages) arrived after a reading that
 * lacked it. `full_reading`: the full-window run that follows a quick first reading (RC-224).
 */
export const RUN_TRIGGERS = [
  "scheduled",
  "manual",
  "first_build",
  "data_fixed",
  "full_reading",
] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export function isRunTrigger(value: unknown): value is RunTrigger {
  return typeof value === "string" && (RUN_TRIGGERS as readonly string[]).includes(value);
}
