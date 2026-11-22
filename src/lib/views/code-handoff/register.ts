import type { Registration } from "@/lib/contracts/registry";
import { INDEX_REPO_CODE_JOB } from "@/lib/jobs/kinds";
import { detectDeploysByVersion } from "./deploy/detect-by-version";
import { type CodeIndexPayload, codeIndexDeps, runCodeIndex } from "./handoff/code-index";

/**
 * Code handoff's registration: the `index_repo_code` job (upstream's line in
 * `lib/jobs/handlers.ts`): the code pointers of a linked repo (RC-917), a budget of symbols per
 * run; a rate limit queues the next run instead of failing. Only a link or a handoff asks for
 * a run.
 *
 * And the drain's `deploy_watch_version` step (upstream's `detectDeploysByVersion` in
 * `lib/cron/drain.ts`, RC-920): spans whose `service.version` is a pushed commit's sha ship that
 * commit's fixes. Not retention-only; with no link waiting for a deploy it stops after one read.
 * Its count keeps upstream's heartbeat name, `deployShipments`.
 */
export const codeHandoffRegistration: Registration = {
  jobs: {
    [INDEX_REPO_CODE_JOB]: (job) =>
      runCodeIndex(job.projectId, job.payload as CodeIndexPayload, codeIndexDeps()),
  },
  drainSteps: [
    {
      name: "deploy_watch_version",
      phase: "after",
      run: async () => ({ deployShipments: (await detectDeploysByVersion()).shipped }),
    },
  ],
};
