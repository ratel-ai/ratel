import type { DrainStep, Registration } from "@/lib/contracts/registry";
import { createBackgroundObservability } from "@/lib/jobs/observability";
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

// The summary prune lands with the span retention prune, which no module registers yet.
export const tracesRegistration: Registration = { drainSteps: [refreshStep()] };
