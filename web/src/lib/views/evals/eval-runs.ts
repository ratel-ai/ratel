import type { UsageSubject } from "@/lib/contracts/usage-limits";
import { getLogger } from "@/lib/platform/logger";
import type { SandboxVersionSummary } from "@/lib/views/sandboxes";
import { refusedParam } from "@/lib/views/sandboxes/run-form";
import { resolveDataset } from "./datasets";
import type { EvalCase } from "./domain/case";
import { isQueryKind } from "./domain/dataset";
import {
  combinationCount,
  combinations,
  currentVersion,
  type EvalScorer,
  type EvalVersion,
  MAX_COMBINATIONS,
  type ParamMatrix,
  runProblem,
} from "./domain/eval";
import {
  type Experiment,
  freezeEvalRun,
  MAX_EXPERIMENT_TRIALS,
  type RunChanges,
  type Variant,
} from "./domain/experiment";
import {
  type ExperimentDeps,
  MAX_RUNNING_EXPERIMENTS,
  type StartExperimentResult,
  type StartRefusal,
} from "./experiments";
import type { NewRow } from "./ports/dataset-store";
import { resolveScorers } from "./scorer-library";

/**
 * A run of one eval (decision `runs-per-eval`). It reads the newest version of the eval, and takes
 * changes for this run only. It freezes the eval version, the rows that it read, a snapshot of each
 * scorer, the runtime version and one variant for each combination of the matrix.
 */
export type StartEvalRun = {
  /** The name or the id of the eval. */
  eval: string;
  startedBy: string;
  name?: string;
  changes?: EvalRunChanges;
};

export type EvalRunChanges = {
  /** Another dataset, for this run only. */
  datasetId?: string;
  /** More rows, for this run only. They are not rows of the dataset. */
  rows?: NewRow[];
  /** Other scorers, for this run only. A reference is resolved as for the eval. */
  scorers?: EvalScorer[];
  /** A version id, or `latest`: the newest ready version of the sandbox of the eval. */
  sandboxVersion?: string;
  /** They go over the default params of the eval. */
  params?: Record<string, unknown>;
  /** Replaces the matrix of the eval. `{}`: no matrix. */
  matrix?: ParamMatrix;
  trials?: number;
};

const LATEST_OF = 100;
const logger = getLogger("evals/eval-runs");

export async function startEvalRun(
  subject: UsageSubject,
  { eval: wanted, startedBy, name, changes = {} }: StartEvalRun,
  deps: ExperimentDeps,
): Promise<StartExperimentResult> {
  const { projectId, organizationId } = subject;
  if (!(await deps.sandboxes.enabled(projectId))) {
    return refused("sandboxes_off", "Ratel sandboxes are not on for this project.");
  }
  const definition = (await deps.evals.list(projectId)).find(
    (one) => one.name === wanted || one.id === wanted,
  );
  if (!definition) return refused("not_found", `There is no eval named "${wanted}".`);
  const version = currentVersion(definition);
  const runtime = await findRuntime(projectId, version, changes.sandboxVersion, deps);
  if (!runtime.ok) return runtime;
  const scorers = await resolveScorers(projectId, changes.scorers ?? version.scorers, deps.library);
  if (!scorers.ok) return refused("invalid_scorers", scorers.message);
  const problem = runProblem({ scorers: scorers.scorers });
  if (problem) return refused("invalid_scorers", problem);
  const params = { ...version.params, ...changes.params };
  const matrix = changes.matrix ?? version.matrix;
  const variants = variantsOf(runtime.version, params, matrix);
  if (!variants.ok) return variants;
  const datasetId = changes.datasetId ?? version.datasetId;
  const rows = await datasetRows(projectId, datasetId, startedBy, deps);
  if (!rows.ok) return rows;
  const added = changes.rows ?? [];
  const trials = changes.trials ?? version.trials;
  const count = (rows.rows.length + added.length) * Math.max(1, variants.variants.length) * trials;
  if (rows.rows.length + added.length === 0) {
    return refused("no_cases", "The dataset of the run has no row. Add a row first.");
  }
  if (count > MAX_EXPERIMENT_TRIALS) {
    return refused("too_many_trials", `An experiment has at most ${MAX_EXPERIMENT_TRIALS} trials.`);
  }
  const extra =
    added.length === 0
      ? []
      : await deps.datasets.addRunRows(projectId, datasetId, added, startedBy);
  if (extra === "not_found") return refused("not_found", "There is no such dataset.");
  const frozen = freezeEvalRun(definition, [...rows.rows, ...extra], scorers.scorers, {
    params,
    trials,
  });
  const experiment = await deps.experiments.create(
    {
      ...frozen,
      projectId,
      organizationId,
      evalId: definition.id,
      datasetId,
      variants: variants.variants,
      changes: changesOf(changes),
      sandboxVersionId: runtime.version.id,
      sandboxName: runtime.version.name,
      name: name ?? null,
      labelFilter: null,
      gitCommit: runtime.version.git?.commit ?? "",
      gitDirty: runtime.version.git?.dirty ?? false,
      params,
      trialsPerCase: trials,
      startedBy,
    },
    MAX_RUNNING_EXPERIMENTS,
  );
  if (!experiment) {
    const message = `The project has ${MAX_RUNNING_EXPERIMENTS} running experiments. Wait for one to end.`;
    return refused("too_many_running", message);
  }
  logEvalRun(experiment, count);
  return { ok: true, experiment };
}

