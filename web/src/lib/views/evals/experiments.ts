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
import { resolveDataset } from "./datasets";
import { type CaseVersion, type EvalCase, runInputOf } from "./domain/case";
import { isQueryKind } from "./domain/dataset";
import { currentVersion, datasetOf, type EvalDefinition, runProblem } from "./domain/eval";
import {
  type Experiment,
  type FrozenSuite,
  freezeSuite,
  MAX_EXPERIMENT_TRIALS,
  paramsOfTrial,
  type Trial,
  type TrialOutcome,
  unscored,
} from "./domain/experiment";
import { type JudgeOutcome, scoreTrial, type TrialRecord } from "./domain/score";
import { type JudgeDeps, judgeTrial } from "./judge";
import type { CaseStore } from "./ports/case-store";
import type { DatasetStore } from "./ports/dataset-store";
import type { EvalStore } from "./ports/eval-store";
import type { ExperimentStore } from "./ports/experiment-store";
import type { ScorerLibrary } from "./ports/scorer-library";
import type { TraceSource } from "./ports/trace-source";

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
  cases: Pick<CaseStore, "list">;
  evals: Pick<EvalStore, "list">;
  datasets: Pick<DatasetStore, "get" | "getByName" | "keepResolved" | "rows" | "addRunRows">;
  library: ScorerLibrary;
  /** The traces that a query dataset resolves when a run starts. */
  traces: TraceSource;
  sandboxes: SandboxPort;
  judge: JudgeDeps;
  now: () => Date;
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
  | "no_content_access"
  | "query_failed"
  | "too_many_rows"
  | "invalid_scorers";

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
 * Freezes the evals, the newest version of each row of their datasets, and their scorers. A query
 * dataset is resolved now, and the run freezes the rows that it found. The suite is each eval of the sandbox
 * of the version (or of no sandbox). Chosen evals run by name. The trials start with
 * `advanceExperiment`.
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
  const [allEvals, allCases] = await Promise.all([
    deps.evals.list(projectId),
    deps.cases.list(projectId),
  ]);
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
  const resolved = await resolveQueryDatasets(projectId, chosen.evals, startedBy, deps);
  if (!resolved.ok) return resolved;
  const frozen = freezeSuite(chosen.evals, [...allCases, ...resolved.cases], label ?? null, {
    params,
    ...(trialsPerCase === undefined ? {} : { trials: trialsPerCase }),
  });
  const left = leftOut(chosen.evals, evals, frozen);
  if (left) return refused("no_cases", left);
  for (const { name: evalName, params: evalParams } of frozen.evalVersions) {
    const refusal = refusedParam(version.params, evalParams);
    if (refusal) return refused("invalid_params", `${evalName}: ${refusal}`);
  }
  const cases = frozen.caseVersions.length;
  if (cases === 0) {
    return label === undefined
      ? refused("no_cases", "No eval has a case and a gating scorer. Add a case first.")
      : refused("no_cases", `No case has the label ${label}.`);
  }
  const trials = totalTrials(frozen);
  if (trials > MAX_EXPERIMENT_TRIALS) {
    return refused("too_many_trials", `An experiment has at most ${MAX_EXPERIMENT_TRIALS} trials.`);
  }
  const input = {
    ...frozen,
    projectId,
    organizationId,
    evalId: null,
    datasetId: null,
    variants: [],
    changes: {},
    sandboxVersionId: version.id,
    sandboxName: version.name,
    name: name ?? null,
    labelFilter: label ?? null,
    // A version pushed with no git information has no commit.
    gitCommit: version.git?.commit ?? "",
    gitDirty: version.git?.dirty ?? false,
    params,
    trialsPerCase: trialsPerCase ?? Math.max(...frozen.evalVersions.map((one) => one.trials)),
    startedBy,
  };
  const experiment = await deps.experiments.create(input, MAX_RUNNING_EXPERIMENTS);
  if (!experiment) {
    const message = `The project has ${MAX_RUNNING_EXPERIMENTS} running experiments. Wait for one to end.`;
    return refused("too_many_running", message);
  }
  logger.info(
    {
      project_id: projectId,
      experiment_id: experiment.id,
      evals: frozen.evalVersions.length,
      cases,
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
  const score = scoreTrial(record, scorers, judged);
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
        params: paramsOfTrial(experiment, trial),
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

/**
 * The rows of each query dataset of the evals, resolved now and kept, one time for each dataset. A
 * refusal of one dataset refuses the run with its reason.
 */
async function resolveQueryDatasets(
  projectId: string,
  evals: readonly EvalDefinition[],
  startedBy: string,
  deps: ExperimentDeps,
): Promise<{ ok: true; cases: EvalCase[] } | Extract<StartExperimentResult, { ok: false }>> {
  const cases: EvalCase[] = [];
  for (const datasetId of new Set(evals.map(datasetOf))) {
    const dataset = await deps.datasets.get(projectId, datasetId);
    if (!dataset || !isQueryKind(dataset.query)) continue;
    const result = await resolveDataset(projectId, dataset.query, deps.traces);
    if (!result.ok) {
      const reason =
        result.reason === "no_rows" || result.reason === "not_a_query" ? "no_cases" : result.reason;
      return refused(reason, `The dataset "${dataset.name}": ${result.message}`);
    }
    cases.push(...(await deps.datasets.keepResolved(projectId, datasetId, result.rows, startedBy)));
  }
  return { ok: true, cases };
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

/** Why a chosen eval is not in the run, or null. The suite leaves such evals out. */
function leftOut(
  evals: readonly EvalDefinition[],
  names: readonly string[] | undefined,
  frozen: FrozenSuite,
): string | null {
  if (names === undefined) return null;
  const kept = new Set(frozen.evalVersions.map(({ evalId }) => evalId));
  const missing = evals.find(({ id }) => !kept.has(id));
  if (!missing) return null;
  const problem = runProblem(currentVersion(missing));
  return problem
    ? `The eval "${missing.name}" cannot run. ${problem}`
    : `The eval "${missing.name}" has no case. Add one first.`;
}

function totalTrials({ caseVersions, evalVersions }: FrozenSuite): number {
  const trials = new Map(evalVersions.map(({ evalId, trials: count }) => [evalId, count]));
  return caseVersions.reduce((sum, { evalId }) => sum + (trials.get(evalId ?? "") ?? 0), 0);
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
