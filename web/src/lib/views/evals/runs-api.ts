import { z } from "zod";
import { refuse, reply } from "@/lib/console/scope/member-access";
import type { UsageSubject } from "@/lib/contracts/usage-limits";
import { rqlRefusal } from "./datasets";
import { currentVersion as currentRow } from "./domain/case";
import {
  type Dataset,
  datasetDetailsSchema,
  datasetQuerySchema,
  rowKindOf,
  valueRowSchema,
} from "./domain/dataset";
import {
  currentVersion,
  type EvalDefinition,
  evalContentSchema,
  evalDetailsSchema,
  evalScorerSchema,
  MAX_EVAL_TRIALS,
  matrixSchema,
  scorerRefSchema,
} from "./domain/eval";
import type { Experiment } from "./domain/experiment";
import { type EachRunPart, type EvalRunChanges, startEachEvalRun, startEvalRun } from "./eval-runs";
import type { StartRefusal } from "./experiments";
import { forKey, type KeyDeps, notFound, readJson, urlOf } from "./experiments-api";
import { datasetsView, evalHistory, evalsOverview, withPinnedRuns } from "./history-view";
import type { BaselineStore } from "./ports/baseline-store";
import type { DatasetStore, NewRow } from "./ports/dataset-store";
import type { EvalStore } from "./ports/eval-store";
import { rowOfSandboxRun } from "./sandbox-rows";
import { scorerFromRef } from "./scorer-library";

/**
 * The evals, their runs and the datasets, with a project key (`protocol/evals/v1`, decision
 * `runs-per-eval`). A run belongs to one eval. A start of each eval makes one run for each eval.
 * No route changes or deletes a run.
 */
export type RunsApiDeps = KeyDeps & {
  catalog: () => { evals: EvalStore; datasets: DatasetStore; baselines: BaselineStore };
};

/** The runs of the project that the history reads, the newest. */
const HISTORY_RUNS = 100;
const MAX_ROWS = 100;

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
  rql_off: 403,
  query_failed: 422,
  too_many_rows: 413,
  invalid_scorers: 400,
  shared_dataset: 409,
};

const paramValue = z.union([z.string(), z.number(), z.boolean()]);
const changesSchema = z.object({
  sandboxVersion: z.union([z.literal("latest"), z.uuid()]).optional(),
  sandbox: z.string().trim().min(1).max(200).optional(),
  dataset: z.string().trim().min(1).max(200).optional(),
  params: z.record(z.string(), paramValue).optional(),
  matrix: matrixSchema.optional(),
  trials: z.number().int().min(1).max(MAX_EVAL_TRIALS).optional(),
  name: z.string().trim().min(1).max(200).optional(),
});
/** A row of a request: typed values, or the input of a sandbox run of the project. */
const rowSchema = z.discriminatedUnion("kind", [
  valueRowSchema.extend({
    kind: z.literal("values"),
    name: z.string().trim().min(1).max(200),
    labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  }),
  z.object({
    kind: z.literal("sandbox_run"),
    sandboxRunId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    expectedOutput: z.string().max(20_000).nullable().default(null),
  }),
]);
/** A scorer of a request: a library reference, or a scorer of its own. */
const scorerSchema = z.union([
  evalScorerSchema,
  z.object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    gating: z.boolean().default(true),
    ref: scorerRefSchema,
  }),
]);
const oneRunSchema = changesSchema.extend({
  rows: z.array(rowSchema).max(MAX_ROWS).optional(),
  scorers: z.array(scorerSchema).max(50).optional(),
});
const eachRunSchema = changesSchema.extend({
  evals: z.array(z.string().trim().min(1).max(200)).min(1).max(100).optional(),
});
const createEvalSchema = evalDetailsSchema.extend({
  dataset: z.string().trim().min(1).max(200).optional(),
  sandboxName: z.string().trim().min(1).max(200).nullable().optional(),
  sandboxVersionId: z.uuid().nullable().optional(),
  params: z.record(z.string(), paramValue).optional(),
  matrix: matrixSchema.optional(),
  trials: z.number().int().min(1).max(MAX_EVAL_TRIALS).optional(),
  scorers: z.array(scorerSchema).max(50).default([]),
});
const createDatasetSchema = datasetDetailsSchema.extend({
  query: datasetQuerySchema.default({ kind: "fixed" }),
  rows: z.array(rowSchema).max(MAX_ROWS).optional(),
});
const addRowsSchema = z.object({ rows: z.array(rowSchema).min(1).max(MAX_ROWS) });

