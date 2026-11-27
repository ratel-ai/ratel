import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import type { UsageSubject } from "@/lib/contracts/usage-limits";
import { getLogger } from "@/lib/platform/logger";
import type {
  SandboxRun,
  SandboxVersionSummary,
  StartRunOptions,
  StartRunResult,
} from "@/lib/views/sandboxes";
import { EVAL_TRIAL_PREFIX } from "@/lib/views/sandboxes/domain/run";
import { refusedParam } from "@/lib/views/sandboxes/run-form";
import { type DatasetRow, type ResolveRefusal, resolveDataset } from "./datasets";
import { type CaseVersion, caseContentSchema, runInputOf } from "./domain/case";
import {
  type Dataset,
  type FrozenDataset,
  MAX_ROW_LIMIT,
  type ResolvedRow,
  tooManyRows,
} from "./domain/dataset";
import {
  currentVersion,
  type EvalDefinition,
  type EvalScorerRef,
  evalScorersSchema,
  type FrozenEval,
  freezeEval,
  MAX_JUDGES,
  runProblem,
} from "./domain/eval";
import {
  type Experiment,
  type FrozenCase,
  type FrozenSuite,
  frozenCase,
  MAX_EXPERIMENT_TRIALS,
  paramsOfTrial,
  type RunChanges,
  type Trial,
  type TrialOutcome,
  unscored,
  type Variant,
} from "./domain/experiment";
import { combinations, type Matrix, matrixProblem } from "./domain/matrix";
import {
  type JudgeOutcome,
  type ScorerSnapshot,
  scoreTrial,
  snapshotOf,
  type TrialRecord,
} from "./domain/score";
import { resolveScorers } from "./domain/scorer-library";
import { type JudgeDeps, judgeTrial } from "./judge";
import type { CaseStore } from "./ports/case-store";
import type { DatasetSources } from "./ports/dataset-sources";
import type { DatasetStore } from "./ports/dataset-store";
import type { EvalStore } from "./ports/eval-store";
import type { ExperimentStore, NewRunRow } from "./ports/experiment-store";
import type { ScorerLibraryPort } from "./ports/scorer-library";

/** The public interface of the sandboxes module, as an experiment uses it. */
export type SandboxPort = {
  enabled: (projectId: string) => Promise<boolean>;
  listVersions: (projectId: string, limit: number) => Promise<SandboxVersionSummary[]>;
  getVersion: (projectId: string, versionId: string) => Promise<SandboxVersionSummary | null>;
  startRun: (
    versionId: string,
    input: unknown,
    options: StartRunOptions,
  ) => Promise<StartRunResult>;
  getRun: (projectId: string, runId: string) => Promise<SandboxRun | null>;
};

export type ExperimentDeps = {
  experiments: ExperimentStore;
  cases: Pick<CaseStore, "list" | "listDataset">;
  evals: Pick<EvalStore, "list">;
  datasets: Pick<DatasetStore, "get" | "getByName">;
  /** What a query dataset reads of the traces, the tasks and RQL. */
  sources: DatasetSources;
  /** The project's scorers of the scorer library. */
  library: ScorerLibraryPort;
  sandboxes: SandboxPort;
  judge: JudgeDeps;
  now: () => Date;
  /** The id of a new row of a run. */
  newId?: () => string;
};

export type StartExperiment = {
  /**
   * A version id, or `latest`: the newest ready version of the sandbox of the run. That sandbox is
   * `sandbox`, else the sandbox of the evals named, else the sandbox of the newest ready version.
   */
  sandboxVersion: string;
  /** The name of the sandbox of the run (the `name` of its ratel.yaml). */
  sandbox?: string;
  /** The trials of each case. Absent: the trials of its eval. */
  trialsPerCase?: number;
  /** The params of the run. They go over the default params of each eval. */
  params: Record<string, unknown>;
  /** The names of the evals to run. Absent: the suite, each eval of the sandbox. */
  evals?: string[];
  startedBy: string;
  /** Only the cases with this label. All of them when it is not there. */
  label?: string;
  name?: string;
};

/** A row that a run adds for itself: typed values. */
export type ExtraRow = {
  name?: string;
  input: unknown;
  expectedOutput?: string | null;
};

/** What one run changes for itself only (decision `runs-per-eval`). The eval does not change. */
export type EvalRunChanges = {
  /** Another dataset, by its id or its name. */
  dataset?: string;
  /** Rows that the run adds to the rows of the dataset. */
  rows?: ExtraRow[];
  /** Other scorers of the library. */
  scorers?: EvalScorerRef[];
  /** A version id of the sandbox of the eval, or `latest`. */
  sandboxVersion?: string;
  /** Values that go over the default params of the eval. */
  params?: Record<string, unknown>;
  /** Another matrix. `{}` runs with no matrix. */
  matrix?: Matrix;
  trials?: number;
};

