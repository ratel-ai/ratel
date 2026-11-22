import type { Registration } from "@/lib/contracts/registry";
import { exploreSeams } from "@/lib/readings/tool-explorer/job";
import { craftProjectTools, parseCraftPayload } from "./job";
import { CRAFT_JOB_KIND, enqueueCraftJob } from "./queries";

/**
 * What the tool crafter contributes to the background machinery: the `craft_tools` job, one
 * rule-drafted pass over a project's tools after each explorer run. It has no drain step of
 * its own: every completed explorer run queues it through the explorer job's seam, which
 * loading this module fills (`enqueueCraftJob(projectId, undefined, "chained")`, coalesced to
 * one queued job per project by `jobs_craft_tools_queued_idx`).
 */

export const exploreSeamFills: Required<Pick<typeof exploreSeams, "enqueueCraft">> = {
  enqueueCraft: (projectId) => enqueueCraftJob(projectId, undefined, "chained"),
};

export function fillExploreSeams(seams: typeof exploreSeams = exploreSeams): void {
  Object.assign(seams, exploreSeamFills);
}

fillExploreSeams();

export const toolCrafterRegistration: Registration = {
  jobs: {
    [CRAFT_JOB_KIND]: (job) => craftProjectTools(job.projectId, {}, parseCraftPayload(job.payload)),
  },
};
