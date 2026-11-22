import type { Registration } from "@/lib/contracts/registry";
import { INDEX_REPO_CODE_JOB } from "@/lib/jobs/kinds";
import { type CodeIndexPayload, codeIndexDeps, runCodeIndex } from "./handoff/code-index";

/**
 * Code handoff's registration (upstream's `index_repo_code` line in `lib/jobs/handlers.ts`): the
 * code pointers of a linked repo (RC-917), a budget of symbols per run; a rate limit queues the
 * next run instead of failing. Nothing is queued with `FF_CODE_HANDOFF` off: only a link or a
 * handoff asks for a run.
 */
export const codeHandoffRegistration: Registration = {
  jobs: {
    [INDEX_REPO_CODE_JOB]: (job) =>
      runCodeIndex(job.projectId, job.payload as CodeIndexPayload, codeIndexDeps()),
  },
};