export type StartEvalRun = {
  /** The eval, by its id or its name. */
  eval: string;
  changes?: EvalRunChanges;
  /** The sandbox of the caller: `latest` uses it for an eval that names no sandbox. */
  sandbox?: string;
  startedBy: string;
  /** Only the rows of a fixed dataset with this label. */
  label?: string;
  name?: string;
};

export type StartEachEval = Omit<StartEvalRun, "eval"> & {
  /** The evals, by id or name. Absent: each eval of `sandbox` (or of the project with none). */
  evals?: string[];
};

/** The run of one eval when a run starts for each eval. */
export type EachEvalResult = {
  evalId: string;
  name: string;
  result: StartExperimentResult;
  /** Why a change of the request did not apply to this eval, or null. */
  note: string | null;
};

export type StartExperimentResult =
  | { ok: true; experiment: Experiment }
  | { ok: false; reason: StartRefusal; message: string };
export type StartRefusal =
  | "sandboxes_off"
  | "not_found"
  | "not_ready"
  | "no_cases"
  | "too_many_running"
  | "too_many_trials"
  | "invalid_params"
  | "wrong_sandbox"
  | "invalid_matrix"
  | "invalid_scorers"
  | "invalid_rows"
  | Exclude<ResolveRefusal, "no_cases">;

/** The open trials of one project at a time. The others wait. */
export const OPEN_TRIALS = 20;
/** A claim that is older than this was left by a process that ended. */
export const CLAIM_STOPPED_MS = 10 * 60_000;
/** The running experiments of one project. */
export const MAX_RUNNING_EXPERIMENTS = 10;
const PARALLEL = 5;
const LATEST_OF = 100;

const logger = getLogger("evals/experiments");

/**
 * A suite run of `protocol/evals/v1` (`POST /evals/experiments`): each chosen eval, or each eval of
 * the sandbox, in one experiment, with the default params of each eval and the params of the run
 * over them. A matrix of an eval does not apply: a run of one eval (`startEvalRun`) has it. The
 * trials start with `advanceExperiment`.
 */
export async function startExperiment(
  subject: UsageSubject,
  {
    sandboxVersion,
    sandbox,
    trialsPerCase,
    params,
    startedBy,
    label,
    name,
    evals,
  }: StartExperiment,
  deps: ExperimentDeps,
): Promise<StartExperimentResult> {
  const { projectId, organizationId } = subject;
  if (!(await deps.sandboxes.enabled(projectId))) {
    return refused("sandboxes_off", "Ratel sandboxes are not on for this project.");
  }
  const allEvals = await deps.evals.list(projectId);
  const found = await findVersion(projectId, sandboxVersion, sandbox, allEvals, evals, deps);
  if (!found.ok) return found;
  const { version } = found;
  if (version.status !== "ready") {
    return refused("not_ready", `The sandbox version is ${version.status}. Use one that is ready.`);
  }
  const runRefusal = refusedParam(version.params, params);
  if (runRefusal) return refused("invalid_params", runRefusal);
  const chosen = chooseEvals(allEvals, evals, version.name);
  if (!chosen.ok) return chosen;
  const frozen: FrozenSuite = { caseVersions: [], evalVersions: [], scorerSnapshots: {} };
  const runRows: NewRunRow[] = [];
  for (const definition of chosen.evals) {
    const prepared = await prepareEval(
      projectId,
      definition,
      { params, ...(trialsPerCase === undefined ? {} : { trials: trialsPerCase }), matrix: {} },
      label ?? null,
      deps,
    );
    if (!prepared.ok) {
      // The suite leaves out an eval that cannot run. A chosen eval is refused.
      if (evals === undefined && SKIPPED.has(prepared.reason)) continue;
      // v1 calls an eval that cannot run `no_cases`.
      const reason = prepared.reason === "invalid_scorers" ? "no_cases" : prepared.reason;
      return refused(reason, `The eval "${definition.name}" cannot run. ${prepared.message}`);
    }
    const refusal = refusedParam(version.params, prepared.frozenEval.params);
    if (refusal) return refused("invalid_params", `${definition.name}: ${refusal}`);
    // A suite run of v1 has no matrix: each eval runs with its default params.
    const { matrix: _, ...frozenEval } = prepared.frozenEval;
    frozen.evalVersions.push(frozenEval);
    for (const one of prepared.cases) {
      frozen.caseVersions.push(one);
      frozen.scorerSnapshots[one.versionId] = prepared.snapshots;
    }
    runRows.push(...prepared.runRows);
  }
  const cases = frozen.caseVersions.length;
  if (cases === 0) {
    return label === undefined
      ? refused("no_cases", "No eval has a case and a gating scorer. Add a case first.")
      : refused("no_cases", `No case has the label ${label}.`);
  }
  const trials = totalTrials(frozen, 1);
  if (trials > MAX_EXPERIMENT_TRIALS) {
    return refused("too_many_trials", `An experiment has at most ${MAX_EXPERIMENT_TRIALS} trials.`);
  }
  const input = {
    ...frozen,
    projectId,
    organizationId,
    evalId: null,
    sandboxVersionId: version.id,
    sandboxName: version.name,
    name: name ?? null,
    labelFilter: label ?? null,
    // A version pushed with no git information has no commit.
    gitCommit: version.git?.commit ?? "",
    gitDirty: version.git?.dirty ?? false,
    params,
    trialsPerCase: trialsPerCase ?? Math.max(...frozen.evalVersions.map((one) => one.trials)),
    dataset: null,
    variants: [],
    changes: {},
    runRows,
    startedBy,
  };
  return create(input, trials, deps);
}

