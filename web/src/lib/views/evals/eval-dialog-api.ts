import { z } from "zod";
import { forMember, type MemberAccessDeps, refuse, reply } from "@/lib/console/scope/member-access";
import type { SandboxVersionSummary } from "@/lib/views/sandboxes";
import { datasetQuerySchema } from "./domain/dataset";
import {
  currentVersion,
  evalContentSchema,
  evalDetailsSchema,
  MAX_EVAL_TRIALS,
  MAX_SANDBOX_NAME_CHARS,
  matrixSchema,
} from "./domain/eval";
import { readJson } from "./experiments-api";
import type { DatasetStore } from "./ports/dataset-store";
import type { EvalStore } from "./ports/eval-store";
import type { ScorerLibrary } from "./ports/scorer-library";
import { scorerRequestSchema, withDefinitions } from "./scorer-library";

/**
 * The session route of the "New eval" dialog (decisions `runs-per-eval`, `eval-terms`,
 * `scorer-library`): a name, an optional task, a runtime (a sandbox at its newest ready version or
 * at a pinned version), a dataset (one that exists, or a new query dataset), default params with an
 * optional matrix, the trials and the scorers from the library. "Production agent" is not a
 * runtime yet, so no request can name it.
 */
export type EvalDialogDeps = MemberAccessDeps & {
  evals: () => EvalStore;
  datasets: () => DatasetStore;
  library: () => ScorerLibrary;
  /** The versions of the project's sandboxes, the newest first. */
  versions: (projectId: string) => Promise<SandboxVersionSummary[]>;
};

const paramValue = z.union([z.string(), z.number(), z.boolean()]);
const runtimeSchema = z.object({
  sandboxName: z.string().trim().min(1).max(MAX_SANDBOX_NAME_CHARS),
  /** Null: the newest ready version when a run starts. */
  sandboxVersionId: z.uuid().nullable().default(null),
});
const datasetChoiceSchema = z.union([
  z.object({ datasetId: z.uuid() }),
  z.object({
    query: datasetQuerySchema.refine(({ kind }) => kind !== "fixed", "choose a query kind"),
    /** Default: "<eval name> traces". */
    name: z.string().trim().min(1).max(100).optional(),
  }),
]);
const createSchema = evalDetailsSchema.extend({
  runtime: runtimeSchema,
  dataset: datasetChoiceSchema,
  params: z.record(z.string(), paramValue).default({}),
  matrix: matrixSchema,
  trials: z.number().int().min(1).max(MAX_EVAL_TRIALS).optional(),
  scorers: z.array(scorerRequestSchema).min(1, "choose at least one scorer").max(50),
});

export function handleCreateEvalFromDialog(
  request: Request,
  projectId: string,
  deps: EvalDialogDeps,
): Promise<Response> {
  const span = { feature: "evals", operation: "create_eval" } as const;
  return forMember(
    projectId,
    span,
    deps,
    async (member) => {
      const body = createSchema.safeParse(await readJson(request));
      if (!body.success) return invalid(body.error);
      const { name, taskId, runtime, dataset, scorers: asked, ...rest } = body.data;
      const runtimeProblem = await checkRuntime(member.projectId, runtime, deps);
      if (runtimeProblem) return runtimeProblem;
      const evals = deps.evals();
      if (await evals.getByName(member.projectId, name)) return nameTaken();
      const scorers = await withDefinitions(member.projectId, asked, deps.library());
      if (!scorers.ok) return refuse(400, "invalid_scorers", scorers.message);
      // Checked before a dataset is made, so a refused eval leaves no dataset behind.
      const checked = evalContentSchema.safeParse({
        ...rest,
        ...runtime,
        scorers: scorers.scorers,
      });
      if (!checked.success) return invalid(checked.error);
      const datasets = deps.datasets();
      let datasetId: string;
      if ("datasetId" in dataset) {
        if (!(await datasets.get(member.projectId, dataset.datasetId))) return datasetNotFound();
        datasetId = dataset.datasetId;
      } else {
        const made = await datasets.create({
          projectId: member.projectId,
          name: dataset.name ?? `${name} traces`,
          description: null,
          query: dataset.query,
          createdBy: member.externalId,
        });
        if (made === "name_taken") {
          return refuse(409, "dataset_name_taken", "Another dataset of the project has this name.");
        }
        datasetId = made.id;
      }
      const made = await evals.create({
        projectId: member.projectId,
        name,
        taskId,
        content: { ...checked.data, datasetId },
        createdBy: member.externalId,
      });
      if (made === "name_taken") return nameTaken();
      if (made === "dataset_not_found") return datasetNotFound();
      return reply(201, { evalId: made.id, versionId: currentVersion(made).id, datasetId });
    },
    { write: true },
  );
}

/** Why the runtime cannot run the eval, or null: a ready version of the named sandbox. */
async function checkRuntime(
  projectId: string,
  { sandboxName, sandboxVersionId }: z.output<typeof runtimeSchema>,
  deps: EvalDialogDeps,
): Promise<Response | null> {
  const versions = await deps.versions(projectId);
  const ofSandbox = versions.filter(({ name }) => name === sandboxName);
  if (ofSandbox.length === 0) {
    return refuse(404, "sandbox_not_found", `The project has no sandbox ${sandboxName}.`);
  }
  if (sandboxVersionId === null) {
    return ofSandbox.some(({ status }) => status === "ready")
      ? null
      : refuse(409, "version_not_ready", `The sandbox ${sandboxName} has no ready version yet.`);
  }
  const pinned = versions.find(({ id }) => id === sandboxVersionId);
  if (!pinned) return refuse(404, "version_not_found", "There is no such version.");
  if (pinned.name !== sandboxName) {
    return refuse(409, "wrong_sandbox", `That version is a version of ${pinned.name}.`);
  }
  if (pinned.status !== "ready") {
    return refuse(409, "version_not_ready", "That version is not ready. Pin a ready version.");
  }
  return null;
}

function invalid(error: z.ZodError): Response {
  const issue = error.issues[0];
  const where = issue?.path.join(".");
  return refuse(400, "invalid", `${where ? `${where}: ` : ""}${issue?.message ?? "Invalid."}`);
}

function nameTaken(): Response {
  return refuse(409, "name_taken", "Another eval of the project has this name.");
}

function datasetNotFound(): Response {
  return refuse(404, "dataset_not_found", "There is no such dataset.");
}