/**
 * The runtime of the run: the version that the run names, else the version that the eval pins,
 * else the newest ready version of the sandbox of the eval.
 */
async function findRuntime(
  projectId: string,
  version: EvalVersion,
  asked: string | undefined,
  { sandboxes }: ExperimentDeps,
): Promise<{ ok: true; version: SandboxVersionSummary } | Refusal> {
  const wanted = asked ?? version.sandboxVersionId ?? "latest";
  const { sandboxName } = version;
  if (wanted === "latest") {
    const versions = await sandboxes.listVersions(projectId, LATEST_OF);
    const found = versions.find(
      ({ status, name }) => status === "ready" && (sandboxName === null || name === sandboxName),
    );
    if (found) return { ok: true, version: found };
    return sandboxName === null
      ? refused("not_ready", "No sandbox version is ready. Push one first.")
      : refused("not_ready", `No version of the sandbox ${sandboxName} is ready. Push one first.`);
  }
  const found = await sandboxes.getVersion(projectId, wanted);
  if (!found) return refused("not_found", "There is no such sandbox version.");
  if (sandboxName !== null && found.name !== sandboxName) {
    return refused(
      "wrong_sandbox",
      `The version is of the sandbox ${found.name}, and the eval runs on ${sandboxName}.`,
    );
  }
  if (found.status !== "ready") {
    return refused("not_ready", `The sandbox version is ${found.status}. Use one that is ready.`);
  }
  return { ok: true, version: found };
}

/** One variant for each combination, each checked against the declared params of the runtime. */
function variantsOf(
  runtime: SandboxVersionSummary,
  params: Record<string, unknown>,
  matrix: ParamMatrix,
): { ok: true; variants: Variant[] } | Refusal {
  const base = refusedParam(runtime.params, params);
  if (base) return refused("invalid_params", base);
  if (combinationCount(matrix) > MAX_COMBINATIONS) {
    return refused(
      "invalid_params",
      `The matrix has ${combinationCount(matrix)} combinations. A run has at most ${MAX_COMBINATIONS}.`,
    );
  }
  const variants = combinations(matrix).map((combination, index) => ({
    index,
    params: combination,
  }));
  for (const variant of variants) {
    const refusal = refusedParam(runtime.params, { ...params, ...variant.params });
    if (refusal) return refused("invalid_params", `The matrix: ${refusal}`);
  }
  return { ok: true, variants };
}

/** The rows of a fixed dataset, or the rows that a query dataset resolves now, kept for the run. */
async function datasetRows(
  projectId: string,
  datasetId: string,
  startedBy: string,
  { datasets, traces }: ExperimentDeps,
): Promise<{ ok: true; rows: EvalCase[] } | Refusal> {
  const dataset = await datasets.get(projectId, datasetId);
  if (!dataset) return refused("not_found", "There is no such dataset.");
  if (!isQueryKind(dataset.query)) {
    return { ok: true, rows: await datasets.rows(projectId, datasetId) };
  }
  const resolved = await resolveDataset(projectId, dataset.query, traces);
  if (!resolved.ok) {
    const reason: StartRefusal =
      resolved.reason === "no_rows" || resolved.reason === "not_a_query"
        ? "no_cases"
        : resolved.reason;
    return refused(reason, `The dataset "${dataset.name}": ${resolved.message}`);
  }
  return {
    ok: true,
    rows: await datasets.keepResolved(projectId, datasetId, resolved.rows, startedBy),
  };
}

/** What the run changed, as a record: no captured text. */
function changesOf(changes: EvalRunChanges): RunChanges {
  return {
    ...(changes.datasetId === undefined ? {} : { datasetId: changes.datasetId }),
    ...(changes.rows === undefined ? {} : { addedRows: changes.rows.length }),
    ...(changes.scorers === undefined ? {} : { scorers: true }),
    ...(changes.sandboxVersion === undefined ? {} : { sandboxVersionId: changes.sandboxVersion }),
    ...(changes.params === undefined ? {} : { params: changes.params }),
    ...(changes.matrix === undefined ? {} : { matrix: changes.matrix }),
    ...(changes.trials === undefined ? {} : { trials: changes.trials }),
  };
}

function logEvalRun(experiment: Experiment, trials: number): void {
  logger.info(
    {
      project_id: experiment.projectId,
      experiment_id: experiment.id,
      eval_id: experiment.evalId,
      cases: experiment.caseVersions.length,
      variants: experiment.variants.length,
      trials,
    },
    "eval run started",
  );
}

type Refusal = Extract<StartExperimentResult, { ok: false }>;

function refused(reason: StartRefusal, message: string): Refusal {
  return { ok: false, reason, message };
}
