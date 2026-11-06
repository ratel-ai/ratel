/**
 * Why a signal run was asked for. The vocabulary lives in the ledger because a queued
 * build may carry a reading request (`BuildJobRequest.reading`) that the run above it
 * (L4, `compute_trace_signals`) honours once the build has caught up. `data_fixed`:
 * enough fixed data (turn ids, tool calls, users' messages) arrived after a reading that
 * lacked it.
 */
export const RUN_TRIGGERS = ["scheduled", "manual", "first_build", "data_fixed"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export function isRunTrigger(value: unknown): value is RunTrigger {
  return typeof value === "string" && (RUN_TRIGGERS as readonly string[]).includes(value);
}
