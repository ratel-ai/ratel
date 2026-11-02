import type { Registration } from "@/lib/contracts/registry";
import { computeSeams } from "@/lib/readings/trace-signals/signals/compute-job";
import { exploreProjectToolUsage, parseExplorePayload } from "./job";
import { EXPLORE_JOB_KIND, enqueueExploreJob } from "./queries";

/**
 * What the tool explorer contributes to the background machinery: the `explore_tool_usage`
 * job, one reading of which tools a project's agent calls together and which comes next,
 * over the ledger window of the signal run that queued it. It has no drain step of its
 * own: every signal run queues it through the compute job's seam, which loading this
 * module fills (`enqueueExploreJob(projectId, "chained", signalRunId)`, coalesced to one
 * queued job per project).
 */

export const computeSeamFills: Required<Pick<typeof computeSeams, "enqueueExplore">> = {
  enqueueExplore: (projectId, signalRunId) => enqueueExploreJob(projectId, "chained", signalRunId),
};

export function fillComputeSeams(seams: typeof computeSeams = computeSeams): void {
  Object.assign(seams, computeSeamFills);
}

fillComputeSeams();

export const toolExplorerRegistration: Registration = {
  jobs: {
    [EXPLORE_JOB_KIND]: (job) =>
      exploreProjectToolUsage(job.projectId, parseExplorePayload(job.payload)),
  },
};
