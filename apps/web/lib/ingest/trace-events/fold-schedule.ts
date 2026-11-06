/**
 * Kicking the Cloud-built intent graph, and the intent engine that reads the
 * same asks, from an ingest route. Both lanes end here: the runtime-events
 * route after a batch with a learning event, the OTLP traces route after an
 * export that left an ask or a tool call. The deps are optional so a route
 * (or a test) that does not wire them changes nothing; each kick fails on its
 * own, logged and reported, never a reason to fail the ingest that already
 * stored the events, and the two share at most one drain. The cron drain's
 * safety nets pick up anything missed here.
 */

import { FOLD_EVENT_TYPES, isOtlpLaneRow } from "@/lib/ingest/trace-events/event-types";
import type { scheduleProjectDrain as scheduleProjectDrainFn } from "@/lib/jobs/route-helpers";
import { getLogger, type LogError } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";

/**
 * A batch that lands within this long of a finished fold (or engine run) does
 * not start another, and the cron safety nets wait the same: each run pays a
 * fixed cost (the engine re-reads its clusters, the fold rewrites the graphs),
 * so fewer, fuller runs. Was 60s, with the cron ignoring it: about one run a
 * minute per active project.
 */
export const FOLD_MIN_INTERVAL_MS = 5 * 60_000;

/** The runtime lane's event types that make a batch worth a fold. */
export const FOLD_TRIGGER_TYPES: ReadonlySet<string> = new Set(FOLD_EVENT_TYPES);

/** The OTLP lane's: a model call is only worth it with the ask it carries. */
export function isOtlpFoldTrigger(event: {
  type: string;
  ingestSource?: string;
  payload?: Record<string, unknown>;
}): boolean {
  if (!isOtlpLaneRow(event)) return false;
  return event.type !== "otlp_model_call" || typeof event.payload?.prompt === "string";
}

/** The intent-graph fold and intent-engine enqueues, injected once those modules land. */
type PacedEnqueue = (
  projectId: string,
  payload: undefined,
  options: { minIntervalMs: number },
) => Promise<{ id: string } | null>;

export interface IntentGraphFoldScheduleDeps {
  enqueueFoldIntentGraphJob?: PacedEnqueue;
  /** The intent engine's run, paced like the fold's; absent, none is queued from ingest. */
  enqueueClusterIntentsJob?: PacedEnqueue;
  scheduleProjectDrain?: typeof scheduleProjectDrainFn;
  logError?: LogError;
  reportServerException?: typeof reportServerException;
}

const logger = getLogger("intent-graph/schedule");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ err: error, ...fields }, message);

export async function scheduleIntentGraphFold(
  deps: IntentGraphFoldScheduleDeps,
  projectId: string,
  endpoint: string,
): Promise<void> {
  if (!deps.scheduleProjectDrain) return;
  const fold = deps.enqueueFoldIntentGraphJob;
  const engine = deps.enqueueClusterIntentsJob;
  // Side by side: the ingest response waits for one round of reads, not two. Neither throws.
  const [folded, clustered] = await Promise.all([
    fold
      ? kick(
          deps,
          projectId,
          endpoint,
          "intent graph fold enqueue failed",
          "intent_graph_fold_enqueue",
          () => fold(projectId, undefined, { minIntervalMs: FOLD_MIN_INTERVAL_MS }),
        )
      : false,
    engine
      ? kick(
          deps,
          projectId,
          endpoint,
          "intent engine enqueue failed",
          "intent_engine_enqueue",
          () => engine(projectId, undefined, { minIntervalMs: FOLD_MIN_INTERVAL_MS }),
        )
      : false,
  ]);
  if (!folded && !clustered) return;
  try {
    deps.scheduleProjectDrain(projectId);
  } catch (error) {
    (deps.logError ?? defaultLogError)("ingest drain schedule failed", error, {
      project_id: projectId,
    });
    (deps.reportServerException ?? reportServerException)(error, `project:${projectId}`, {
      endpoint,
      operation: "ingest_drain_schedule",
    });
  }
}

/** One paced enqueue: whether it queued a job. A failure is logged and reported, never thrown. */
async function kick(
  deps: IntentGraphFoldScheduleDeps,
  projectId: string,
  endpoint: string,
  message: string,
  operation: string,
  enqueue: () => Promise<{ id: string } | null>,
): Promise<boolean> {
  try {
    return (await enqueue()) !== null;
  } catch (error) {
    (deps.logError ?? defaultLogError)(message, error, { project_id: projectId });
    (deps.reportServerException ?? reportServerException)(error, `project:${projectId}`, {
      endpoint,
      operation,
    });
    return false;
  }
}
