import { composition } from "@/lib/composition/ports";
import type { DrainStep, JobHandler, Registration, WorkerLane } from "@/lib/contracts/registry";
import { geoIngest } from "@/lib/ingest/geo/ingest";
import { loadPriceOverrides } from "@/lib/ingest/model-pricing/store";
import {
  findStoredOtelSpans,
  findTracesWithModelCalls,
  insertEventsWithMetrics,
  insertOtelLogs,
  insertOtelSpans,
} from "@/lib/ingest/otlp/queries";
import { findRuntimeInvokes } from "@/lib/ingest/otlp/runtime-facts-query";
import { createGenAiLogStore } from "@/lib/ingest/otlp/semconv/gen-ai-log-store";
import { createOtlpRawStore } from "@/lib/ingest/otlp-raw/store";
import type { IngestQueueAcceptDeps } from "@/lib/ingest/queue/accept";
import type { IngestPersistDeps } from "@/lib/ingest/queue/persist";
import {
  createIngestQueueRegistration,
  type IngestQueueRuntimeDeps,
  ingestQueueAcceptDeps,
} from "@/lib/ingest/queue/register";
import type { IntentGraphFoldScheduleDeps } from "@/lib/ingest/trace-events/fold-schedule";
import { insertTraceEventRejects, insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { ingestTraceEventsRegistration } from "@/lib/ingest/trace-events/register";
import { runsJobsAfterResponse } from "@/lib/jobs/role";
import { drainProjectJobs } from "@/lib/jobs/store";
import { ledgerRegistration } from "@/lib/ledger/register";
import { enqueueBuildTraceTurnsJob } from "@/lib/ledger/turns/queries";
import { getDb } from "@/lib/platform/db/client";
import { incrementEventUsage } from "@/lib/platform/entitlements";
import { getLogger } from "@/lib/platform/logger";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import { enqueueClusterIntentsJob } from "@/lib/readings/intent-engine/jobs";
import { intentEngineRegistration } from "@/lib/readings/intent-engine/register";
import {
  enqueueFoldIntentGraphJob,
  type IntentGraphDb,
  syncIntentGraphLiveFromStatus,
} from "@/lib/readings/intent-graph/queries";
import { intentGraphRegistration } from "@/lib/readings/intent-graph/register";
import { queryIntentsRegistration } from "@/lib/readings/query-intents/register";
import { toolExplorerRegistration } from "@/lib/readings/tool-explorer/register";
import { topicsRegistration } from "@/lib/readings/topics/register";
import { traceSignalsRegistration } from "@/lib/readings/trace-signals/register";
import { qualityRegistration } from "@/lib/synthesis/quality/register";
import { toolCrafterRegistration } from "@/lib/synthesis/tool-crafter/register";
import { tracesRegistration } from "@/lib/synthesis/traces/register";
import { alertsRegistration } from "@/lib/views/alerts/register";
import { evalGateRegistration } from "@/lib/views/eval-gate/register";
import { fixDraftsRegistration } from "@/lib/views/fix-drafts/register";
import { scorersRegistration } from "@/lib/views/scorers/register";
import { sessionReplayRegistration } from "@/lib/views/session-replay/register";
import { taskEvalsRegistration } from "@/lib/views/task-evals/register";

const queueLogger = getLogger("ingest/queue");

/**
 * A worker has no response to drain after: a job a stored batch queued (the turn build, the paced
 * fold) runs from the analysis lane. An all-in-one process drains the project's jobs at once.
 */
function kickProjectJobs(projectId: string): void {
  if (!runsJobsAfterResponse()) return;
  void drainProjectJobs(projectId).catch((error) =>
    queueLogger.error({ err: error, project_id: projectId }, "job drain after ingest failed"),
  );
}

/**
 * The ingest queue's write path (RTL-314): exactly what the three ingest routes wire for their
 * inline writes, so a queued batch is stored as the route would have stored it.
 */
export function ingestPersistDeps(): IngestPersistDeps {
  const fold: IntentGraphFoldScheduleDeps = {
    enqueueFoldIntentGraphJob: (projectId, _payload, options) =>
      enqueueFoldIntentGraphJob(projectId, undefined, options),
    enqueueClusterIntentsJob: (projectId, _payload, options) =>
      enqueueClusterIntentsJob(projectId, undefined, options),
    scheduleProjectDrain: kickProjectJobs,
  };
  const traceTurns = {
    enqueueBuild: (projectId: string) => enqueueBuildTraceTurnsJob(projectId),
    scheduleProjectDrain: kickProjectJobs,
  };
  const genAiLogs = createGenAiLogStore();
  const otlpRawCapture = { store: createOtlpRawStore() };
  const modelPricing = {
    loadOverrides: (projectId: string) => loadPriceOverrides(projectId, getDb()),
  };
  return {
    getOrganizationByProjectId,
    traces: {
      ...fold,
      insertEventsWithMetrics,
      insertOtelSpans,
      findStoredOtelSpans,
      insertTraceEvents,
      incrementEventUsage,
      traceMetering: composition.traceMetering,
      traceTurns,
      findRuntimeInvokes: (projectId, probe) => findRuntimeInvokes(projectId, probe),
      agentSpanDedupe: {
        findTracesWithModelCalls: (projectId, traceIds) =>
          findTracesWithModelCalls(projectId, traceIds),
      },
      genAiLogs,
      otlpRawCapture,
      locate: geoIngest.locate,
      modelPricing,
      trackServerEvent,
    },
    logs: {
      insertOtelLogs,
      otlpRawCapture,
      genAiLogJoin: { store: genAiLogs, modelPricing },
      trackServerEvent,
    },
    events: {
      ...fold,
      insertTraceEvents: (projectId, events, db, options) =>
        insertTraceEvents(projectId, events, db, {
          ...options,
          syncIntentGraphLive: (id, tx) => syncIntentGraphLiveFromStatus(id, tx as IntentGraphDb),
        }),
      insertTraceEventRejects,
      traceTurns,
      trackServerEvent,
    },
    logError: (message, error, fields) => queueLogger.error({ ...fields, err: error }, message),
    logWarn: (message, fields) => queueLogger.warn(fields, message),
    reportServerException,
  };
}

const INGEST_QUEUE: IngestQueueRuntimeDeps = { persistDeps: ingestPersistDeps };

/** What the ingest routes take to queue a batch (`EXPERIMENTAL_INGEST_QUEUE`). */
export function ingestQueueRouteDeps(): IngestQueueAcceptDeps {
  return ingestQueueAcceptDeps(INGEST_QUEUE);
}

/**
 * The other composition root: the one file that imports every module's `register.ts` and so the
 * one file `check-layers` exempts from the downward-only rule. Core modules are listed here as
 * they land, in layer order; the Cloud edition contributes through the registry port.
 */
const CORE: Registration[] = [
  ingestTraceEventsRegistration,
  createIngestQueueRegistration(INGEST_QUEUE),
  ledgerRegistration,
  queryIntentsRegistration,
  intentGraphRegistration,
  intentEngineRegistration,
  traceSignalsRegistration,
  toolExplorerRegistration,
  topicsRegistration,
  tracesRegistration,
  qualityRegistration,
  toolCrafterRegistration,
  evalGateRegistration,
  fixDraftsRegistration,
  sessionReplayRegistration,
  taskEvalsRegistration,
  scorersRegistration,
  alertsRegistration,
];

export function collectRegistrations(
  core: Registration[] = CORE,
  extra: Registration[] = composition.registry.registrations(),
): Registration[] {
  return [...core, ...extra];
}

/** Every job kind with its handler; a kind registered twice is a configuration error. */
export function jobHandlers(
  registrations: Registration[] = collectRegistrations(),
): Record<string, JobHandler> {
  const out: Record<string, JobHandler> = {};
  for (const r of registrations) {
    for (const [kind, handler] of Object.entries(r.jobs ?? {})) {
      if (kind in out) throw new Error(`job kind registered twice: ${kind}`);
      out[kind] = handler;
    }
  }
  return out;
}

/**
 * The running jobs every registration vouches for (`Registration.liveJobs`), for the reaper. A
 * registration whose read fails vouches for none.
 */
export async function liveJobIds(
  registrations: Registration[] = collectRegistrations(),
): Promise<string[]> {
  const reads = registrations.flatMap((r) => (r.liveJobs ? [r.liveJobs().catch(() => [])] : []));
  return [...new Set((await Promise.all(reads)).flat())];
}

/** Drain steps in registration order, `before` steps first. */
export function drainSteps(registrations: Registration[] = collectRegistrations()): DrainStep[] {
  const all = registrations.flatMap((r) => r.drainSteps ?? []);
  const names = new Set<string>();
  for (const step of all) {
    if (names.has(step.name)) throw new Error(`drain step registered twice: ${step.name}`);
    names.add(step.name);
  }
  return [...all.filter((s) => s.phase === "before"), ...all.filter((s) => s.phase === "after")];
}

/** Every registration's worker lanes, read once when the worker starts. */
export function workerLanes(registrations: Registration[] = collectRegistrations()): WorkerLane[] {
  return registrations.flatMap((r) => r.workerLanes?.() ?? []);
}
