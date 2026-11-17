import type { JobHandler, JobRecord } from "@/lib/contracts/registry";
import { withAgentRun } from "@/lib/platform/agent-run";
import { withProjectLogContext } from "@/lib/platform/project-log-context";

/**
 * Jobs that call models run in a log context naming the project and its
 * organization, so their `model_call` lines (lib/platform/model-call.ts) say
 * whose work spent the money.
 *
 * Each such job is also one agent run in Ratel's own project (ratel-cloud #483):
 * its model calls become children of an `invoke_agent <kind>` span.
 *
 * Owned (ADR-0030): upstream keeps this in its job hub (`lib/jobs/handlers.ts`);
 * here each module's `register.ts` wraps the same jobs with it.
 */
export function inProjectLogContext(handler: JobHandler): JobHandler {
  return (job) =>
    withProjectLogContext(job.projectId, () =>
      withAgentRun({ name: job.kind, conversationId: job.id, ask: jobAsk(job) }, () =>
        handler(job),
      ),
    );
}

/** What a job was asked to do: its kind, its project and its payload (ids and settings). */
export function jobAsk(job: Pick<JobRecord, "kind" | "projectId" | "payload">): string {
  const payload =
    job.payload === undefined || job.payload === null ? "" : `\n${JSON.stringify(job.payload)}`;
  return `${job.kind} for project ${job.projectId}${payload}`;
}
