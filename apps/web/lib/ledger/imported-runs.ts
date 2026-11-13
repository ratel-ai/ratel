import type { ImportedRunsPort } from "@/lib/contracts/imported-runs";
import { persistDecodedSpans } from "@/lib/ingest/otlp/ingest-spans";
import { insertEventsWithMetrics, insertOtelSpans } from "@/lib/ingest/otlp/queries";
import { findRuntimeInvokes } from "@/lib/ingest/otlp/runtime-facts-query";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { enqueueJob } from "@/lib/jobs/queries";
import { runsJobsAfterResponse } from "@/lib/jobs/role";
import { scheduleProjectDrain } from "@/lib/jobs/route-helpers";
import { drainProjectJobs } from "@/lib/jobs/store";
import { registerImportedSourceIds } from "@/lib/ledger/constants";
import { enqueueBuildTraceTurnsJob } from "@/lib/ledger/turns/queries";

export type ImportedRunsDeps = {
  persistDecodedSpans: typeof persistDecodedSpans;
  enqueueBuildTraceTurnsJob: typeof enqueueBuildTraceTurnsJob;
  drainProjectJobs: (projectId: string) => Promise<unknown>;
  enqueueJob: (input: {
    projectId: string;
    kind: string;
    payload?: unknown;
  }) => Promise<{ id: string }>;
  scheduleProjectDrain: (projectId: string) => void;
  runsJobsAfterResponse: () => boolean;
};

const defaultDeps: ImportedRunsDeps = {
  persistDecodedSpans,
  enqueueBuildTraceTurnsJob,
  drainProjectJobs: (projectId) => drainProjectJobs(projectId),
  enqueueJob: (input) => enqueueJob(input),
  scheduleProjectDrain: (projectId) => scheduleProjectDrain(projectId),
  runsJobsAfterResponse: () => runsJobsAfterResponse(),
};

/**
 * The core's ingest and job queue for imported runs, lent to the edition at startup
 * (`instrumentation.node.ts`). The bodies are upstream's `storeDeps` in
 * `lib/health-imports/start.ts`, which the edition calls through this port.
 */
export function createImportedRuns(deps: ImportedRunsDeps = defaultDeps): ImportedRunsPort {
  return {
    persist: (projectId, organization, spans, report) =>
      deps.persistDecodedSpans(
        spans,
        // No quotaOrgId: an import never spends the monthly event allowance, so it can
        // never lock out live ingest. It is bounded by its own caps instead.
        // No fold kick either: the cron drain's safety net folds imported runs paced.
        { projectId, organization, endpoint: "health_import", foldIntentGraph: false },
        {
          insertEventsWithMetrics,
          insertTraceEvents,
          insertOtelSpans,
          // The drain runs once at the end, rather than per batch.
          traceTurns: {
            enqueueBuild: (id) => deps.enqueueBuildTraceTurnsJob(id),
            scheduleProjectDrain: () => {},
          },
          findRuntimeInvokes: (id, probe) => findRuntimeInvokes(id, probe),
          // No agentSpanDedupe: an imported run's `invoke_agent` root carries no model or
          // usage, so it is never a call to dedupe.
          logError: report.logError,
          captureFailure: report.captureFailure,
        },
      ),
    requestReading: async (projectId) => {
      // The run rides on the build: the build enqueues it once it has caught up, so it reads
      // every run the import stored instead of racing the build for them.
      await deps.enqueueBuildTraceTurnsJob(projectId, undefined, { reading: "manual" });
      // An API-only process leaves the build to the worker (APP_ROLE, lib/jobs/role.ts).
      if (deps.runsJobsAfterResponse()) await deps.drainProjectJobs(projectId);
    },
    enqueueJob: (projectId, kind, payload) => deps.enqueueJob({ projectId, kind, payload }),
    scheduleDrain: (projectId) => deps.scheduleProjectDrain(projectId),
    registerSourceIds: (ids) => registerImportedSourceIds(ids),
  };
}
