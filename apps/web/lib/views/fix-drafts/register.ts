import type { Registration } from "@/lib/contracts/registry";
import { withProjectLogContext } from "@/lib/platform/project-log-context";
import { computeSeams } from "@/lib/readings/trace-signals/signals/compute-job";
import { evalGateSeams } from "@/lib/views/eval-gate/seams";
import { draftFixJob, enqueueProjectFixDrafts } from "@/lib/views/fix-drafts/job";
import { resolveFixChange } from "@/lib/views/fix-drafts/resolve";
import { fixDraftSpendSince } from "@/lib/views/fix-drafts/store";

/**
 * Fix drafts' registration (upstream's `draft_fix` line in `lib/jobs/handlers.ts`), and what it
 * supplies to the eval gate: the drafted change of a fix, and what drafts spent, so they share the
 * one daily budget. Filled when this module loads; the eval gate's `service` and `page-model`
 * import it for that, so the web process has it as well as the worker.
 */
export const evalGateSeamFills = {
  resolveChange: resolveFixChange,
  spendSince: fixDraftSpendSince,
};

export function fillEvalGateSeams(seams: typeof evalGateSeams = evalGateSeams): void {
  seams.resolveChange = evalGateSeamFills.resolveChange;
  if (!seams.spendSince.includes(evalGateSeamFills.spendSince))
    seams.spendSince.push(evalGateSeamFills.spendSince);
}

fillEvalGateSeams();

/** A completed signal run queues drafts for the project's new rewrite and tell-apart fixes. */
export const computeSeamFills: Required<Pick<typeof computeSeams, "enqueueFixDrafts">> = {
  enqueueFixDrafts: (projectId) => enqueueProjectFixDrafts(projectId),
};

export function fillComputeSeams(seams: typeof computeSeams = computeSeams): void {
  Object.assign(seams, computeSeamFills);
}

fillComputeSeams();

export const fixDraftsRegistration: Registration = {
  // In the project's log context, so `model_call` lines carry the project and organization.
  jobs: {
    draft_fix: (job) =>
      withProjectLogContext(job.projectId, () => draftFixJob(job.projectId, job.payload)),
  },
};
