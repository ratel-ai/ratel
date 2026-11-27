import type { PersistOutcome } from "./persist";
import type { ClaimedIngestBatch, ClaimOptions } from "./queries";

/**
 * The ingest queue's drain (RTL-314): claim a batch fairly, persist it, record the outcome, until
 * the queue is empty, the batch cap or the deadline. The store and the persist step are injected,
 * so the loop is tested without a database.
 */
/** `attempt` is the claim's token: only the try that holds the claim records its outcome. */
export interface IngestQueueStore {
  claim(options: ClaimOptions): Promise<ClaimedIngestBatch | null>;
  done(id: string, attempt: number, result: unknown): Promise<void>;
  fail(id: string, attempt: number, error: string): Promise<void>;
  retry(
    id: string,
    attempt: number,
    error: string,
    options: { maxAttempts: number; backoffMs: number },
  ): Promise<"queued" | "failed" | "lost">;
}

type LogFn = (fields: Record<string, unknown>, msg: string) => void;
export interface DrainLog {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

export interface DrainIngestOptions {
  perProject: number;
  maxAttempts: number;
  /** Batches one drain persists at most. */
  max?: number;
  /** No new claim after this instant (on `now`'s clock). */
  deadline?: number;
  now?: () => number;
  log: DrainLog;
}

export interface DrainIngestSummary {
  done: number;
  failed: number;
  retried: number;
}

/** The longest a drain keeps the projects it served, to send them to the back. */
const SERVED_MEMORY = 50;
export const DEFAULT_DRAIN_MAX = 100;

/** 5 s after the first failed try, doubling, never more than 5 minutes. */
export function retryBackoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt - 1), 300_000);
}

export async function drainIngestBatches(
  store: IngestQueueStore,
  persist: (batch: ClaimedIngestBatch) => Promise<PersistOutcome>,
  options: DrainIngestOptions,
): Promise<DrainIngestSummary> {
  const now = options.now ?? Date.now;
  const max = options.max ?? DEFAULT_DRAIN_MAX;
  const summary: DrainIngestSummary = { done: 0, failed: 0, retried: 0 };
  // Round robin across projects: the claim takes a project not served yet, else the one served
  // longest ago (the front of `served`).
  const served: string[] = [];
  for (let i = 0; i < max; i++) {
    if (options.deadline !== undefined && now() >= options.deadline) break;
    const batch = await store.claim({ perProject: options.perProject, avoidProjects: served });
    if (!batch) break;
    const at = served.indexOf(batch.projectId);
    if (at >= 0) served.splice(at, 1);
    served.push(batch.projectId);
    if (served.length > SERVED_MEMORY) served.shift();

    const startedAt = now();
    let outcome: PersistOutcome;
    try {
      outcome = await persist(batch);
    } catch (error) {
      outcome = { kind: "retry", error: error instanceof Error ? error.message : String(error) };
    }
    const fields = {
      project_id: batch.projectId,
      batch_id: batch.id,
      signal: batch.signal,
      attempt: batch.attempts,
      wait_ms: Math.max(0, startedAt - batch.receivedAt.getTime()),
      duration_ms: Math.max(0, now() - startedAt),
    };
    await record(store, batch, outcome, fields, options, summary);
  }
  return summary;
}

async function record(
  store: IngestQueueStore,
  batch: ClaimedIngestBatch,
  outcome: PersistOutcome,
  timing: {
    project_id: string;
    batch_id: string;
    signal: string;
    attempt: number;
    wait_ms: number;
    duration_ms: number;
  },
  options: DrainIngestOptions,
  summary: DrainIngestSummary,
): Promise<void> {
  const { wait_ms, duration_ms, ...ids } = timing;
  if (outcome.kind === "done") {
    await store.done(batch.id, batch.attempts, outcome.result);
    summary.done++;
    options.log.info(
      { ...ids, outcome: "done", wait_ms, duration_ms, ...outcome.result },
      "ingest_batch_persisted",
    );
    return;
  }
  if (outcome.kind === "failed") {
    await store.fail(batch.id, batch.attempts, outcome.error);
    summary.failed++;
    options.log.error(
      { ...ids, outcome: "failed", wait_ms, duration_ms, error: outcome.error },
      "ingest_batch_failed",
    );
    return;
  }
  const status = await store.retry(batch.id, batch.attempts, outcome.error, {
    maxAttempts: options.maxAttempts,
    backoffMs: retryBackoffMs(batch.attempts),
  });
  if (status === "lost") {
    // The reaper took this try back (it ran past the stale window): the batch runs again.
    options.log.warn(
      { ...ids, outcome: "lost", wait_ms, duration_ms, error: outcome.error },
      "ingest_batch_retry",
    );
    return;
  }
  if (status === "failed") {
    summary.failed++;
    options.log.error(
      { ...ids, outcome: "failed", wait_ms, duration_ms, error: outcome.error },
      "ingest_batch_failed",
    );
  } else {
    summary.retried++;
    options.log.warn(
      { ...ids, outcome: "retry", wait_ms, duration_ms, error: outcome.error },
      "ingest_batch_retry",
    );
  }
}

export interface DrainGate {
  /** Start a drain, or, with every slot busy, ask a running one to go again. */
  kick(): Promise<void> | undefined;
}

/**
 * At most `concurrency()` drains at once in this process. A kick turned away is remembered: a
 * running drain goes again when it finishes, so a batch queued while every drain was finishing is
 * never left for the next tick.
 */
export function createDrainGate(
  concurrency: () => number,
  run: () => Promise<unknown>,
  onError: (error: unknown) => void,
): DrainGate {
  let active = 0;
  let pending = false;
  const loop = async () => {
    active++;
    try {
      do {
        pending = false;
        try {
          await run();
        } catch (error) {
          onError(error);
        }
      } while (pending);
    } finally {
      active--;
    }
  };
  return {
    kick: () => {
      if (active >= concurrency()) {
        pending = true;
        return undefined;
      }
      return loop();
    },
  };
}
