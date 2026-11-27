import { z } from "zod";
import { refuse, reply } from "@/lib/console/scope/member-access";
import type { UsageSubject } from "@/lib/contracts/usage-limits";
import { storable } from "@/lib/platform/storable";
import { NO_CONTENT_MESSAGE } from "./datasets";
import { caseContentSchema, currentVersion as currentRow, type EvalCase } from "./domain/case";
import { MAX_ROW_LIMIT } from "./domain/dataset";
import { currentVersion, evalScorersSchema, MAX_SANDBOX_NAME_CHARS } from "./domain/eval";
import { type Experiment, MAX_TRIALS } from "./domain/experiment";
import type { CaseFromTurn } from "./domain/from-turn";
import { matrixInputSchema } from "./domain/matrix";
import {
  addRows,
  createDataset,
  type EvalsServiceDeps,
  findDataset,
  loadDataset,
  loadDatasets,
  loadEval,
  loadLibrary,
  loadOverview,
  newDatasetSchema,
  newEvalSchema,
} from "./evals-service";
import { type EachEvalResult, type ExperimentDeps, startEachEval } from "./experiments";
import { forKey, type KeyAccess, notFound, readJson, STATUS, urlOf } from "./experiments-api";

/**
 * The routes of a project key for datasets, evals, the scorer library and runs of one eval
 * (`protocol/evals/v1`, decision `runs-per-eval`). The reads have no captured text: a row of a
 * dataset shows its name, labels and source, not its input. The writes go through the same
 * actions as the MCP operations (`evals-service.ts`, `experiments.ts`).
 */
export type ModelApiDeps = KeyAccess & {
  service: () => EvalsServiceDeps;
  experiments: () => ExperimentDeps;
  /** The first step of a new run, after the response. */
  advance: (experiment: Experiment) => void;
  track: (experiment: Experiment, by: { surface: string }) => Promise<void>;
  publicUrl: (path: string) => string;
  /** Whether the project lets Ratel read the captured text of its traces. */
  readContent: (projectId: string) => Promise<boolean>;
  /** A row made from a turn. Null when the turn is not there or has no input. */
  turnRow: (projectId: string, turnId: string) => Promise<CaseFromTurn | null>;
};

const nameParam = z.string().trim().min(1).max(200);
const startRunsSchema = z.object({
  /** The evals to run, by name or id. Absent: each eval of the sandbox (or of the project). */
  evals: z.array(nameParam).min(1).max(100).optional(),
  /** The sandbox of the caller (the `name` of its ratel.yaml). */
  sandbox: z.string().trim().min(1).max(MAX_SANDBOX_NAME_CHARS).optional(),
  /** A version id, or `latest`. A version applies only to the evals of its sandbox. */
  sandboxVersion: z.union([z.literal("latest"), z.uuid()]).optional(),
  dataset: nameParam.optional(),
  rows: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200).optional(),
        input: z.unknown(),
        expectedOutput: z.string().max(20_000).nullable().optional(),
      }),
    )
    .max(MAX_ROW_LIMIT)
    .optional(),
  scorers: evalScorersSchema.optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  matrix: matrixInputSchema.optional(),
  trials: z.number().int().min(1).max(MAX_TRIALS).optional(),
  label: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200).optional(),
});

const addRowsSchema = z.object({
  rows: z
    .array(
      z.union([
        z.object({
          turnId: z.uuid(),
          name: z.string().trim().min(1).max(200).optional(),
          labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
        }),
        z.object({
          name: z.string().trim().min(1).max(200),
          labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
          input: z.unknown(),
          expectedOutput: z.string().max(20_000).nullable().optional(),
        }),
      ]),
    )
    .min(1)
    .max(50),
});

export function handleListDatasetsByKey(deps: ModelApiDeps): Promise<Response> {
  return forKey(deps, "list_datasets", async ({ projectId }) =>
    reply(200, { datasets: await loadDatasets(projectId, deps.service()) }),
  );
}

