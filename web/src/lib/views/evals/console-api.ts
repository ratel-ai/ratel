import { z } from "zod";
import {
  forMember,
  type Member,
  type MemberAccessDeps,
  refuse,
  reply,
} from "@/lib/console/scope/member-access";
import {
  type ActionDeps,
  type ActionRefusal,
  addDatasetRows,
  createDataset,
  createEval,
  editEval,
  evalBodySchema,
  MAX_ROWS,
  newDatasetSchema,
  previewQuery,
  removeDatasetRow,
  rowInputSchema,
  runBodySchema,
  startRun,
} from "./actions";
import { currentVersion } from "./domain/eval";
import { datasetQuerySchema } from "./domain/dataset";
import type { Experiment } from "./domain/experiment";
import { readJson } from "./experiments-api";
import { runHref } from "./paths";

/**
 * The session routes of the Datasets and Evals pages. Each one checks the member, the `evals`
 * flag and a support session, then calls the action that the MCP operation calls too
 * (`actions.ts`). A row from a trace copies captured text: the project must let Ratel read it.
 */
export type ConsoleApiDeps = MemberAccessDeps & {
  actions: () => ActionDeps;
  /** The content rule of the project. */
  readContent: (projectId: string) => Promise<boolean>;
  /** Drives a new run after the response. */
  advance: (experiment: Experiment) => void;
  track: (
    event: "eval_dataset_created" | "eval_created" | "eval_experiment_started",
    member: Member,
    fields: Record<string, string | number | boolean>,
  ) => Promise<void>;
  now: () => Date;
};

const STATUS: Record<ActionRefusal, number> = {
  invalid: 400,
  not_found: 404,
  name_taken: 409,
  no_content_access: 403,
  not_fixed: 409,
  changed: 409,
  sandboxes_off: 409,
  not_ready: 409,
  no_cases: 409,
  too_many_running: 429,
  too_many_trials: 413,
  invalid_params: 400,
  wrong_sandbox: 409,
  query_failed: 422,
  too_many_rows: 413,
  invalid_scorers: 400,
  shared_dataset: 409,
};

const addRowsSchema = z.object({ rows: z.array(rowInputSchema).min(1).max(MAX_ROWS) });
const previewSchema = z.object({ query: datasetQuerySchema });
const editSchema = evalBodySchema.extend({ base: z.uuid() });

/** POST /api/projects/[projectId]/evals/datasets: a dataset of one kind. */
export function handleCreateDatasetByMember(
  request: Request,
  projectId: string,
  deps: ConsoleApiDeps,
): Promise<Response> {
  return write(projectId, "create_dataset", deps, async (member) => {
    const body = newDatasetSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const made = await createDataset(member.projectId, await actorOf(member, deps), body.data, deps.actions());
    if (!made.ok) return refuse(STATUS[made.reason], made.reason, made.message);
    await deps.track("eval_dataset_created", member, { kind: made.dataset.query.kind, rows: made.rows });
    return reply(201, { datasetId: made.dataset.id, rows: made.rows });
  });
}

/** POST /api/projects/[projectId]/evals/datasets/[datasetId]/rows: rows from turns or typed values. */
export function handleAddDatasetRowsByMember(
  request: Request,
  projectId: string,
  datasetId: string,
  deps: ConsoleApiDeps,
): Promise<Response> {
  return write(projectId, "add_dataset_rows", deps, async (member) => {
    if (!z.uuid().safeParse(datasetId).success) return notFound();
    const body = addRowsSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const added = await addDatasetRows(
      member.projectId,
      datasetId,
      await actorOf(member, deps),
      body.data.rows,
      deps.actions(),
    );
    if (!added.ok) return refuse(STATUS[added.reason], added.reason, added.message);
    return reply(201, { rows: added.rows });
  });
}

/** DELETE /api/projects/[projectId]/evals/datasets/[datasetId]/rows/[rowId]. Runs keep their copy. */
export function handleRemoveDatasetRowByMember(
  projectId: string,
  datasetId: string,
  rowId: string,
  deps: ConsoleApiDeps,
): Promise<Response> {
  return write(projectId, "remove_dataset_row", deps, async (member) => {
    if (!z.uuid().safeParse(datasetId).success || !z.uuid().safeParse(rowId).success) {
      return notFound();
    }
    const removed = await removeDatasetRow(member.projectId, datasetId, rowId, {
      datasets: deps.actions().datasets,
      now: deps.now,
    });
    if (!removed.ok) return refuse(STATUS[removed.reason], removed.reason, removed.message);
    return reply(200, { removed: rowId });
  });
}