/** GET /api/v1/evals: the Evals overview. */
export function handleEvalsOverviewByKey(deps: RunsApiDeps): Promise<Response> {
  return forKey(deps, "list_evals", async ({ projectId }) => {
    const { evals, datasets, baselines } = deps.catalog();
    const [definitions, summaries, recent] = await Promise.all([
      evals.list(projectId),
      datasets.list(projectId),
      recentRuns(projectId, deps),
    ]);
    const pins = await Promise.all(
      definitions.map(async ({ id }) => [id, (await baselines.get(projectId, id))?.experimentId]),
    );
    const runs = await withPinnedRuns(
      recent,
      pins.map(([, run]) => run),
      (id) => oneRun(projectId, id, deps),
    );
    const rows = evalsOverview({
      evals: definitions,
      rowCounts: new Map(summaries.map(({ id, rowCount }) => [id, rowCount])),
      runs,
      baselines: new Map(pins.flatMap(([id, run]) => (id && run ? [[id, run]] : []))),
    });
    return reply(200, { v: 1, evals: rows });
  });
}

/** GET /api/v1/evals/{eval}: one eval (by its name or its id) with its runs. */
export function handleEvalByKey(wanted: string, deps: RunsApiDeps): Promise<Response> {
  return forKey(deps, "get_eval", async ({ projectId }) => {
    const { evals, baselines } = deps.catalog();
    const definition = await findEval(projectId, wanted, evals);
    if (!definition) return notFound();
    const pin = await baselines.get(projectId, definition.id);
    const runs = await withPinnedRuns(
      await recentRuns(projectId, deps),
      [pin?.experimentId],
      (id) => oneRun(projectId, id, deps),
    );
    const baseline = runs.find(({ experiment }) => experiment.id === pin?.experimentId) ?? null;
    const history = evalHistory({ definition, runs, baseline });
    return reply(200, { v: 1, eval: evalView(definition), ...history });
  });
}

/** POST /api/v1/evals: creates an eval. With no dataset it gets its own fixed dataset. */
export function handleCreateEvalByKey(request: Request, deps: RunsApiDeps): Promise<Response> {
  return forKey(deps, "create_eval", async ({ projectId }, apiKeyId) => {
    const body = createEvalSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const { name, taskId, dataset, scorers: asked, ...rest } = body.data;
    const { evals, datasets } = deps.catalog();
    const datasetId =
      dataset === undefined ? null : await findDatasetId(projectId, dataset, datasets);
    if (dataset !== undefined && datasetId === null) return datasetNotFound();
    const scorers = await withDefinitions(projectId, asked, deps);
    if (!scorers.ok) return refuse(400, "invalid_scorers", scorers.message);
    const content = evalContentSchema.safeParse({ ...rest, datasetId, scorers: scorers.scorers });
    if (!content.success) return invalid(content.error);
    const made = await evals.create({
      projectId,
      name,
      taskId,
      content: content.data,
      createdBy: `key:${apiKeyId}`,
    });
    if (made === "name_taken") {
      return refuse(409, "name_taken", "Another eval of the project has this name.");
    }
    if (made === "dataset_not_found") return datasetNotFound();
    return reply(201, { v: 1, eval: evalView(made) });
  });
}

/** POST /api/v1/evals/{eval}/runs: starts a run of one eval, with changes for this run only. */
export function handleStartEvalRunByKey(
  request: Request,
  wanted: string,
  deps: RunsApiDeps,
): Promise<Response> {
  return forKey(deps, "start_eval_run", async (subject, apiKeyId) => {
    const body = oneRunSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const { name, rows: askedRows, scorers: askedScorers, ...changes } = body.data;
    const rows = askedRows ? await newRows(subject.projectId, askedRows, deps) : undefined;
    if (rows && !rows.ok) return refuse(404, "not_found", rows.message);
    const scorers = askedScorers
      ? await withDefinitions(subject.projectId, askedScorers, deps)
      : undefined;
    if (scorers && !scorers.ok) return refuse(400, "invalid_scorers", scorers.message);
    const run: EvalRunChanges = {
      ...changes,
      ...(rows ? { rows: rows.rows } : {}),
      ...(scorers ? { scorers: scorers.scorers } : {}),
    };
    const result = await startEvalRun(
      subject,
      { eval: wanted, startedBy: `key:${apiKeyId}`, ...(name ? { name } : {}), changes: run },
      deps.experiments(),
    );
    if (!result.ok) return refuse(STATUS[result.reason], result.reason, result.message);
    const started = await startedView(result.experiment, subject, deps);
    return reply(201, { v: 1, ...started });
  });
}

/** POST /api/v1/evals/runs: one run for each eval (or for the evals named), with the same changes. */
export function handleStartEachByKey(request: Request, deps: RunsApiDeps): Promise<Response> {
  return forKey(deps, "start_eval_runs", async (subject, apiKeyId) => {
    const body = eachRunSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const { name, evals, ...changes } = body.data;
    const result = await startEachEvalRun(
      subject,
      {
        startedBy: `key:${apiKeyId}`,
        ...(evals ? { evals } : {}),
        ...(name ? { name } : {}),
        changes,
      },
      deps.experiments(),
    );
    if (!result.ok) return refuse(STATUS[result.reason], result.reason, result.message);
    const runs = await Promise.all(result.runs.map((part) => partView(part, subject, deps)));
    return reply(201, { v: 1, runs });
  });
}