/**
 * Starts a run of one eval (decision `runs-per-eval`). It freezes the eval version, the rows of its
 * dataset (a query dataset is resolved now), a snapshot of each scorer of the library, the runtime
 * version and the variants of the matrix. The changes apply to this run only.
 */
export async function startEvalRun(
  subject: UsageSubject,
  start: StartEvalRun,
  deps: ExperimentDeps,
): Promise<StartExperimentResult> {
  const { projectId } = subject;
  if (!(await deps.sandboxes.enabled(projectId))) {
    return refused("sandboxes_off", "Ratel sandboxes are not on for this project.");
  }
  const all = await deps.evals.list(projectId);
  const definition = all.find((one) => one.id === start.eval || one.name === start.eval);
  if (!definition) return refused("not_found", `There is no eval named "${start.eval}".`);
  return startOne(subject, definition, start, deps);
}

/**
 * Starts one run for each eval: the evals named, else each eval of the sandbox of the caller (and
 * each eval with no sandbox), else each eval of the project. A version of one sandbox applies only
 * to the evals of that sandbox: each other eval runs on its own runtime, and its result says so.
 * An eval with no row or no gating scorer is left out when no eval is named.
 */
export async function startEachEval(
  subject: UsageSubject,
  start: StartEachEval,
  deps: ExperimentDeps,
): Promise<
  | { ok: true; runs: EachEvalResult[]; skipped: EachEvalResult[] }
  | Extract<StartExperimentResult, { ok: false }>
> {
  const { projectId } = subject;
  if (!(await deps.sandboxes.enabled(projectId))) {
    return refused("sandboxes_off", "Ratel sandboxes are not on for this project.");
  }
  const all = await deps.evals.list(projectId);
  const wantedVersion = start.changes?.sandboxVersion;
  const pinned =
    wantedVersion && wantedVersion !== "latest"
      ? await deps.sandboxes.getVersion(projectId, wantedVersion)
      : null;
  if (wantedVersion && wantedVersion !== "latest" && !pinned) {
    return refused("not_found", "There is no such sandbox version.");
  }
  // Only a sandbox that the caller names chooses the evals. A version does not: it applies to the
  // evals of its sandbox, and each other eval runs on its own runtime.
  const sandboxOfRun = start.sandbox ?? null;
  let chosen: EvalDefinition[];
  if (start.evals) {
    chosen = [];
    for (const wanted of new Set(start.evals)) {
      const found = all.find((one) => one.id === wanted || one.name === wanted);
      if (!found) return refused("not_found", `There is no eval named "${wanted}".`);
      chosen.push(found);
    }
  } else {
    chosen = all.filter((one) => {
      const own = currentVersion(one).sandboxName;
      return sandboxOfRun === null || own === null || own === sandboxOfRun;
    });
  }
  if (chosen.length === 0) {
    return refused(
      "not_found",
      sandboxOfRun
        ? `No eval runs on the sandbox ${sandboxOfRun}.`
        : "The project has no eval. Create one first.",
    );
  }
  const runs: EachEvalResult[] = [];
  const skipped: EachEvalResult[] = [];
  for (const definition of chosen) {
    const own = currentVersion(definition).sandboxName;
    // A version of another sandbox does not apply: the eval keeps its own runtime.
    const otherSandbox = pinned !== null && own !== null && own !== pinned.name;
    const changes: EvalRunChanges = { ...start.changes };
    if (otherSandbox) delete changes.sandboxVersion;
    const note = otherSandbox
      ? `The version ${pinned.id} is of the sandbox ${pinned.name}. This eval runs on the sandbox ${own}, so it used its own runtime.`
      : null;
    const result = await startOne(
      subject,
      definition,
      { ...start, eval: definition.id, changes },
      deps,
    );
    const entry = { evalId: definition.id, name: definition.name, result, note };
    if (!result.ok && start.evals === undefined && SKIPPED.has(result.reason)) skipped.push(entry);
    else runs.push(entry);
  }
  if (runs.length === 0) {
    const [first] = skipped;
    if (first && !first.result.ok) return refused(first.result.reason, first.result.message);
  }
  return { ok: true, runs, skipped };
}

