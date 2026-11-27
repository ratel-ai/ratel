import { z } from "zod";
import {
  forMember,
  type Member,
  type MemberAccessDeps,
  refuse,
  reply,
} from "@/lib/console/scope/member-access";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import type { UsageSubject } from "@/lib/contracts/usage-limits";
import type { ResolvedApiKeyProject } from "@/lib/platform/api-key-bearer";
import { storable } from "@/lib/platform/storable";
import type { Compared } from "./baseline";
import { MAX_SANDBOX_NAME_CHARS } from "./domain/eval";
import { type Experiment, MAX_TRIALS } from "./domain/experiment";
import { experimentView } from "./experiment-view";
import { type ExperimentDeps, type StartRefusal, startExperiment } from "./experiments";
import { suiteTable } from "./suite-view";

/**
 * Starts and reads experiments: with a project key (`protocol/evals/v1`), and for a member of the
 * console. There is no route that changes or deletes an experiment.
 */
export type ExperimentsApiDeps = {
  experiments: () => ExperimentDeps;
  /** The first step of a new experiment, after the response. */
  advance: (experiment: Experiment) => void;
  track: (experiment: Experiment, by: { externalId?: string; surface: string }) => Promise<void>;
  publicUrl: (path: string) => string;
  /**
   * The pinned baseline run of an eval (of the suite runs: null), with its trials. Null when none
   * is pinned.
   */
  baseline: (projectId: string, evalId: string | null) => Promise<Compared | null>;
};

/** Who may call the routes of a project key. */
export type KeyAccess = {
  /** True when no project of the deployment can have the flag: the route then answers 404 first. */
  offForAll: () => boolean;
  authenticate: () => Promise<ResolvedApiKeyProject>;
  enabled: (projectId: string) => Promise<boolean>;
  organizationIdOf: (projectId: string) => Promise<string | null>;
};

export type KeyDeps = ExperimentsApiDeps & KeyAccess;

export type ConsoleDeps = ExperimentsApiDeps & MemberAccessDeps;

const MAX_BODY_CHARS = 64 * 1024;
const LIST_LIMIT = 50;
const startSchema = z.object({
  sandboxVersion: z.union([z.literal("latest"), z.uuid()]),
  /** The sandbox of the run. `latest` is its newest ready version. */
  sandbox: z.string().trim().min(1).max(MAX_SANDBOX_NAME_CHARS).optional(),
  /** Absent: the trials of each eval. */
  trials: z.number().int().min(1).max(MAX_TRIALS).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  /** The names of the evals to run. Absent: the suite. */
  evals: z.array(z.string().trim().min(1).max(200)).min(1).max(100).optional(),
  label: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200).optional(),
});
const STATUS: Record<StartRefusal, number> = {
  sandboxes_off: 409,
  not_found: 404,
  not_ready: 409,
  no_cases: 409,
  too_many_running: 429,
  too_many_trials: 413,
  invalid_params: 400,
  wrong_sandbox: 409,
  no_content_access: 403,
  query_failed: 422,
  too_many_rows: 413,
  invalid_scorers: 400,
  shared_dataset: 409,
};

export function handleStartByKey(request: Request, deps: KeyDeps): Promise<Response> {
  return forKey(deps, "start_experiment", async (subject, apiKeyId) =>
    start(request, subject, { startedBy: `key:${apiKeyId}`, surface: "api" }, deps),
  );
}

export function handleGetByKey(experimentId: string, deps: KeyDeps): Promise<Response> {
  return forKey(deps, "get_experiment", (subject) => get(subject.projectId, experimentId, deps));
}

export function handleListByKey(deps: KeyDeps): Promise<Response> {
  return forKey(deps, "list_experiments", async ({ projectId }) => {
    const { experiments } = deps.experiments();
    const rows = await experiments.list(projectId, LIST_LIMIT);
    return reply(200, {
      experiments: rows.map((experiment) => ({
        experimentId: experiment.id,
        state: experiment.state,
        sandboxVersionId: experiment.sandboxVersionId,
        createdAt: experiment.createdAt.toISOString(),
        url: urlOf(experiment, deps),
      })),
    });
  });
}

