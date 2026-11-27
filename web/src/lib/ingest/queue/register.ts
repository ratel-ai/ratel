import { after } from "next/server";
import type { DrainStep, Registration, WorkerLane } from "@/lib/contracts/registry";
import { persistsIngestAfterResponse } from "@/lib/jobs/role";
import { getLogger } from "@/lib/platform/logger";
import type { IngestQueueAcceptDeps } from "./accept";
import {
  createDrainGate,
  type DrainGate,
  type DrainIngestSummary,
  type DrainLog,
  drainIngestBatches,
  type IngestQueueStore,
} from "./drain";
import { type IngestPersistDeps, persistIngestBatch } from "./persist";
import {
  claimNextIngestBatch,
  enqueueIngestBatch,
  failIngestBatch,
  type IngestQueueProjectStats,
  markIngestBatchDone,
  pruneIngestBatches,
  readIngestQueueStats,
  reapStaleIngestBatches,
  retryIngestBatch,
  STALE_BATCH_MS,
} from "./queries";
import { ingestQueueEnabled, ingestQueueSettings } from "./settings";

/**
 * The ingest queue wired to the database and the process (RTL-314, ADR-0009): the accept deps the
 * routes take, the after-response drain of an all-in-one process, the worker's ingest lane, and the
 * tick's steps (reap, depth, retention, and a drain as the safety net).
 */

const logger = getLogger("ingest/queue");

/** How long the tick's safety-net drain may run, so the tick's other steps are not held up. */
const TICK_DRAIN_BUDGET_MS = 30_000;
/** How long one after-response drain may claim new batches. */
const AFTER_RESPONSE_DRAIN_BUDGET_MS = 20_000;
/** How often a lane reaps, since a persist-only process has no tick. */
const LANE_REAP_EVERY_MS = 60_000;

export const dbIngestQueueStore: IngestQueueStore = {
  claim: (options) => claimNextIngestBatch(undefined, options),
  done: (id, attempt, result) => markIngestBatchDone(id, attempt, result),
  fail: (id, attempt, error) => failIngestBatch(id, attempt, error),
  retry: (id, attempt, error, options) => retryIngestBatch(id, attempt, error, options),
};

export interface IngestQueueRuntimeDeps {
  /** Read lazily: the write path's deps import modules that import the registry. */
  persistDeps: () => IngestPersistDeps;
  store?: IngestQueueStore;
  log?: DrainLog;
  now?: () => number;
}