/** The refusals that leave an eval out of a suite: it has no row, or no gating scorer. */
const SKIPPED: ReadonlySet<StartRefusal> = new Set(["no_cases", "invalid_scorers"]);

async function startOne(
  { projectId, organizationId }: UsageSubject,
  definition: EvalDefinition,
  start: StartEvalRun,
  deps: ExperimentDeps,
): Promise<StartExperimentResult> {
  const own = currentVersion(definition);
  const changes = start.changes ?? {};
  const runtime = await runtimeOf(
    projectId,
    definition,
    changes.sandboxVersion,
    start.sandbox,
    deps,
  );
  if (!runtime.ok) return runtime;
  const { version } = runtime;
  const prepared = await prepareEval(projectId, definition, changes, start.label ?? null, deps);
  if (!prepared.ok) return refused(prepared.reason, prepared.message);
  const declared = new Set(version.params.map(({ name }) => name));
  const matrix = prepared.frozenEval.matrix ?? {};
  const problem = matrixProblem(matrix, declared);
  if (problem) return refused("invalid_matrix", problem);
  const variants: Variant[] = combinations(matrix).map((values, index) => ({
    index,
    values,
    params: { ...prepared.frozenEval.params, ...values },
  }));
  for (const variant of variants) {
    const refusal = refusedParam(version.params, variant.params);
    if (refusal) return refused("invalid_params", refusal);
  }
  const frozen: FrozenSuite = {
    caseVersions: prepared.cases,
    evalVersions: [prepared.frozenEval],
    scorerSnapshots: Object.fromEntries(
      prepared.cases.map(({ versionId }) => [versionId, prepared.snapshots]),
    ),
  };
  const trials = totalTrials(frozen, variants.length);
  if (trials > MAX_EXPERIMENT_TRIALS) {
    return refused(
      "too_many_trials",
      `The run has ${trials} trials (rows times variants times trials). A run has at most ${MAX_EXPERIMENT_TRIALS}.`,
    );
  }
  const recorded: RunChanges = {
    ...(prepared.dataset.datasetId !== own.datasetId
      ? { datasetId: prepared.dataset.datasetId }
      : {}),
    ...(changes.rows?.length ? { extraRows: changes.rows.length } : {}),
    ...(changes.scorers ? { scorers: changes.scorers } : {}),
    ...(changes.sandboxVersion ? { sandboxVersionId: version.id } : {}),
    ...(changes.params ? { params: changes.params } : {}),
    ...(changes.matrix ? { matrix: changes.matrix } : {}),
    ...(changes.trials === undefined ? {} : { trials: changes.trials }),
  };
  return create(
    {
      ...frozen,
      projectId,
      organizationId,
      evalId: definition.id,
      sandboxVersionId: version.id,
      sandboxName: version.name,
      name: start.name ?? null,
      labelFilter: start.label ?? null,
      gitCommit: version.git?.commit ?? "",
      gitDirty: version.git?.dirty ?? false,
      params: prepared.frozenEval.params,
      trialsPerCase: prepared.frozenEval.trials,
      dataset: prepared.dataset,
      variants,
      changes: recorded,
      runRows: prepared.runRows,
      startedBy: start.startedBy,
    },
    trials,
    deps,
  );
}

type Prepared =
  | {
      ok: true;
      frozenEval: FrozenEval;
      cases: FrozenCase[];
      runRows: NewRunRow[];
      snapshots: ScorerSnapshot[];
      dataset: FrozenDataset;
    }
  | { ok: false; reason: StartRefusal; message: string };