export function handleGetDatasetByKey(datasetId: string, deps: ModelApiDeps): Promise<Response> {
  return forKey(deps, "get_dataset", async ({ projectId }) => {
    const found = await loadDataset(projectId, datasetId, deps.service());
    if (!found) return notFound();
    const { dataset, rows, evals } = found;
    return reply(200, {
      datasetId: dataset.id,
      name: dataset.name,
      definition: dataset.definition,
      evals,
      rows: rows.map(rowView),
      updatedAt: dataset.updatedAt.toISOString(),
    });
  });
}

export function handleCreateDatasetByKey(request: Request, deps: ModelApiDeps): Promise<Response> {
  return forKey(deps, "create_dataset", async ({ projectId }, apiKeyId) => {
    const body = newDatasetSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const made = await createDataset(projectId, body.data, `key:${apiKeyId}`, deps.service());
    if (made === "name_taken") {
      return refuse(409, "name_taken", "Another dataset of the project has this name.");
    }
    return reply(201, { datasetId: made.id, name: made.name, definition: made.definition });
  });
}

/** Adds rows to a fixed dataset: trace turns (a copy of each) or typed values. */
export function handleAddRowsByKey(
  request: Request,
  datasetId: string,
  deps: ModelApiDeps,
): Promise<Response> {
  return forKey(deps, "add_dataset_rows", async ({ projectId }, apiKeyId) => {
    const body = addRowsSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const service = deps.service();
    const dataset = await findDataset(projectId, datasetId, service.datasets);
    if (!dataset) return notFound();
    const fromTurns = body.data.rows.some((row) => "turnId" in row);
    if (fromTurns && !(await deps.readContent(projectId))) {
      return refuse(403, "no_content_access", NO_CONTENT_MESSAGE);
    }
    const rows = [];
    for (const row of body.data.rows) {
      if ("turnId" in row) {
        const made = await deps.turnRow(projectId, row.turnId);
        if (!made) return refuse(422, "no_input", `The turn ${row.turnId} has no captured input.`);
        const content = caseContentSchema.safeParse(storable(made.content));
        if (!content.success) return invalid(content.error);
        rows.push({
          name: row.name ?? made.name,
          labels: row.labels ?? [],
          content: content.data,
          source: { turnId: row.turnId, output: made.sourceOutput },
        });
        continue;
      }
      const content = caseContentSchema.safeParse(
        storable({ input: row.input, expectedOutput: row.expectedOutput ?? null }),
      );
      if (!content.success) return invalid(content.error);
      if (content.data.input === null) return refuse(422, "no_input", "Give each row an input.");
      rows.push({ name: row.name, labels: row.labels ?? [], content: content.data });
    }
    const added = await addRows(projectId, dataset.id, rows, `key:${apiKeyId}`, service);
    if (added === "eval_not_found") return notFound();
    if (added === "not_fixed") {
      return refuse(
        409,
        "not_fixed",
        "A query dataset has no rows of its own. Add rows to a fixed dataset.",
      );
    }
    return reply(201, { datasetId: dataset.id, rows: added.map(rowView) });
  });
}

export function handleListEvalsByKey(deps: ModelApiDeps): Promise<Response> {
  return forKey(deps, "list_evals", async ({ projectId }) =>
    reply(200, await loadOverview(projectId, deps.service())),
  );
}

export function handleGetEvalByKey(evalId: string, deps: ModelApiDeps): Promise<Response> {
  return forKey(deps, "get_eval", async ({ projectId }) => {
    const found = await loadEval(projectId, evalId, deps.service());
    if (!found) return notFound();
    const { definition, dataset, runs } = found;
    const version = currentVersion(definition);
    const { evalId: _, name: __, runs: rows, ...series } = runs;
    return reply(200, {
      evalId: definition.id,
      name: definition.name,
      taskId: definition.taskId,
      version: {
        number: version.number,
        datasetId: version.datasetId,
        sandboxName: version.sandboxName,
        sandboxVersionId: version.sandboxVersionId,
        params: version.params,
        matrix: version.matrix,
        trials: version.trials,
        scorers: version.scorers,
      },
      dataset: dataset && {
        datasetId: dataset.id,
        name: dataset.name,
        kind: dataset.definition.kind,
      },
      ...series,
      runs: rows.map((run) => ({
        ...run,
        url: urlOf({ projectId, id: run.runId }, deps),
      })),
    });
  });
}

