import type { JobHandler } from "@/lib/contracts/registry";
import { withAgentRun } from "@/lib/platform/agent-run";
import { withProjectLogContext } from "@/lib/platform/project-log-context";
import { type JobAskSpec, jobAsk } from "./job-ask";

/** Where the project's labels come from; a test passes its own. */
type LookupProjectLabels = Parameters<typeof withProjectLogContext>[2];

/**
 * Jobs that call models run in a log context naming the project and its
 * organization, so their `model_call` lines (lib/platform/model-call.ts) say
 * whose work spent the money.
 *
 * Each such job is also one agent run in Ratel's own project (ratel-cloud #483):
 * its model calls become children of an `invoke_agent <kind>` span. Its ask is
 * the job in words with only allowlisted ids (ratel-cloud #517, `job-ask.ts`):
 * the project and the payload belong to another organization.
 *
 * Owned (ADR-0030): upstream keeps this in its job hub (`lib/jobs/handlers.ts`);
 * here each module's `register.ts` wraps the same jobs with it, and passes its
 * kind's ask spec.
 */
export function inProjectLogContext(
  ask: JobAskSpec,
  handler: JobHandler,
  lookup?: LookupProjectLabels,
): JobHandler {
  return (job) =>
    withProjectLogContext(
      job.projectId,
      () =>
        withAgentRun(
          { name: job.kind, conversationId: job.id, ask: jobAsk(ask, job.payload) },
          () => handler(job),
        ),
      lookup,
    );
}
