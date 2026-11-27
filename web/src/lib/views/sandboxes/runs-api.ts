import { z } from "zod";
import { type ConsoleAccessDeps, forMember, refuse, reply } from "./console-access";
import { toolModeSchema } from "./domain/contract";
import { EVAL_TRIAL_PREFIX, runView } from "./domain/run";
import { getRun, type RunDeps, type StartRunResult, startRun } from "./runs";

/** The session routes of runs: a member runs one input by hand. */
export type RunsApiDeps = ConsoleAccessDeps & {
  runDeps: () => RunDeps;
  track: (run: {
    externalId: string;
    projectId: string;
    organizationId: string;
    outcome: string;
  }) => Promise<void>;
  /** Whether the project lets Ratel read captured text. */
  contentOptIn: (projectId: string) => Promise<boolean>;
};

const bodySchema = z.object({
  versionId: z.uuid(),
  input: z.unknown(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  tools: z.record(z.string(), z.object({ mode: toolModeSchema })).optional(),
});
const STATUS: Record<Exclude<StartRunResult, { ok: true }>["reason"], number> = {
  not_found: 404,
  not_ready: 409,
  not_configured: 503,
  missing_secrets: 409,
  input_too_large: 413,
  invalid: 400,
  limit_reached: 429,
};

export function handleStartRun(
  request: Request,
  projectId: string,
  deps: RunsApiDeps,
): Promise<Response> {
  const work = async (member: Parameters<Parameters<typeof forMember>[3]>[0]) => {
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return refuse(400, "invalid", "Give a version and an input.");
    const { versionId, input, params, tools } = body.data;
    const { organizationId, externalId } = member;
    const result = await startRun(
      versionId,
      input,
      {
        projectId: member.projectId,
        organizationId,
        requestedBy: externalId,
        ...(params ? { params } : {}),
        ...(tools ? { tools } : {}),
        strict: true,
      },
      deps.runDeps(),
    );
    await deps.track({
      externalId,
      projectId: member.projectId,
      organizationId,
      outcome: result.ok ? result.run.status : result.reason,
    });
    if (result.ok) return reply(202, runView(result.run));
    const { reason, message } = result;
    if (result.reason !== "limit_reached") return refuse(STATUS[reason], reason, message);
    const { limit, max, current } = result;
    return reply(STATUS[reason], { error: reason, message, limit, max, current });
  };
  return forMember(projectId, "start_run", deps, work, { write: true });
}

export function handleGetRun(
  projectId: string,
  runId: string,
  deps: RunsApiDeps,
): Promise<Response> {
  return forMember(projectId, "get_run", deps, async (member) => {
    const known = z.uuid().safeParse(runId).success;
    const run = known ? await getRun(member.projectId, runId, deps.runDeps()) : null;
    if (!run) return refuse(404, "not_found", "There is no such run.");
    // The input of a run that an eval started can be a row copied from a trace: captured text.
    const fromEval = run.requestedBy.startsWith(EVAL_TRIAL_PREFIX);
    if (fromEval && !(await deps.contentOptIn(member.projectId))) {
      const view = runView(run);
      return reply(200, { ...view, input: null, result: null, logs: null, contentWithheld: true });
    }
    return reply(200, runView(run));
  });
}