/** The frozen version, rows and scorers of one eval for a run, with the changes of the run. */
async function prepareEval(
  projectId: string,
  definition: EvalDefinition,
  changes: EvalRunChanges,
  label: string | null,
  deps: ExperimentDeps,
): Promise<Prepared> {
  const own = currentVersion(definition);
  const refs = evalScorersSchema.safeParse(changes.scorers ?? own.scorers);
  if (!refs.success) {
    return {
      ok: false,
      reason: "invalid_scorers",
      message: refs.error.issues[0]?.message ?? "The scorers are not valid.",
    };
  }
  const gating = runProblem({ scorers: refs.data });
  if (gating) return { ok: false, reason: "invalid_scorers", message: gating };
  const scorers = resolveScorers(refs.data, await deps.library.projectScorers(projectId));
  if (!scorers.ok) return { ok: false, reason: "invalid_scorers", message: scorers.message };
  if (scorers.scorers.filter(({ definition: one }) => one.kind === "judge").length > MAX_JUDGES) {
    return {
      ok: false,
      reason: "invalid_scorers",
      message: `A run has at most ${MAX_JUDGES} judges.`,
    };
  }
  const dataset = await datasetOf(projectId, changes.dataset ?? own.datasetId, deps);
  if (!dataset) return { ok: false, reason: "not_found", message: "There is no such dataset." };
  const resolved = await resolveDataset(projectId, dataset, label, { ...deps, now: deps.now });
  if (!resolved.ok) return { ok: false, reason: resolved.reason, message: resolved.message };
  const extra = extraRows(changes.rows ?? []);
  if (!extra.ok) return { ok: false, reason: "invalid_rows", message: extra.message };
  const rows: DatasetRow[] = [
    ...resolved.rows,
    ...extra.rows.map((row) => ({ kind: "run" as const, row })),
  ];
  const over = tooManyRows(rows.length, MAX_ROW_LIMIT);
  if (over) return { ok: false, reason: "too_many_rows", message: over };
  if (rows.length === 0) {
    const why =
      resolved.skipped > 0
        ? `The dataset gave ${resolved.skipped} turns with no captured input, and no row.`
        : label === null
          ? `The dataset "${dataset.name}" has no row. Add one first.`
          : `No row of the dataset "${dataset.name}" has the label ${label}.`;
    return { ok: false, reason: "no_cases", message: why };
  }
  const newId = deps.newId ?? (() => randomUUID());
  const cases: FrozenCase[] = [];
  const runRows: NewRunRow[] = [];
  for (const row of rows) {
    if (row.kind === "case") {
      cases.push(frozenCase(row.evalCase, row.caseVersion, definition.id));
      continue;
    }
    const id = newId();
    runRows.push({ ...row.row, id });
    cases.push({
      caseId: row.row.sourceTurnId ?? id,
      versionId: id,
      number: 1,
      name: row.row.name,
      evalId: definition.id,
      row: "run",
    });
  }
  const frozenEval = {
    ...freezeEval(definition, {
      ...(changes.params ? { params: changes.params } : {}),
      ...(changes.trials === undefined ? {} : { trials: changes.trials }),
    }),
    matrix: changes.matrix ?? own.matrix,
  };
  return {
    ok: true,
    frozenEval,
    cases,
    runRows,
    snapshots: scorers.scorers.map(snapshotOf),
    dataset: {
      datasetId: dataset.id,
      name: dataset.name,
      kind: dataset.definition.kind,
      settings: (({ kind: _, ...settings }) => settings)(dataset.definition),
      rows: resolved.rows.length,
      resolvedAt: deps.now().toISOString(),
    },
  };
}

async function datasetOf(
  projectId: string,
  wanted: string | null,
  deps: ExperimentDeps,
): Promise<Dataset | null> {
  if (wanted === null) return null;
  const byId = z.uuid().safeParse(wanted).success
    ? await deps.datasets.get(projectId, wanted)
    : null;
  return byId ?? (await deps.datasets.getByName(projectId, wanted));
}

/** The rows that a run adds: typed values, checked as a row of a dataset is. */
function extraRows(
  rows: readonly ExtraRow[],
): { ok: true; rows: ResolvedRow[] } | { ok: false; message: string } {
  const out: ResolvedRow[] = [];
  for (const [index, row] of rows.entries()) {
    const content = caseContentSchema.safeParse({
      input: row.input,
      expectedOutput: row.expectedOutput ?? null,
    });
    if (!content.success || content.data.input === null) {
      return { ok: false, message: `The added row ${index + 1} has no input, or it is too large.` };
    }
    out.push({
      name: row.name ?? `Added row ${index + 1}`,
      content: content.data,
      sourceTurnId: null,
      sourceOutput: null,
    });
  }
  return { ok: true, rows: out };
}

