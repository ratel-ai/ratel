/**
 * Batching by backlog for the two jobs that read asks (RC-213): the intent
 * engine and the intent graph fold. Each run pays a fixed cost whatever it
 * reads (the engine loads up to 2,000 clusters and rebuilds its levels; the
 * fold loads, compacts and rewrites the whole graph). On prod (2026-11-03)
 * the two were 71% of all job time, mostly runs over one or two asks. So a
 * run that finds only a few new events waits for more, unless the oldest has
 * waited long enough; the cron safety net queues the next run, so nothing is
 * left behind, only read in fewer, fuller runs.
 */

/** New events below which a run waits: an ask with its tool calls is two to four. */
export const MIN_BATCH_EVENTS = 50;
/** How long the oldest waiting event may wait before a run reads it anyway. */
export const MAX_BATCH_WAIT_MS = 15 * 60_000;

export interface BatchPolicy {
  /** 0 turns batching off: any backlog runs. */
  minBatch: number;
  maxWaitMs: number;
}

export const DEFAULT_BATCH_POLICY: BatchPolicy = {
  minBatch: MIN_BATCH_EVENTS,
  maxWaitMs: MAX_BATCH_WAIT_MS,
};

/**
 * How many events a run should leave for a fuller one, or 0 to run now.
 * `ahead` is what lies past the cursor, read with a limit of `minBatch`.
 */
export function eventsToWaitFor(
  ahead: ReadonlyArray<{ receivedAt: Date }>,
  policy: BatchPolicy,
  nowMs: number,
): number {
  if (policy.minBatch <= 0 || ahead.length === 0 || ahead.length >= policy.minBatch) return 0;
  const oldest = Math.min(...ahead.map((row) => row.receivedAt.getTime()));
  return nowMs - oldest >= policy.maxWaitMs ? 0 : ahead.length;
}