export function handleCreateEvalByKey(request: Request, deps: ModelApiDeps): Promise<Response> {
  return forKey(deps, "create_eval", async ({ projectId }, apiKeyId) => {
    const body = newEvalSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const service = deps.service();
    const made = await service.evals.create({
      ...body.data,
      projectId,
      createdBy: `key:${apiKeyId}`,
    });
    if (made === "name_taken") {
      return refuse(409, "name_taken", "Another eval of the project has this name.");
    }
    if (made === "dataset_not_found") {
      return refuse(404, "dataset_not_found", "The project has no such dataset.");
    }
    const version = currentVersion(made);
    return reply(201, {
      evalId: made.id,
      name: made.name,
      version: version.number,
      datasetId: version.datasetId,
    });
  });
}

export function handleLibraryByKey(deps: ModelApiDeps): Promise<Response> {
  return forKey(deps, "list_scorer_library", async ({ projectId }) =>
    reply(200, { scorers: await loadLibrary(projectId, deps.service()) }),
  );
}

/** Starts one run for each eval, or for each eval named, with the changes for these runs only. */
export function handleStartRunsByKey(request: Request, deps: ModelApiDeps): Promise<Response> {
  return forKey(deps, "start_runs", async (subject, apiKeyId) => {
    const body = startRunsSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    return startRuns(subject, body.data, `key:${apiKeyId}`, deps);
  });
}

async function startRuns(
  subject: UsageSubject,
  body: z.output<typeof startRunsSchema>,
  startedBy: string,
  deps: ModelApiDeps,
): Promise<Response> {
  const {
    evals,
    sandbox,
    sandboxVersion,
    label,
    name,
    dataset,
    rows,
    scorers,
    params,
    matrix,
    trials,
  } = body;
  const result = await startEachEval(
    subject,
    {
      ...(evals ? { evals } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(label ? { label } : {}),
      ...(name ? { name } : {}),
      startedBy,
      changes: {
        ...(sandboxVersion ? { sandboxVersion } : {}),
        ...(dataset ? { dataset } : {}),
        ...(rows ? { rows } : {}),
        ...(scorers ? { scorers } : {}),
        ...(params ? { params } : {}),
        ...(matrix ? { matrix } : {}),
        ...(trials === undefined ? {} : { trials }),
      },
    },
    deps.experiments(),
  );
  if (!result.ok) return refuse(STATUS[result.reason], result.reason, result.message);
  const started = result.runs.flatMap(({ result: one }) => (one.ok ? [one.experiment] : []));
  for (const experiment of started) {
    deps.advance(experiment);
    await deps.track(experiment, { surface: "api" });
  }
  const view = (entry: EachEvalResult) =>
    entry.result.ok
      ? {
          evalId: entry.evalId,
          eval: entry.name,
          experimentId: entry.result.experiment.id,
          state: entry.result.experiment.state,
          url: urlOf(entry.result.experiment, deps),
          variants: Math.max(1, entry.result.experiment.variants.length),
          ...(entry.note ? { note: entry.note } : {}),
        }
      : {
          evalId: entry.evalId,
          eval: entry.name,
          error: entry.result.reason,
          message: entry.result.message,
          ...(entry.note ? { note: entry.note } : {}),
        };
  const runs = result.runs.map(view);
  const skipped = result.skipped.map(view);
  if (started.length === 0) {
    const first = result.runs.find(({ result: one }) => !one.ok);
    if (first && !first.result.ok) {
      return reply(STATUS[first.result.reason], {
        error: first.result.reason,
        message: first.result.message,
        runs,
        skipped,
      });
    }
  }
  return reply(201, { runs, skipped });
}

/** A row of a dataset with no captured text: the key reads counts and ids, not content. */
function rowView(row: EvalCase) {
  const version = currentRow(row);
  return {
    caseId: row.id,
    name: row.name,
    labels: row.labels,
    version: version?.number ?? null,
    sourceTurnId: version?.sourceTurnId ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function invalid(error: z.ZodError): Response {
  const issue = error.issues[0];
  const where = issue?.path.join(".");
  return refuse(400, "invalid", `${where ? `${where}: ` : ""}${issue?.message ?? "Invalid."}`);
}
