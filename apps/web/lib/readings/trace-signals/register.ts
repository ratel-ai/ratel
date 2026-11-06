import type { DrainStep, Registration } from "@/lib/contracts/registry";
import { createBackgroundObservability } from "@/lib/jobs/observability";
import { ledgerSeams } from "@/lib/ledger/turns/build-job";
import {
  computeProjectTraceSignals,
  enqueueFirstSignalRun,
  parseComputePayload,
} from "./signals/compute-job";
import { enqueueComputeJob } from "./signals/queries";
import type { SignalSweepResult } from "./sweep";
import { sweepTraceSignals } from "./sweep-service";
import { labelProjectWorkflows } from "./workflows/label-job";

type TrackSystemEvent = ReturnType<typeof createBackgroundObservability>["trackSystemEvent"];

/**
 * What the Agent health reading contributes to the background machinery: the
 * `compute_trace_signals` job (one signal run over a project's closed turns), the
 * `label_workflows` job (model names for the mined workflows, then the judge's placement
 * of recent asks in them) and the daily sweep that enqueues due runs. The step reports
 * under upstream's heartbeat key.
 *
 * Loading this module also fills the ledger's seams: the turn build enqueues a run when a
 * page asked for one, and kicks the first reading once enough turns have closed. Only the
 * job runner builds turns, and it loads the registry first, so the seams are set before
 * any build runs.
 */

/** The ledger's two hooks into the signal runs, as this reading fills them. */
export const ledgerSeamFills: Required<typeof ledgerSeams> = {
  enqueueReading: (projectId, trigger) => enqueueComputeJob(projectId, trigger),
  onBacklogDrained: (projectId) => enqueueFirstSignalRun(projectId),
};

export function fillLedgerSeams(seams: Partial<typeof ledgerSeams> = ledgerSeams): void {
  Object.assign(seams, ledgerSeamFills);
}

fillLedgerSeams();

/** The daily sweep as a drain step: enqueues due runs; the drain's job pass runs them. */
export function sweepStep(
  sweep: () => Promise<SignalSweepResult> = () => sweepTraceSignals(),
  track: TrackSystemEvent = createBackgroundObservability().trackSystemEvent,
): DrainStep {
  return {
    name: "trace_signal_sweep",
    phase: "after",
    run: async () => {
      const r = await sweep();
      if (!r.skipped) {
        await track("trace_signal_runs_enqueued", "system:cron", {
          object_action: "trace_signal_runs_enqueued",
          projects_scanned: r.projectsScanned,
          runs_enqueued: r.runsEnqueued,
        });
      }
      return { traceSignalRunsEnqueued: r.runsEnqueued };
    },
  };
}

export const traceSignalsRegistration: Registration = {
  jobs: {
    compute_trace_signals: (job) =>
      computeProjectTraceSignals(job.projectId, parseComputePayload(job.payload)),
    label_workflows: (job) => labelProjectWorkflows(job.projectId),
  },
  drainSteps: [sweepStep()],
};
