import { composition } from "@/lib/composition/ports";
import type { TraceMeteringPort } from "@/lib/contracts/trace-metering";
import { geoIngest } from "@/lib/ingest/geo/ingest";
import { loadPriceOverrides } from "@/lib/ingest/model-pricing/store";
import { processLogs } from "@/lib/ingest/otlp/process-logs";
import { processTraces } from "@/lib/ingest/otlp/process-traces";
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
import { startIngestConsumer } from "@/lib/ingest/queue/consumer";
import { ingestQueue } from "@/lib/ingest/queue/ingest-queue";
import type { EnvelopeConsumer, EnvelopeHandler } from "@/lib/ingest/queue/port/envelope-queue";
import { createEnvelopeHandler } from "@/lib/ingest/queue/process";
import { processEvents } from "@/lib/ingest/trace-events/process-events";
import { insertTraceEventRejects, insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { enqueueBuildTraceTurnsJob } from "@/lib/ledger/turns/queries";
import { getDb } from "@/lib/platform/db/client";
import { incrementEventUsage } from "@/lib/platform/entitlements";
import { getOrganizationById, type Organization } from "@/lib/platform/organizations";
import { getProjectById, touchApiKeyAt } from "@/lib/platform/projects/queries";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { enqueueClusterIntentsJob } from "@/lib/readings/intent-engine/jobs";
import {
  enqueueFoldIntentGraphJob,
  type IntentGraphDb,
  syncIntentGraphLiveFromStatus,
} from "@/lib/readings/intent-graph/queries";

/**
 * The Kafka consumer with its real dependencies: what the three ingest routes wire for their inline
 * writes, for `instrumentation.node.ts`. Outside `lib`, because it wires modules of every layer, as a
 * route does. Null without `INGEST_QUEUE=kafka`.
 */
export async function startConfiguredIngestConsumer(): Promise<EnvelopeConsumer | null> {
  const queue = await ingestQueue();
  return queue && startIngestConsumer({ queue, handler: configuredHandler() });
}

/** A replay stores what was accepted before, so it counts nothing and stamps no key. */
export interface ReplayDeps {
  /** Decides a trace as it was decided before. Absent, every trace is analyzed. */
  traceMetering?: TraceMeteringPort;
}

export function configuredHandler(replay?: ReplayDeps): EnvelopeHandler {
  // The jobs are only queued: the worker's loop, or the minute tick, runs them.
  const scheduleProjectDrain = () => undefined;
  const jobs = {
    traceTurns: {
      enqueueBuild: (projectId: string) => enqueueBuildTraceTurnsJob(projectId),
      scheduleProjectDrain,
    },
    enqueueFoldIntentGraphJob: (
      projectId: string,
      _payload: undefined,
      options: { minIntervalMs: number },
    ) => enqueueFoldIntentGraphJob(projectId, undefined, options),
    enqueueClusterIntentsJob: (
      projectId: string,
      _payload: undefined,
      options: { minIntervalMs: number },
    ) => enqueueClusterIntentsJob(projectId, undefined, options),
    scheduleProjectDrain,
  };
  const modelPricing = {
    loadOverrides: (projectId: string) => loadPriceOverrides(projectId, getDb()),
  };
  const genAiLogs = createGenAiLogStore();
  const otlpRawCapture = { store: createOtlpRawStore() };
  const shared = replay
    ? { touchApiKeyAt: async () => ({ first: false }), trackServerEvent: async () => undefined }
    : { touchApiKeyAt, trackServerEvent };
  const counters = replay
    ? { traceMetering: replay.traceMetering }
    : { incrementEventUsage, traceMetering: composition.traceMetering };

  return createEnvelopeHandler({
    findProject: async (projectId) => {
      const project = await getProjectById(projectId);
      if (!project) return null;
      // A replay runs outside the edition, which owns organizations: the meter asks for the id only.
      const organization = replay
        ? ({ id: project.organizationId } as Organization)
        : await getOrganizationById(project.organizationId);
      return { organization };
    },
    traces: (envelope, context) =>
      processTraces(envelope, context, {
        ...shared,
        ...jobs,
        insertEventsWithMetrics,
        insertOtelSpans,
        findStoredOtelSpans,
        insertTraceEvents,
        ...counters,
        findRuntimeInvokes: (projectId, probe) => findRuntimeInvokes(projectId, probe),
        agentSpanDedupe: {
          findTracesWithModelCalls: (projectId, traceIds) =>
            findTracesWithModelCalls(projectId, traceIds),
        },
        genAiLogs,
        otlpRawCapture,
        // Codes instead of addresses in every row, and no raw copy of a body that holds one.
        locate: geoIngest.locate,
        modelPricing,
      }),
    logs: (envelope, context) =>
      processLogs(envelope, context, {
        ...shared,
        insertOtelLogs,
        otlpRawCapture,
        genAiLogJoin: { store: genAiLogs, modelPricing },
      }),
    events: (envelope, context) =>
      processEvents(envelope, context, {
        ...shared,
        ...jobs,
        insertTraceEvents: (projectId, events, db, options) =>
          insertTraceEvents(projectId, events, db, {
            ...options,
            // The ingest transaction is a full handle; the option's type is the ingest's narrower one.
            syncIntentGraphLive: (id, tx) => syncIntentGraphLiveFromStatus(id, tx as IntentGraphDb),
          }),
        insertTraceEventRejects,
      }),
  });
}