/** One drain: claim fairly, persist, record, until empty or past `deadline`. */
export function runIngestDrain(
  deps: IngestQueueRuntimeDeps,
  options: { deadline?: number } = {},
): Promise<DrainIngestSummary> {
  const settings = ingestQueueSettings();
  const persist = deps.persistDeps();
  return drainIngestBatches(
    deps.store ?? dbIngestQueueStore,
    (batch) => persistIngestBatch(batch, persist),
    {
      perProject: settings.persistPerProject,
      maxAttempts: settings.maxAttempts,
      log: deps.log ?? logger,
      ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
  );
}

/** Requeue (or fail) batches whose process stopped mid-batch. */
export async function reapIngestBatches(
  reap: typeof reapStaleIngestBatches = reapStaleIngestBatches,
  log: Pick<DrainLog, "warn"> = logger,
): Promise<{ requeued: number; failed: number }> {
  const reaped = await reap(STALE_BATCH_MS, ingestQueueSettings().maxAttempts);
  if (reaped.requeued + reaped.failed > 0) log.warn({ ...reaped }, "ingest_batches_reaped");
  return reaped;
}

/**
 * The queue's depth, per project and in total: one `ingest_queue_depth` line per project with
 * anything queued, running or failed in the last hour, for Cloud's autoscaling and alerts. The
 * totals land on the tick's heartbeat.
 */
export async function reportIngestQueueStats(
  read: () => Promise<IngestQueueProjectStats[]> = () => readIngestQueueStats(),
  log: Pick<DrainLog, "info"> = logger,
): Promise<Record<string, number>> {
  const stats = await read();
  let oldest = 0;
  const totals = { ingest_queued: 0, ingest_running: 0, ingest_failed_1h: 0 };
  for (const project of stats) {
    log.info(
      {
        project_id: project.projectId,
        queued: project.queued,
        running: project.running,
        oldest_age_ms: project.oldestAgeMs,
        failed_1h: project.failedLastHour,
      },
      "ingest_queue_depth",
    );
    totals.ingest_queued += project.queued;
    totals.ingest_running += project.running;
    totals.ingest_failed_1h += project.failedLastHour;
    oldest = Math.max(oldest, project.oldestAgeMs ?? 0);
  }
  return { ...totals, ingest_oldest_age_ms: oldest };
}

/** The tick's steps: reap and report before the job drain; drain (all-in-one only) and prune after. */
export function ingestQueueDrainSteps(deps: IngestQueueRuntimeDeps): DrainStep[] {
  return [
    { name: "ingest_batches_reap", phase: "before", run: () => reapIngestBatches() },
    { name: "ingest_queue_depth", phase: "before", run: () => reportIngestQueueStats() },
    {
      // The safety net of an all-in-one process: batches whose after-response drain never ran
      // (the process restarted). A worker's lane drains continuously instead.
      name: "ingest_batches_drain",
      phase: "after",
      run: async () => {
        if (!persistsIngestAfterResponse()) return { ingest_drained: 0 };
        const summary = await runIngestDrain(deps, { deadline: Date.now() + TICK_DRAIN_BUDGET_MS });
        return { ingest_drained: summary.done, ingest_drain_failed: summary.failed };
      },
    },
    // The queue's own housekeeping, so not gated by DATA_RETENTION_ENABLED.
    {
      name: "ingest_batches_prune",
      phase: "after",
      run: async () => ({ ingest_pruned: await pruneIngestBatches() }),
    },
  ];
}

/**
 * The worker's ingest lane: `persistConcurrency` loops, each a drain at a time. Always on (not
 * only with the flag), so a queue left when the flag goes off still empties. Reaps once a minute,
 * since a persist-only process has no tick.
 */
export function ingestQueueLanes(deps: IngestQueueRuntimeDeps): WorkerLane[] {
  const now = deps.now ?? Date.now;
  let lastReapAt = Number.NEGATIVE_INFINITY;
  return [
    {
      name: "ingest",
      concurrency: ingestQueueSettings().persistConcurrency,
      step: async () => {
        if (now() - lastReapAt >= LANE_REAP_EVERY_MS) {
          lastReapAt = now();
          await reapIngestBatches().catch((error) =>
            logger.error({ err: error }, "ingest batch reaper failed"),
          );
        }
        const summary = await runIngestDrain(deps);
        return { done: summary.done + summary.retried, failed: summary.failed };
      },
    },
  ];
}

const GATE_KEY = Symbol.for("ratel.platform.ingest-drain-gate");

/** This process's gate: at most `persistConcurrency` after-response drains at once. */
function processGate(deps: IngestQueueRuntimeDeps): DrainGate {
  const globals = globalThis as Record<symbol, DrainGate | undefined>;
  globals[GATE_KEY] ??= createDrainGate(
    () => ingestQueueSettings().persistConcurrency,
    // Bounded, so one after-response callback never outlives its request by much; a kick it
    // turned away runs the next drain, and the tick's safety net catches the rest.
    () => runIngestDrain(deps, { deadline: Date.now() + AFTER_RESPONSE_DRAIN_BUDGET_MS }),
    (error) => logger.error({ err: error }, "ingest drain failed"),
  );
  return globals[GATE_KEY];
}

/**
 * The deps the three ingest routes take. An all-in-one process persists after its response; a
 * process with another role only queues (the worker or a persist-only process persists).
 */
export function ingestQueueAcceptDeps(
  deps: IngestQueueRuntimeDeps,
  schedule: (callback: () => Promise<void>) => void = (callback) => after(callback),
): IngestQueueAcceptDeps {
  return {
    enabled: () => ingestQueueEnabled(),
    enqueue: (batch) => enqueueIngestBatch(batch),
    scheduleDrain: () => {
      if (!persistsIngestAfterResponse()) return;
      schedule(async () => {
        await processGate(deps).kick();
      });
    },
  };
}

export function createIngestQueueRegistration(deps: IngestQueueRuntimeDeps): Registration {
  return {
    drainSteps: ingestQueueDrainSteps(deps),
    workerLanes: () => ingestQueueLanes(deps),
  };
}
