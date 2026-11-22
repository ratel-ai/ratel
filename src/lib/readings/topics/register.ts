import type { Registration } from "@/lib/contracts/registry";
import { JOB_ASKS, jobAskFor, type NoPayload } from "@/lib/jobs/job-ask";
import { inProjectLogContext } from "@/lib/jobs/project-context";
import { sandboxesEnabledForProject } from "@/lib/platform/sandboxes-flag";
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
  // In the project's log context, so `model_call` lines carry the project and organization.
  jobs: {
    // RC-1092: with FF_SANDBOXES on, the job stamps its `topic-place` sandbox.
    assign_topics: inProjectLogContext(jobAskFor<NoPayload>(JOB_ASKS.assign_topics), async (job) =>
      assignProjectTopics(job.projectId, {
        sandbox: await sandboxesEnabledForProject(job.projectId),
      }),
    ),
  },
};