/**
 * The runtime version of a run of one eval: the version that the run gives, else the version that
 * the eval pins, else the newest ready version of its sandbox. A version of another sandbox is
 * refused.
 */
async function runtimeOf(
  projectId: string,
  definition: EvalDefinition,
  wanted: string | undefined,
  sandboxOfCaller: string | undefined,
  { sandboxes }: ExperimentDeps,
): Promise<
  { ok: true; version: SandboxVersionSummary } | Extract<StartExperimentResult, { ok: false }>
> {
  const own = currentVersion(definition);
  const versionId =
    wanted && wanted !== "latest" ? wanted : wanted === "latest" ? null : own.sandboxVersionId;
  const sandbox = own.sandboxName ?? sandboxOfCaller ?? null;
  let version: SandboxVersionSummary | null;
  if (versionId) {
    version = await sandboxes.getVersion(projectId, versionId);
    if (!version) return refused("not_found", "There is no such sandbox version.");
    if (own.sandboxName !== null && version.name !== own.sandboxName) {
      return refused(
        "wrong_sandbox",
        `The version is of the sandbox ${version.name}. The eval "${definition.name}" runs on ${own.sandboxName}.`,
      );
    }
  } else {
    const versions = await sandboxes.listVersions(projectId, LATEST_OF);
    version =
      versions.find(
        ({ status, name }) => status === "ready" && (sandbox === null || name === sandbox),
      ) ?? null;
    if (!version) {
      return sandbox === null
        ? refused("not_ready", "No sandbox version is ready. Push one first.")
        : refused("not_ready", `No version of the sandbox ${sandbox} is ready. Push one first.`);
    }
  }
  if (version.status !== "ready") {
    return refused("not_ready", `The sandbox version is ${version.status}. Use one that is ready.`);
  }
  return { ok: true, version };
}

async function create(
  input: Parameters<ExperimentStore["create"]>[0],
  trials: number,
  deps: ExperimentDeps,
): Promise<StartExperimentResult> {
  const experiment = await deps.experiments.create(input, MAX_RUNNING_EXPERIMENTS);
  if (!experiment) {
    const message = `The project has ${MAX_RUNNING_EXPERIMENTS} running experiments. Wait for one to end.`;
    return refused("too_many_running", message);
  }
  logger.info(
    {
      project_id: input.projectId,
      experiment_id: experiment.id,
      eval_id: input.evalId,
      evals: input.evalVersions.length,
      cases: input.caseVersions.length,
      variants: Math.max(1, input.variants.length),
      trials,
    },
    "eval experiment started",
  );
  return { ok: true, experiment };
}

/**
 * One step of an experiment: scores the trials whose run ended, starts the next ones, and closes
 * the experiment when no trial is open. Two processes may do it at the same time. After the
 * deadline it takes no more trials, and the next step goes on.
 */
export function advanceExperiment(
  experiment: Experiment,
  deps: ExperimentDeps,
  deadline: Date | null = null,
): Promise<{ started: number; finished: number; closed: boolean }> {
  const attributes = {
    "project.id": experiment.projectId,
    "eval.experiment_id": experiment.id,
  };
  return withFeatureSpan(
    "evals",
    "advance_experiment",
    async () => {
      const { experiments } = deps;
      const stopped = new Date(deps.now().getTime() - CLAIM_STOPPED_MS);
      await experiments.releaseStoppedScorings(experiment.id, stopped);
      let finished = await experiments.endStoppedStarts(
        experiment.id,
        stopped,
        unscored("invalid", "The start was interrupted."),
      );
      const late = () => deadline !== null && deps.now() > deadline;
      const running = await experiments.listRunningTrials(experiment.id, OPEN_TRIALS);
      await inParallel(running, async (trial) => {
        if (late()) return;
        try {
          if (await finishTrial(experiment, trial, deps)) finished += 1;
        } catch (error) {
          // The claim ends after a time, and the next step tries again.
          logger.error(
            { project_id: experiment.projectId, trial_id: trial.id, err: error },
            "eval trial not scored",
          );
        }
      });
      const mayStart = !late() && (await deps.sandboxes.enabled(experiment.projectId));
      const starts = mayStart
        ? await experiments.claimStarts(experiment, OPEN_TRIALS, deps.now())
        : [];
      await inParallel(starts, (trial) => startTrial(experiment, trial, deps));
      const closed = await experiments.close(experiment.id, deps.now());
      return { started: starts.length, finished, closed };
    },
    { attributes },
  );
}

