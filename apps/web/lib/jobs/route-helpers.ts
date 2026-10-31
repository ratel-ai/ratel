import { after } from "next/server";
import {
  type BackgroundObservabilityDeps,
  createBackgroundObservability,
  defaultBackgroundObservabilityDeps,
} from "@/lib/jobs/observability";
import { enqueueJob } from "@/lib/jobs/queries";
import type { JobKind } from "@/lib/jobs/runner";
import { drainProjectJobs } from "@/lib/jobs/store";

/** A route-shaped result: HTTP status + JSON body. */
export interface EnqueueResult {
  status: number;
  body: unknown;
}

export interface ScheduleProjectDrainDeps {
  after: (callback: () => void | Promise<void>) => void;
  drainProjectJobs: typeof drainProjectJobs;
  observability: BackgroundObservabilityDeps;
}

const defaultScheduleProjectDrainDeps: ScheduleProjectDrainDeps = {
  after: (callback) => after(callback),
  drainProjectJobs,
  observability: defaultBackgroundObservabilityDeps,
};

/**
 * Enqueue + post-response drain for a project the caller has ALREADY authorized and
 * resolved to an id (e.g. a manual match quality run). Enqueues the job,
 * schedules an `after()` drain so the work runs server-side and survives the client
 * closing the tab, and returns `202 { jobId }`. A failure in the drain is logged and
 * captured; the cron backstop retries queued jobs.
 */
export async function enqueueForProjectId(
  projectId: string,
  kind: JobKind,
  payload: unknown,
): Promise<EnqueueResult> {
  const { id } = await enqueueJob({ projectId, kind, payload });
  scheduleProjectDrain(projectId);
  return { status: 202, body: { jobId: id } };
}

export function scheduleProjectDrain(
  projectId: string,
  deps: ScheduleProjectDrainDeps = defaultScheduleProjectDrainDeps,
): void {
  const observability = createBackgroundObservability(deps.observability);
  deps.after(async () => {
    try {
      await deps.drainProjectJobs(projectId);
    } catch (error) {
      observability.reportException("after response drain failed", error, `project:${projectId}`, {
        operation: "after_drain",
        project_id: projectId,
      });
    }
  });
}
