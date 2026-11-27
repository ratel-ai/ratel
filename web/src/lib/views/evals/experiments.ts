import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import type { UsageSubject } from "@/lib/contracts/usage-limits";
import { getLogger } from "@/lib/platform/logger";
import type {
  SandboxRun,
  SandboxVersionSummary,
  StartRunOptions,
  StartRunResult,
} from "@/lib/views/sandboxes";
import type { CaseVersion } from "./domain/case";
import {
  type Experiment,
  freezeCases,
  MAX_EXPERIMENT_TRIALS,
  type Trial,
  type TrialOutcome,
  unscored,
} from "./domain/experiment";
import { type JudgeOutcome, scoreTrial, type TrialRecord } from "./domain/score";
import { type JudgeDeps, judgeTrial } from "./judge";
import type { CaseStore } from "./ports/case-store";
import type { ExperimentStore } from "./ports/experiment-store";

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
  sandboxes: SandboxPort;
  judge: JudgeDeps;
  now: () => Date;
};

export type StartExperiment = {
  /** A version id, or `latest`: the newest version that is ready. */
  sandboxVersion: string;
  trialsPerCase: number;
  params: Record<string, unknown>;
  startedBy: string;
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
  | "too_many_trials";

/** The open trials of one project at a time. The others wait. */
export const OPEN_TRIALS = 20;
/** A claim that is older than this was left by a process that ended. */
export const CLAIM_STOPPED_MS = 10 * 60_000;
/** The running experiments of one project. */
export const MAX_RUNNING_EXPERIMENTS = 10;
const PARALLEL = 5;
const LATEST_OF = 100;

const logger = getLogger("evals/experiments");

/** Freezes the approved cases and their scorers. The trials start with `advanceExperiment`. */
export async function startExperiment(
  subject: UsageSubject,
  { sandboxVersion, trialsPerCase, params, startedBy }: StartExperiment,
  deps: ExperimentDeps,
): Promise<StartExperimentResult> {
  const { projectId, organizationId } = subject;
  if (!(await deps.sandboxes.enabled(projectId))) {
    return refused("sandboxes_off", "Ratel sandboxes are not on for this project.");
  }
  const version = await findVersion(projectId, sandboxVersion, deps);
  if (!version) {
    return sandboxVersion === "latest"
      ? refused("not_ready", "No sandbox version is ready. Push one first.")
      : refused("not_found", "There is no such sandbox version.");
  }
  if (version.status !== "ready") {
    return refused("not_ready", `The sandbox version is ${version.status}. Use one that is ready.`);
  }
  const frozen = freezeCases(await deps.cases.list(projectId));
  const cases = frozen.caseVersions.length;
  if (cases === 0) return refused("no_cases", "No case is approved. Approve one first.");
  if (cases * trialsPerCase > MAX_EXPERIMENT_TRIALS) {
    return refused("too_many_trials", `An experiment has at most ${MAX_EXPERIMENT_TRIALS} trials.`);
  }
  const input = {
    ...frozen,
    projectId,
    organizationId,
    sandboxVersionId: version.id,
    sandboxName: version.name,
    gitCommit: version.git.commit,
    gitDirty: version.git.dirty,
    params,
    trialsPerCase,
    startedBy,
  };
  const experiment = await deps.experiments.create(input, MAX_RUNNING_EXPERIMENTS);
  if (!experiment) {
    const message = `The project has ${MAX_RUNNING_EXPERIMENTS} running experiments. Wait for one to end.`;
    return refused("too_many_running", message);
  }
  logger.info(
    { project_id: projectId, experiment_id: experiment.id, cases, trials: cases * trialsPerCase },
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
    const { input, earlierTurns, toolFixtures } = version;
    const started = await deps.sandboxes.startRun(experiment.sandboxVersionId, input, {
      projectId,
      organizationId,
      requestedBy: `eval_trial:${trial.id}`,
      params: earlierTurns.length > 0 ? { ...experiment.params, earlierTurns } : experiment.params,
      fixtures: toolFixtures,
    });
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

async function findVersion(projectId: string, wanted: string, { sandboxes }: ExperimentDeps) {
  if (wanted !== "latest") return sandboxes.getVersion(projectId, wanted);
  const versions = await sandboxes.listVersions(projectId, LATEST_OF);
  return versions.find(({ status }) => status === "ready") ?? null;
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
