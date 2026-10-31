import type { DrainStep, JobHandler, Registration } from "@/lib/contracts/registry";
import { loadToolCorpus } from "@/lib/ingest/runtime-catalog/inventory";
import { createBackgroundObservability } from "@/lib/jobs/observability";
import { foldSeams } from "@/lib/readings/intent-graph/fold-job";
import type { SweepResult } from "@/lib/readings/match-quality/sweep";
import {
  executeMatchQualityRun,
  parseMatchQualityPayload,
} from "@/lib/synthesis/match-quality/job";
import { MAX_REPLAY_CASES, registerAll } from "@/lib/synthesis/match-quality/replay";
import { sweepMatchQuality } from "@/lib/synthesis/match-quality/sweep-service";
import { type QualitySnapshotResult, refreshQualitySnapshots } from "./snapshot";

type TrackSystemEvent = ReturnType<typeof createBackgroundObservability>["trackSystemEvent"];

/**
 * What match quality and the quality rollup contribute to the background machinery: the run
 * job, the daily snapshot and the weekly sweep, reported under upstream's names. Loading this
 * module also fills the fold's seam: each search ranked with and without the graph, for
 * Adaptive ranking's comparison.
 */

/** A payload that no longer parses means the run row is gone; reporting that beats a retry. */
export const matchQualityRunJob: JobHandler = async (job) => {
  const payload = parseMatchQualityPayload(job.payload);
  if (!payload) return { proposalsCreated: 0, reason: "invalid_payload" };
  return executeMatchQualityRun(payload);
};

export function snapshotStep(
  refresh: () => Promise<QualitySnapshotResult> = () => refreshQualitySnapshots(),
  track: TrackSystemEvent = createBackgroundObservability().trackSystemEvent,
): DrainStep {
  return {
    name: "quality_snapshot_refresh",
    phase: "after",
    run: async () => {
      const r = await refresh();
      if (!r.skipped) {
        await track("quality_snapshots_refreshed", "system:cron", {
          projects_scanned: r.projectsScanned,
          calibrations_rolled_up: r.calibrationsRolledUp,
          days_written: r.daysWritten,
          fingerprints_changed: r.fingerprintsChanged,
        });
      }
      return { ...r };
    },
  };
}

/** It enqueues work that spends money on a model call, so it self-throttles to weekly. */
export function sweepStep(
  sweep: () => Promise<SweepResult> = () => sweepMatchQuality(),
  track: TrackSystemEvent = createBackgroundObservability().trackSystemEvent,
): DrainStep {
  return {
    name: "match_quality_sweep",
    phase: "after",
    run: async () => {
      const r = await sweep();
      if (!r.skipped) {
        await track("match_quality_runs_enqueued", "system:cron", {
          projects_scanned: r.projectsScanned,
          runs_enqueued: r.runsEnqueued,
        });
      }
      return { ...r };
    },
  };
}

foldSeams.loadShadow = async (projectId) => {
  const corpus = await loadToolCorpus(projectId);
  if (corpus.length === 0 || corpus.length > MAX_REPLAY_CASES) return null;
  return { plain: registerAll(corpus, new Map()), boosted: registerAll(corpus, new Map()) };
};

export const qualityRegistration: Registration = {
  jobs: { match_quality_run: matchQualityRunJob },
  drainSteps: [snapshotStep(), sweepStep()],
};