export function handleStartByMember(
  request: Request,
  projectId: string,
  deps: ConsoleDeps,
): Promise<Response> {
  return forMember(
    projectId,
    { feature: "evals", operation: "start_experiment" },
    deps,
    (member: Member) =>
      start(
        request,
        member,
        { startedBy: member.externalId, externalId: member.externalId, surface: "console" },
        deps,
      ),
    { write: true },
  );
}

/** The output and the tool calls of one trial, for a member. */
export function handleTrialEvidence(
  projectId: string,
  trialId: string,
  deps: ConsoleDeps,
): Promise<Response> {
  const span = { feature: "evals", operation: "get_trial" } as const;
  return forMember(projectId, span, deps, async (member) => {
    const { experiments } = deps.experiments();
    const known = z.uuid().safeParse(trialId).success;
    const evidence = known ? await experiments.trialEvidence(member.projectId, trialId) : null;
    return evidence ? reply(200, evidence) : notFound();
  });
}

async function start(
  request: Request,
  { projectId, organizationId }: UsageSubject,
  by: { startedBy: string; externalId?: string; surface: string },
  deps: ExperimentsApiDeps,
): Promise<Response> {
  const body = startSchema.safeParse(await readJson(request));
  if (!body.success) {
    const issue = body.error.issues[0];
    const where = issue?.path.join(".");
    return refuse(400, "invalid", `${where ? `${where}: ` : ""}${issue?.message ?? "Invalid."}`);
  }
  const { sandboxVersion, sandbox, trials, params, label, name, evals } = body.data;
  const result = await startExperiment(
    { projectId, organizationId },
    {
      sandboxVersion,
      ...(sandbox ? { sandbox } : {}),
      ...(trials === undefined ? {} : { trialsPerCase: trials }),
      ...(evals ? { evals } : {}),
      params,
      startedBy: by.startedBy,
      ...(label ? { label } : {}),
      ...(name ? { name } : {}),
    },
    deps.experiments(),
  );
  if (!result.ok) return refuse(STATUS[result.reason], result.reason, result.message);
  const { experiment } = result;
  deps.advance(experiment);
  await deps.track(experiment, by);
  return reply(201, {
    experimentId: experiment.id,
    state: experiment.state,
    url: urlOf(experiment, deps),
  });
}

async function get(
  projectId: string,
  experimentId: string,
  deps: ExperimentsApiDeps,
): Promise<Response> {
  const { experiments } = deps.experiments();
  const known = z.uuid().safeParse(experimentId).success;
  const experiment = known ? await experiments.get(projectId, experimentId) : null;
  if (!experiment) return notFound();
  const [trials, baseline] = await Promise.all([
    experiments.trials(experiment.id),
    deps.baseline(projectId, experiment.evalId),
  ]);
  const suite = suiteTable({ experiment, trials }, baseline);
  return reply(200, experimentView(experiment, trials, urlOf(experiment, deps), suite, baseline));
}

export async function forKey(
  deps: KeyAccess,
  operation: string,
  work: (subject: UsageSubject, apiKeyId: string) => Promise<Response>,
): Promise<Response> {
  if (deps.offForAll()) return notFound();
  const resolved = await deps.authenticate();
  if (!resolved.ok) return resolved.response;
  const { projectId, apiKeyId } = resolved;
  if (!(await deps.enabled(projectId))) return notFound();
  const organizationId = await deps.organizationIdOf(projectId);
  if (!organizationId) return notFound();
  return withFeatureSpan("evals", operation, () => work({ projectId, organizationId }, apiKeyId), {
    attributes: { "project.id": projectId },
  });
}

export function urlOf(
  { projectId, id }: Pick<Experiment, "projectId" | "id">,
  deps: Pick<ExperimentsApiDeps, "publicUrl">,
): string {
  return deps.publicUrl(`/project/${projectId}/evals/experiments/${id}`);
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY_CHARS) return null;
  try {
    // Also here: a value that is too deep to store is a wrong body.
    return storable(JSON.parse(text));
  } catch {
    return null;
  }
}

export function notFound(): Response {
  return refuse(404, "not_found", "Not found.");
}