/** The experiment's frozen copy of the scorers, not the case, scores a trial. */
export async function scoreRun(
  experiment: Experiment,
  trial: Trial,
  version: CaseVersion,
  run: SandboxRun,
  deps: ExperimentDeps,
): Promise<TrialOutcome> {
  const { result } = run;
  if (run.status === "infra_error" || run.status === "timed_out" || !result) {
    return unscored("invalid", `${run.status}: ${run.reason ?? "The run has no result."}`, {
      traceId: run.traceId,
    });
  }
  const { usage } = result;
  const record: TrialRecord = {
    output: result.output ?? null,
    toolCalls: result.toolCalls,
    durationMs: usage.durationMs,
    costUsd: usage.costUsd ?? null,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
  };
  const base = {
    output: record.output,
    toolCalls: result.toolCalls.map(({ name, arguments: args, result: answer, error, source }) => ({
      name,
      arguments: args,
      ...(answer === undefined ? {} : { result: answer }),
      ...(error === undefined ? {} : { error }),
      source,
    })),
    costUsd: record.costUsd,
    durationMs: record.durationMs,
    traceId: run.traceId ?? result.traceId,
  };
  if (run.status !== "completed") {
    const error = result.error
      ? `${result.error.type}: ${result.error.message}`
      : "The agent failed.";
    return unscored("fail", error, base);
  }
  const scorers = experiment.scorerSnapshots[trial.caseVersionId] ?? [];
  const judged = new Map<string, JudgeOutcome>();
  // At the same time: a trial has a few judges, and each one can wait for its model.
  const judges = scorers.map(async ({ id, definition }) => {
    if (definition.kind !== "judge") return;
    const outcome = await judgeTrial(
      experiment,
      {
        question: definition.config.prompt,
        input: version.input,
        earlierTurns: version.earlierTurns,
        expectedOutput: version.expectedOutput,
        output: record.output,
        toolCalls: record.toolCalls,
      },
      deps.judge,
    );
    judged.set(id, outcome);
  });
  await Promise.all(judges);
  const score = scoreTrial(record, scorers, judged, version.expectedOutput);
  return { ...base, result: score.result, reason: score.invalidReason, scorers: score.scorers };
}

async function startTrial(
  experiment: Experiment,
  trial: Trial,
  deps: ExperimentDeps,
): Promise<void> {
  const { projectId, organizationId } = experiment;
  let sandboxRunId: string | undefined;
  try {
    const version = await deps.experiments.caseVersion(trial.caseVersionId);
    if (!version) throw new Error("the case version is missing");
    // The earlier turns are part of the input, not of the params.
    const started = await deps.sandboxes.startRun(
      experiment.sandboxVersionId,
      runInputOf(version),
      {
        projectId,
        organizationId,
        requestedBy: `${EVAL_TRIAL_PREFIX}${trial.id}`,
        params: paramsOfTrial(experiment, trial.caseVersionId, trial.variant),
        fixtures: version.toolFixtures,
      },
    );
    if (started.ok) {
      sandboxRunId = started.run.id;
      return await deps.experiments.markRunning(trial.id, sandboxRunId);
    }
    // A place gets free when a run ends. The other limits do not change in the time of a run.
    if (
      started.reason === "limit_reached" &&
      started.limit === "sandbox_concurrent_instances" &&
      started.max > 0
    ) {
      return await deps.experiments.releaseStart(trial.id);
    }
    const why =
      started.reason === "limit_reached" ? `${started.limit}: ${started.message}` : started.message;
    await deps.experiments.finish(trial.id, unscored("invalid", `The run was refused. ${why}`));
  } catch (error) {
    logger.error(
      { project_id: projectId, experiment_id: experiment.id, trial_id: trial.id, err: error },
      "eval trial not started",
    );
    const reason = sandboxRunId
      ? "The run started, and its trial was not saved."
      : "The run did not start.";
    await deps.experiments.finish(
      trial.id,
      unscored("invalid", reason, sandboxRunId ? { sandboxRunId } : {}),
    );
  }
}