/** GET /api/v1/evals/datasets: each dataset with its kind, its rows or its query, and its evals. */
export function handleDatasetsByKey(deps: RunsApiDeps): Promise<Response> {
  return forKey(deps, "list_datasets", async ({ projectId }) => {
    const { evals, datasets } = deps.catalog();
    const [summaries, definitions] = await Promise.all([
      datasets.list(projectId),
      evals.list(projectId),
    ]);
    return reply(200, { v: 1, datasets: datasetsView(summaries, definitions) });
  });
}

/**
 * GET /api/v1/evals/datasets/{dataset}: one dataset (by its id or its name) with its rows. A row
 * has no captured text here: its name, its kind, its turn and its version.
 */
export function handleDatasetByKey(wanted: string, deps: RunsApiDeps): Promise<Response> {
  return forKey(deps, "get_dataset", async ({ projectId }) => {
    const { datasets } = deps.catalog();
    const id = await findDatasetId(projectId, wanted, datasets);
    const dataset = id === null ? null : await datasets.get(projectId, id);
    if (!dataset) return datasetNotFound();
    const rows = await datasets.rows(projectId, dataset.id);
    return reply(200, {
      v: 1,
      dataset: datasetView(dataset),
      rows: rows.map((row) => {
        const version = currentRow(row);
        return {
          rowId: row.id,
          name: row.name,
          labels: row.labels,
          kind: version ? rowKindOf(version) : "values",
          turnId: version?.sourceTurnId ?? null,
          version: version?.number ?? null,
        };
      }),
    });
  });
}

/** POST /api/v1/evals/datasets: creates a dataset, a fixed one with its rows or a query. */
export function handleCreateDatasetByKey(request: Request, deps: RunsApiDeps): Promise<Response> {
  return forKey(deps, "create_dataset", async ({ projectId }, apiKeyId) => {
    const body = createDatasetSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const { rows: asked, query, ...details } = body.data;
    if (asked && query.kind !== "fixed") {
      return refuse(400, "invalid", "rows: a query dataset holds no row. A run resolves it.");
    }
    const rqlOff = await rqlRefusal(projectId, query, deps.experiments().traces);
    if (rqlOff) return refuse(STATUS[rqlOff.reason], rqlOff.reason, rqlOff.message);
    const rows = asked ? await newRows(projectId, asked, deps) : null;
    if (rows && !rows.ok) return refuse(404, "not_found", rows.message);
    const { datasets } = deps.catalog();
    const by = `key:${apiKeyId}`;
    const made = await datasets.create({ projectId, ...details, query, createdBy: by });
    if (made === "name_taken") {
      return refuse(409, "name_taken", "Another dataset of the project has this name.");
    }
    if (rows) await datasets.addRows(projectId, made.id, rows.rows, by);
    return reply(201, { v: 1, dataset: datasetView(made), rows: rows?.rows.length ?? 0 });
  });
}

/** POST /api/v1/evals/datasets/{dataset}/rows: adds rows to a fixed dataset. They count at once. */
export function handleAddRowsByKey(
  request: Request,
  wanted: string,
  deps: RunsApiDeps,
): Promise<Response> {
  return forKey(deps, "add_dataset_rows", async ({ projectId }, apiKeyId) => {
    const body = addRowsSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const { datasets } = deps.catalog();
    const id = await findDatasetId(projectId, wanted, datasets);
    if (id === null) return datasetNotFound();
    const rows = await newRows(projectId, body.data.rows, deps);
    if (!rows.ok) return refuse(404, "not_found", rows.message);
    const added = await datasets.addRows(projectId, id, rows.rows, `key:${apiKeyId}`);
    if (added === "not_found") return datasetNotFound();
    if (added === "not_fixed") {
      return refuse(409, "dataset_not_fixed", "A query dataset holds no row. A run resolves it.");
    }
    return reply(201, { v: 1, rows: added.map(({ id: rowId, name }) => ({ rowId, name })) });
  });
}

async function recentRuns(projectId: string, deps: RunsApiDeps) {
  const { experiments } = deps.experiments();
  const list = await experiments.list(projectId, HISTORY_RUNS);
  return Promise.all(
    list.map(async (experiment) => ({
      experiment,
      trials: await experiments.trials(experiment.id),
    })),
  );
}

async function oneRun(projectId: string, experimentId: string, deps: RunsApiDeps) {
  const { experiments } = deps.experiments();
  const experiment = await experiments.get(projectId, experimentId);
  return experiment ? { experiment, trials: await experiments.trials(experiment.id) } : null;
}

