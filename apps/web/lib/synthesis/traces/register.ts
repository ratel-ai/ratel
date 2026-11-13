import type { DrainStep, Registration } from "@/lib/contracts/registry";
import { createBackgroundObservability } from "@/lib/jobs/observability";
import { pruneExpiredOtelLogs, pruneExpiredOtelSpans, pruneExpiredTraceSummaries } from "./queries";
import { refreshTraceSummaries, type TraceSummaryRefreshResult } from "./summary-refresh";

type TrackSystemEvent = ReturnType<typeof createBackgroundObservability>["trackSystemEvent"];

/** Folds newly received spans into `otel_trace_summaries`; reports under upstream's heartbeat keys. */
export function refreshStep(
  refresh: () => Promise<TraceSummaryRefreshResult> = () => refreshTraceSummaries(),
  track: TrackSystemEvent = createBackgroundObservability().trackSystemEvent,
): DrainStep {
  return {
    name: "trace_summary_refresh",
    phase: "after",
    run: async () => {
      const r = await refresh();
      if (r.spansScanned > 0) {
        await track("trace_summaries_refreshed", "system:cron", {
          spans_scanned: r.spansScanned,
          traces_recomputed: r.tracesRecomputed,
          batches: r.batches,
          caught_up: r.caughtUp,
          lock_contended: r.lockContended,
        });
      }
      return {
        traceSummarySpansScanned: r.spansScanned,
        traceSummariesRecomputed: r.tracesRecomputed,
        traceSummariesCaughtUp: r.caughtUp,
      };
    },
  };
}

type RetentionPrunes = {
  pruneExpiredOtelSpans: () => Promise<number>;
  pruneExpiredOtelLogs: () => Promise<number>;
  pruneExpiredTraceSummaries: () => Promise<number>;
};

/**
 * The three retention passes over received telemetry, one bounded batch each per tick, run only
 * when the operator has turned retention deletion on. The step results keep upstream's heartbeat
 * keys.
 */
export function retentionSteps(
  prunes: RetentionPrunes = {
    pruneExpiredOtelSpans: () => pruneExpiredOtelSpans(),
    pruneExpiredOtelLogs: () => pruneExpiredOtelLogs(),
    pruneExpiredTraceSummaries: () => pruneExpiredTraceSummaries(),
  },
): { spans: DrainStep; logs: DrainStep; summaries: DrainStep } {
  return {
    spans: {
      name: "otel_spans_prune",
      phase: "after",
      retentionOnly: true,
      run: async () => ({ otelSpansPruned: await prunes.pruneExpiredOtelSpans() }),
    },
    logs: {
      name: "otel_logs_prune",
      phase: "after",
      retentionOnly: true,
      run: async () => ({ otelLogsPruned: await prunes.pruneExpiredOtelLogs() }),
    },
    summaries: {
      name: "trace_summary_prune",
      phase: "after",
      retentionOnly: true,
      run: async () => ({ traceSummariesPruned: await prunes.pruneExpiredTraceSummaries() }),
    },
  };
}

const retention = retentionSteps();

// Upstream's order: spans and logs are pruned before the refresh, summaries after it.
export const tracesRegistration: Registration = {
  drainSteps: [retention.spans, retention.logs, refreshStep(), retention.summaries],
};