/** Scores a trial whose run ended. False when the run has not ended, or another process has it. */
async function finishTrial(
  experiment: Experiment,
  trial: Trial,
  deps: ExperimentDeps,
): Promise<boolean> {
  const { projectId } = experiment;
  const run = trial.sandboxRunId
    ? await deps.sandboxes.getRun(projectId, trial.sandboxRunId)
    : null;
  if (run?.status === "queued" || run?.status === "running") return false;
  if (!(await deps.experiments.claimScoring(trial.id, deps.now()))) return false;
  const version = await deps.experiments.caseVersion(trial.caseVersionId);
  const outcome =
    run && version
      ? await scoreRun(experiment, trial, version, run, deps)
      : unscored("invalid", "The sandbox run is not there.");
  await deps.experiments.finish(trial.id, outcome);
  logger.info(
    {
      project_id: projectId,
      experiment_id: experiment.id,
      trial_id: trial.id,
      outcome: outcome.result,
    },
    "eval trial finished",
  );
  return true;
}

/** The evals with these names, or the suite of the sandbox. */
function chooseEvals(
  all: readonly EvalDefinition[],
  names: readonly string[] | undefined,
  sandboxName: string,
): { ok: true; evals: EvalDefinition[] } | Extract<StartExperimentResult, { ok: false }> {
  const ofSandbox = (one: EvalDefinition) => {
    const wanted = currentVersion(one).sandboxName;
    return wanted === null || wanted === sandboxName;
  };
  if (names === undefined) return { ok: true, evals: all.filter(ofSandbox) };
  const evals: EvalDefinition[] = [];
  for (const wanted of new Set(names)) {
    const found = all.find((one) => one.name === wanted || one.id === wanted);
    if (!found) return refused("not_found", `There is no eval named "${wanted}".`);
    if (!ofSandbox(found)) {
      const other = currentVersion(found).sandboxName;
      return refused(
        "wrong_sandbox",
        `The eval "${found.name}" runs on the sandbox ${other}, not on ${sandboxName}.`,
      );
    }
    evals.push(found);
  }
  return { ok: true, evals };
}

function totalTrials({ caseVersions, evalVersions }: FrozenSuite, variants: number): number {
  const trials = new Map(evalVersions.map(({ evalId, trials: count }) => [evalId, count]));
  return (
    caseVersions.reduce((sum, { evalId }) => sum + (trials.get(evalId ?? "") ?? 0), 0) * variants
  );
}

/**
 * The version of the run. `latest` is the newest ready version of the sandbox of the run, never of
 * another sandbox: a project can have more than one sandbox.
 */
async function findVersion(
  projectId: string,
  wanted: string,
  sandbox: string | undefined,
  all: readonly EvalDefinition[],
  names: readonly string[] | undefined,
  { sandboxes }: ExperimentDeps,
): Promise<
  { ok: true; version: SandboxVersionSummary } | Extract<StartExperimentResult, { ok: false }>
> {
  if (wanted !== "latest") {
    const version = await sandboxes.getVersion(projectId, wanted);
    if (!version) return refused("not_found", "There is no such sandbox version.");
    if (sandbox !== undefined && version.name !== sandbox) {
      return refused(
        "wrong_sandbox",
        `The version is of the sandbox ${version.name}, not of ${sandbox}.`,
      );
    }
    return { ok: true, version };
  }
  const ofRun = sandbox ?? sandboxOfEvals(all, names);
  if (ofRun !== null && typeof ofRun === "object") return ofRun;
  const versions = await sandboxes.listVersions(projectId, LATEST_OF);
  const version = versions.find(
    ({ status, name }) => status === "ready" && (ofRun === null || name === ofRun),
  );
  if (version) return { ok: true, version };
  return ofRun === null
    ? refused("not_ready", "No sandbox version is ready. Push one first.")
    : refused("not_ready", `No version of the sandbox ${ofRun} is ready. Push one first.`);
}

/** The one sandbox of the evals named, null when they name none, or a refusal for two or more. */
function sandboxOfEvals(
  all: readonly EvalDefinition[],
  names: readonly string[] | undefined,
): string | null | Extract<StartExperimentResult, { ok: false }> {
  if (names === undefined) return null;
  const named = all.filter((one) => names.includes(one.name) || names.includes(one.id));
  const found = new Set(named.flatMap((one) => currentVersion(one).sandboxName ?? []));
  if (found.size <= 1) return [...found][0] ?? null;
  return refused(
    "wrong_sandbox",
    `The evals run on more than one sandbox (${[...found].sort().join(", ")}). Run the evals of one sandbox at a time.`,
  );
}

async function inParallel<T>(items: T[], work: (item: T) => Promise<unknown>): Promise<void> {
  const queue = [...items];
  const lane = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await work(item);
  };
  await Promise.all(Array.from({ length: PARALLEL }, lane));
}

function refused(reason: StartRefusal, message: string) {
  return { ok: false as const, reason, message };
}