async function findEval(
  projectId: string,
  wanted: string,
  evals: EvalStore,
): Promise<EvalDefinition | null> {
  const byName = await evals.getByName(projectId, wanted);
  if (byName) return byName;
  return z.uuid().safeParse(wanted).success ? evals.get(projectId, wanted) : null;
}

async function findDatasetId(
  projectId: string,
  wanted: string,
  datasets: Pick<DatasetStore, "get" | "getByName">,
): Promise<string | null> {
  const byId = z.uuid().safeParse(wanted).success ? await datasets.get(projectId, wanted) : null;
  return (byId ?? (await datasets.getByName(projectId, wanted)))?.id ?? null;
}

/** The rows of a request as the store takes them. A sandbox run gives its input. */
async function newRows(
  projectId: string,
  rows: ReadonlyArray<z.output<typeof rowSchema>>,
  deps: RunsApiDeps,
): Promise<{ ok: true; rows: NewRow[] } | { ok: false; message: string }> {
  const made: NewRow[] = [];
  for (const row of rows) {
    if (row.kind === "values") {
      const { values, expectedOutput, name, labels } = row;
      made.push({
        kind: "values",
        name,
        ...(labels ? { labels } : {}),
        row: { values, expectedOutput },
      });
      continue;
    }
    const run = await deps.experiments().sandboxes.getRun(projectId, row.sandboxRunId);
    if (!run) return { ok: false, message: `There is no sandbox run ${row.sandboxRunId}.` };
    const found = rowOfSandboxRun(run);
    if (!found.ok) return found;
    made.push({
      kind: "trace",
      name: row.name,
      turnId: null,
      content: {
        input: found.input,
        earlierTurns: [],
        toolFixtures: [],
        expectedOutput: row.expectedOutput,
      },
      sourceOutput: found.output,
    });
  }
  return { ok: true, rows: made };
}

/** The scorers of a request with a definition each: a reference gets the one of the library. */
async function withDefinitions(
  projectId: string,
  scorers: ReadonlyArray<z.output<typeof scorerSchema>>,
  deps: RunsApiDeps,
) {
  const { library } = deps.experiments();
  const made = [];
  for (const scorer of scorers) {
    if ("definition" in scorer) {
      made.push(scorer);
      continue;
    }
    const found = await scorerFromRef(projectId, scorer, library);
    if (!found.ok) return found;
    made.push(found.scorer);
  }
  return { ok: true as const, scorers: made };
}

async function startedView(experiment: Experiment, subject: UsageSubject, deps: RunsApiDeps) {
  deps.advance(experiment);
  await deps.track(experiment, { surface: "api" });
  return {
    evalId: experiment.evalId,
    eval: experiment.evalVersions[0]?.name ?? null,
    experimentId: experiment.id,
    state: experiment.state,
    url: urlOf(
      { projectId: subject.projectId, id: experiment.id, evalId: experiment.evalId },
      deps,
    ),
  };
}

async function partView(part: EachRunPart, subject: UsageSubject, deps: RunsApiDeps) {
  if (!part.ok) {
    return { eval: part.eval, evalId: part.evalId, error: part.reason, message: part.message };
  }
  const started = await startedView(part.experiment, subject, deps);
  return {
    ...started,
    eval: part.eval,
    evalId: part.evalId,
    ...(part.note ? { note: part.note } : {}),
  };
}

/** An eval with no captured text: its references, its defaults and its matrix. */
function evalView(definition: EvalDefinition) {
  const version = currentVersion(definition);
  return {
    evalId: definition.id,
    name: definition.name,
    taskId: definition.taskId,
    version: version.number,
    datasetId: version.datasetId,
    sandboxName: version.sandboxName,
    sandboxVersionId: version.sandboxVersionId,
    params: version.params,
    matrix: version.matrix,
    trials: version.trials,
    scorers: version.scorers.map(({ id, name, gating, definition: { kind }, ref }) => ({
      id,
      name,
      gating,
      kind,
      source: ref?.source ?? "eval",
    })),
  };
}

function datasetView(dataset: Dataset) {
  return {
    datasetId: dataset.id,
    name: dataset.name,
    description: dataset.description,
    query: dataset.query,
    createdAt: dataset.createdAt.toISOString(),
    updatedAt: dataset.updatedAt.toISOString(),
  };
}

function invalid(error: z.ZodError): Response {
  const issue = error.issues[0];
  const where = issue?.path.join(".");
  return refuse(400, "invalid", `${where ? `${where}: ` : ""}${issue?.message ?? "Invalid."}`);
}

function datasetNotFound(): Response {
  return refuse(404, "dataset_not_found", "There is no such dataset.");
}
