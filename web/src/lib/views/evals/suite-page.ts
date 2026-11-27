import type { Compared } from "./baseline";
import { approvedVersion, draftVersion, type EvalCase } from "./domain/case";
import type { CaseChange, CaseStatus } from "./domain/compare";
import { currentVersion, type EvalDefinition, type EvalScorer } from "./domain/eval";
import type { Counts, Trial } from "./domain/experiment";
import { deltaKey, type ScorerScore } from "./domain/suite";
import type { ExperimentRow } from "./page-model";
import { preview } from "./page-model";
import { evalHref, trialHref } from "./paths";
import {
  evalDetail,
  type PairedTrial,
  type SuiteRow,
  type SuiteVerdict,
  suiteTable,
} from "./suite-view";

/**
 * The page models of the evals pages (decision `suite-table`): the suite table (level 1), one
 * eval with its definition and its dataset (level 2), and one trial next to its baseline trial
 * (level 4). Plain data.
 */

/** A scorer of a row: its pass rate and its delta against the baseline. */
export type ScorerCell = {
  passRate: number | null;
  pass: number;
  /** The valid trials where the scorer gave a result. */
  rated: number;
  delta: number | null;
};

/** What a run did for an eval. Null when the run did not run the eval. */
export type RunCell = {
  score: number | null;
  counts: Counts;
  /** By the name of the scorer: the table has one column for each name. */
  scorers: Record<string, ScorerCell>;
  delta: number | null;
  /** Why there is no delta while there is a baseline. */
  deltaReason: string | null;
};

export type SuiteRowView = {
  /** Null for the cases of a run from before evals had definitions. */
  evalId: string | null;
  name: string;
  taskId: string | null;
  href: string | null;
  approvedCases: number;
  draftCases: number;
  run: RunCell | null;
};

export type RunOption = { id: string; label: string };

export type SuitePageModel = {
  projectId: string;
  /** The run that the table shows. Null: the project has no run yet. */
  runId: string | null;
  runState: Compared["experiment"]["state"] | null;
  runs: RunOption[];
  baselineId: string | null;
  verdict: SuiteVerdict | null;
  scorerColumns: string[];
  rows: SuiteRowView[];
};

export type DatasetRow = {
  caseId: string;
  name: string;
  approved: number | null;
  draft: number | null;
  input: string;
  expectedOutput: string | null;
  /** The output of the first trial of the case in the run, cut to `PREVIEW_CHARS`. */
  output: string | null;
  /** Null when the run did not run the case. */
  status: CaseStatus | null;
  change: CaseChange | null;
  scorers: Record<string, ScorerCell>;
  /** The trials of the case in the run, for level 3. */
  trials: Array<{ id: string; index: number; result: Trial["result"]; href: string }>;
};

export type EvalPageModel = {
  projectId: string;
  id: string;
  name: string;
  taskId: string | null;
  version: {
    id: string;
    number: number;
    sandboxName: string | null;
    params: Record<string, unknown>;
    trials: number;
    scorers: EvalScorer[];
  };
  runId: string | null;
  run: RunCell | null;
  dataset: DatasetRow[];
};

/** A trial and its run. The trial panel reads its output and tool calls, with the content rule. */
export type TrialSide = { runId: string; trial: Trial };

export type TrialPageModel = {
  projectId: string;
  caseId: string;
  caseName: string;
  evalId: string | null;
  candidate: TrialSide;
  /** The trial of the same row and index in the baseline run. Null when there is none. */
  baseline: TrialSide | null;
};

/** The suite table: one row for each eval of the project, with what the chosen run did. */
export function suitePageModel({
  projectId,
  evals,
  cases,
  runs,
  run,
  baseline,
}: {
  projectId: string;
  evals: readonly EvalDefinition[];
  cases: readonly EvalCase[];
  runs: readonly ExperimentRow[];
  run: Compared | null;
  baseline: Compared | null;
}): SuitePageModel {
  const table = run ? suiteTable(run, baseline) : null;
  const byEval = new Map(table?.rows.map((row) => [deltaKey(row), row]) ?? []);
  const datasets = Map.groupBy(cases, ({ evalId }) => evalId);
  const rows: SuiteRowView[] = evals.map((definition) => {
    const dataset = datasets.get(definition.id) ?? [];
    const row = byEval.get(definition.id);
    return {
      evalId: definition.id,
      name: definition.name,
      taskId: definition.taskId,
      href: evalHref(projectId, definition.id),
      approvedCases: dataset.filter((one) => approvedVersion(one)).length,
      draftCases: dataset.filter((one) => draftVersion(one)).length,
      run: row ? runCell(row, table?.baselineId ?? null) : null,
    };
  });
  const legacy = byEval.get(deltaKey({ evalId: null }));
  if (legacy) {
    rows.push({
      evalId: null,
      name: `${legacy.name} (a run from before evals had definitions)`,
      taskId: null,
      href: null,
      approvedCases: legacy.cases,
      draftCases: 0,
      run: runCell(legacy, table?.baselineId ?? null),
    });
  }
  return {
    projectId,
    runId: run?.experiment.id ?? null,
    runState: run?.experiment.state ?? null,
    runs: runs.map((one) => ({ id: one.id, label: runLabel(one) })),
    baselineId: table?.baselineId ?? null,
    verdict: table?.verdict ?? null,
    scorerColumns: table?.scorerColumns ?? [],
    rows,
  };
}

