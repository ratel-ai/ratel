import { getLogger } from "@/lib/platform/logger";
import type { OpenRun } from "./ports/run-store";
import { type RunDeps, recordUsage, stopInstanceOf } from "./runs";

/**
 * The drain step of runs: it ends a run with no result (timeout, or its instance is gone), stops
 * the instance of each ended run, and records usage that was not recorded.
 */
export type SweepDeps = Pick<RunDeps, "runs" | "provider" | "limits" | "now"> & {
  organizationIdOf: (projectId: string) => Promise<string | null>;
};

/** A run that waits longer than this was left by a process that ended. */
export const START_STOPPED_MS = 2 * 60_000;
const LIMIT = 500;
const PARALLEL = 10;

const TIMEOUT_REASON = "The run had no result before its timeout.";
const NO_RESULT_REASON = "The instance ended with no result.";
const NOT_STARTED_REASON = "The instance did not start. Run it again.";

const logger = getLogger("sandboxes/run-sweep");

export async function sweepRuns(
  deps: SweepDeps,
): Promise<{ endedRuns: number; stoppedInstances: number; sandboxRunErrors: number }> {
  const totals = { endedRuns: 0, stoppedInstances: 0, sandboxRunErrors: 0 };
  const open = await deps.runs.listOpen(LIMIT);
  const work = async () => {
    for (let run = open.shift(); run; run = open.shift()) {
      try {
        const { ended, stopped } = await sweepRun(run, deps);
        if (ended) totals.endedRuns += 1;
        if (stopped) totals.stoppedInstances += 1;
      } catch (error) {
        totals.sandboxRunErrors += 1;
        logger.error({ project_id: run.projectId, run_id: run.id, err: error }, "run sweep failed");
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, work));
  return totals;
}

async function sweepRun(run: OpenRun, deps: SweepDeps) {
  const active = run.status === "queued" || run.status === "running";
  const ended = active ? await endIfOver(run, deps) : true;
  const stopped =
    ended && !run.instanceStoppedAt && run.instanceRef ? await stopInstanceOf(run, deps) : false;
  if (run.instanceRef && !run.usageRecordedAt) {
    const organizationId = await deps.organizationIdOf(run.projectId);
    if (organizationId) {
      await recordUsage(run.id, { organizationId, projectId: run.projectId }, deps);
    }
  }
  return { ended: active && ended, stopped };
}

/** Whether the run has ended now. A result that comes at the same time wins. */
async function endIfOver(run: OpenRun, deps: SweepDeps): Promise<boolean> {
  const now = deps.now();
  const age = now.getTime() - (run.startedAt ?? run.createdAt).getTime();
  if (run.status === "queued") {
    if (age < START_STOPPED_MS) return false;
    await deps.runs.finish(run.id, { status: "infra_error", reason: NOT_STARTED_REASON }, now);
    return true;
  }
  const timedOut = { status: "timed_out" as const, reason: TIMEOUT_REASON };
  if (age >= run.timeoutS * 1000) {
    await deps.runs.finish(run.id, timedOut, now);
    return true;
  }
  if (!deps.provider || !run.instanceRef) return false;
  const status = await deps.provider.status(run.instanceRef);
  if (status.state === "running") return false;
  await deps.runs.finish(
    run.id,
    status.reason === "timeout" ? timedOut : { status: "infra_error", reason: NO_RESULT_REASON },
    now,
  );
  return true;
}
