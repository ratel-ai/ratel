import type { Registration } from "@/lib/contracts/registry";
import { computeSeams } from "@/lib/readings/trace-signals/signals/compute-job";
import { assignProjectTopics } from "./job";
import { enqueueAssignTopicsJob } from "./queries";

/**
 * What the topics reading contributes to the background machinery: the `assign_topics`
 * job, one reading of a project's topics over its last 30 days of closed turns. It has no
 * drain step of its own: every signal run queues it through the compute job's seam, which
 * loading this module fills.
 */

export const computeSeamFills: Required<Pick<typeof computeSeams, "enqueueTopics">> = {
  enqueueTopics: (projectId) => enqueueAssignTopicsJob(projectId),
};

export function fillComputeSeams(seams: typeof computeSeams = computeSeams): void {
  Object.assign(seams, computeSeamFills);
}

fillComputeSeams();

export const topicsRegistration: Registration = {
  jobs: {
    assign_topics: (job) => assignProjectTopics(job.projectId),
  },
};