/** One eval: its definition, and its dataset with what the run did for each row. */
export function evalPageModel({
  projectId,
  definition,
  cases,
  run,
  baseline,
  outputs = new Map(),
}: {
  projectId: string;
  definition: EvalDefinition;
  cases: readonly EvalCase[];
  run: Compared | null;
  baseline: Compared | null;
  /** The cut output of each trial of the run, by the trial id. */
  outputs?: ReadonlyMap<string, string>;
}): EvalPageModel {
  const detail = run ? evalDetail(run, baseline, definition.id) : null;
  const inRun = new Map(detail?.cases.map((one) => [one.caseId, one]) ?? []);
  const trialsOf = (versionId: string) =>
    (run?.trials ?? [])
      .filter(({ caseVersionId }) => caseVersionId === versionId)
      .sort((a, b) => a.index - b.index);
  const { id, number, sandboxName, params, trials, scorers } = currentVersion(definition);
  return {
    projectId,
    id: definition.id,
    name: definition.name,
    taskId: definition.taskId,
    version: { id, number, sandboxName, params, trials, scorers },
    runId: run?.experiment.id ?? null,
    run: detail
      ? runCell(detail.row, detail.row.delta ? (baseline?.experiment.id ?? null) : null)
      : null,
    dataset: cases
      .filter(({ evalId }) => evalId === definition.id)
      .map((evalCase): DatasetRow => {
        const approved = approvedVersion(evalCase);
        const draft = draftVersion(evalCase);
        const shown = approved ?? draft;
        const scored = inRun.get(evalCase.id);
        const caseTrials = scored ? trialsOf(scored.versionId) : [];
        const first = caseTrials.find((trial) => outputs.has(trial.id));
        return {
          caseId: evalCase.id,
          name: evalCase.name,
          approved: approved?.number ?? null,
          draft: draft?.number ?? null,
          input: shown ? preview(shown.input) : "",
          expectedOutput: shown?.expectedOutput ? preview(shown.expectedOutput) : null,
          output: first ? (outputs.get(first.id) ?? null) : null,
          status: scored?.status ?? null,
          change: scored?.change ?? null,
          scorers: scored ? cellsOf(scored.scorers, null) : {},
          trials: caseTrials.map((trial) => ({
            id: trial.id,
            index: trial.index,
            result: trial.result,
            href: trialHref(projectId, run?.experiment.id ?? "", trial.id),
          })),
        };
      }),
  };
}

/** One trial and the trial of the same row and index in the baseline run. */
export function trialPageModel(
  projectId: string,
  paired: PairedTrial,
  runId: string,
): TrialPageModel {
  return {
    projectId,
    caseId: paired.caseId,
    caseName: paired.caseName,
    evalId: paired.evalId,
    candidate: { runId, trial: paired.trial },
    baseline:
      paired.baselineTrial && paired.baselineId
        ? { runId: paired.baselineId, trial: paired.baselineTrial }
        : null,
  };
}

function runCell(row: SuiteRow, baselineId: string | null): RunCell {
  const deltas = new Map(
    row.delta?.ok ? row.delta.scorers.map((one) => [one.scorerId, one.delta]) : [],
  );
  return {
    score: row.score,
    counts: row.counts,
    scorers: cellsOf(row.scorers, deltas),
    delta: row.delta?.ok ? row.delta.score : null,
    deltaReason: baselineId && row.delta && !row.delta.ok ? row.delta.message : null,
  };
}

function cellsOf(
  scorers: readonly ScorerScore[],
  deltas: ReadonlyMap<string, number | null> | null,
): Record<string, ScorerCell> {
  return Object.fromEntries(
    scorers.map((scorer) => [
      scorer.name,
      {
        passRate: scorer.passRate,
        pass: scorer.pass,
        rated: scorer.pass + scorer.fail,
        delta: deltas?.get(scorer.scorerId) ?? null,
      },
    ]),
  );
}

function runLabel(run: ExperimentRow): string {
  const when = run.createdAt.slice(0, 16).replace("T", " ");
  return `${when} · ${run.sandboxName}${run.commit ? ` · ${run.commit.slice(0, 7)}` : ""}`;
}