/** POST /api/projects/[projectId]/evals/datasets/preview: what a query resolves to now. */
export function handlePreviewDatasetByMember(
  request: Request,
  projectId: string,
  deps: ConsoleApiDeps,
): Promise<Response> {
  return forMember(projectId, { feature: "evals", operation: "preview_dataset" }, deps, async (member) => {
    const body = previewSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const preview = await previewQuery(
      member.projectId,
      await actorOf(member, deps),
      body.data.query,
      deps.actions(),
    );
    // A refusal is the answer of the preview, not an error of the request.
    return reply(200, preview);
  });
}

/** POST /api/projects/[projectId]/evals/definitions: an eval from the "New eval" dialog. */
export function handleCreateEvalByMember(
  request: Request,
  projectId: string,
  deps: ConsoleApiDeps,
): Promise<Response> {
  return write(projectId, "create_eval", deps, async (member) => {
    const body = evalBodySchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const made = await createEval(member.projectId, await actorOf(member, deps), body.data, deps.actions());
    if (!made.ok) return refuse(STATUS[made.reason], made.reason, made.message);
    const version = currentVersion(made.eval);
    await deps.track("eval_created", member, {
      scorers: version.scorers.length,
      matrix: Object.keys(version.matrix).length > 0,
    });
    return reply(201, { evalId: made.eval.id, versionId: version.id });
  });
}

/** PUT /api/projects/[projectId]/evals/definitions/[evalId]: "Edit" in the eval header. */
export function handleEditEvalByMember(
  request: Request,
  projectId: string,
  evalId: string,
  deps: ConsoleApiDeps,
): Promise<Response> {
  return write(projectId, "edit_eval", deps, async (member) => {
    if (!z.uuid().safeParse(evalId).success) return notFound();
    const body = editSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const saved = await editEval(
      member.projectId,
      evalId,
      { ...(await actorOf(member, deps)), now: deps.now() },
      body.data,
      deps.actions(),
    );
    if (!saved.ok) return refuse(STATUS[saved.reason], saved.reason, saved.message);
    const version = currentVersion(saved.eval);
    return reply(200, { evalId, versionId: version.id, number: version.number });
  });
}

/** POST /api/projects/[projectId]/evals/definitions/[evalId]/runs: "New run". */
export function handleStartRunByMember(
  request: Request,
  projectId: string,
  evalId: string,
  deps: ConsoleApiDeps,
): Promise<Response> {
  return write(projectId, "start_eval_run", deps, async (member) => {
    if (!z.uuid().safeParse(evalId).success) return notFound();
    const body = runBodySchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const started = await startRun(
      { projectId: member.projectId, organizationId: member.organizationId },
      evalId,
      await actorOf(member, deps),
      body.data,
      deps.actions(),
    );
    if (!started.ok) return refuse(STATUS[started.reason], started.reason, started.message);
    const { experiment } = started;
    deps.advance(experiment);
    await deps.track("eval_experiment_started", member, {
      variants: experiment.variants.length,
      rows: experiment.caseVersions.length,
      changed: Object.keys(experiment.changes).length > 0,
    });
    return reply(201, {
      runId: experiment.id,
      state: experiment.state,
      href: runHref(member.projectId, evalId, experiment.id),
    });
  });
}

async function actorOf(member: Member, deps: Pick<ConsoleApiDeps, "readContent">) {
  return { by: member.externalId, mayReadContent: await deps.readContent(member.projectId) };
}

function write(
  projectId: string,
  operation: string,
  deps: ConsoleApiDeps,
  work: (member: Member) => Promise<Response>,
): Promise<Response> {
  return forMember(projectId, { feature: "evals", operation }, deps, work, { write: true });
}

function invalid(error: z.ZodError): Response {
  const issue = error.issues[0];
  const where = issue?.path.join(".");
  return refuse(400, "invalid", `${where ? `${where}: ` : ""}${issue?.message ?? "Invalid."}`);
}

function notFound(): Response {
  return refuse(404, "not_found", "Not found.");
}
