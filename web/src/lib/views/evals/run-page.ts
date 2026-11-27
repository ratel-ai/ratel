import type { CaseVersion } from "./domain/case";
import {
  type Counts,
  countTrials,
  type Experiment,
  type Trial,
  type Variant,
} from "./domain/experiment";
import { runScore } from "./domain/suite";
import { paramsText } from "./eval-page";
import { preview } from "./page-model";
import { trialHref } from "./paths";

/**
 * One run of one eval as a grid (decision `runs-per-eval`): a row for each frozen row of the
 * dataset with its input and expected output, then for each variant the output and a column for
 * each scorer. A run with no matrix has one variant. A matrix run shows its variants side by side,
 * with their param values in the header. Plain data.
 */

export type RunVariantColumn = {
  index: number;
  /** "model=haiku, tone=formal". "This run" for a run with no matrix. */
  label: string;
  params: Record<string, unknown>;
  score: number | null;
  counts: Counts;
};

export type ScorerCell = { pass: number; rated: number };

export type RunTrialLink = { trialId: string; index: number; result: Trial["result"]; href: string };

export type RunVariantCell = {
  variant: number;
  /** The output of the first trial that has one, cut. Null when none has. */
  output: string | null;
  counts: Counts;
  /** By the scorer name. A scorer with no result in the cell is not there. */
  scorers: Record<string, ScorerCell>;
  trials: RunTrialLink[];
};

export type RunGridRow = {
  caseId: string;
  versionId: string;
  name: string;
  /** Cut. Empty when the row version is gone. */
  input: string;
  expectedOutput: string | null;
  cells: RunVariantCell[];
};

export type RunPageModel = {
  projectId: string;
  evalId: string;
  runId: string;
  name: string | null;
  state: Experiment["state"];
  at: string;
  sandboxName: string;
  sandboxVersionId: string;
  commit: string;
  score: number | null;
  counts: Counts;
  variants: RunVariantColumn[];
  scorers: Array<{ name: string; gating: boolean }>;
  rows: RunGridRow[];
};

export function runPageModel({
  projectId,
  evalId,
  experiment,
  trials,
  versions,
  outputs,
}: {
  projectId: string;
  evalId: string;
  experiment: Experiment;
  trials: readonly Trial[];
  /** The frozen row versions. */
  versions: readonly CaseVersion[];
  /** Outputs by trial id. */
  outputs: ReadonlyMap<string, string>;
}): RunPageModel {
  const frozen = experiment.caseVersions.filter(
    (one) => experiment.evalId === evalId || one.evalId === evalId,
  );
  const ofEval = new Set(frozen.map(({ versionId }) => versionId));
  const own = trials.filter(({ caseVersionId }) => ofEval.has(caseVersionId));
  const variants: Variant[] =
    experiment.variants.length > 0 ? experiment.variants : [{ index: 0, params: {} }];
  const matrix = experiment.variants.length > 0;
  const scored = runScore({
    experiment: { ...experiment, caseVersions: frozen },
    trials: own,
  });
  const byVersion = new Map(versions.map((version) => [version.id, version]));
  return {
    projectId,
    evalId,
    runId: experiment.id,
    name: experiment.name,
    state: experiment.state,
    at: experiment.createdAt.toISOString(),
    sandboxName: experiment.sandboxName,
    sandboxVersionId: experiment.sandboxVersionId,
    commit: experiment.gitCommit.slice(0, 7),
    score: scored.score,
    counts: countTrials(own),
    variants: variants.map((variant) => {
      const ofVariant = own.filter((trial) => trial.variant === variant.index);
      const score = scored.variants.find(
        (one) => (one.variant?.index ?? 0) === variant.index,
      )?.score;
      return {
        index: variant.index,
        label: matrix ? paramsText(variant.params) : "This run",
        params: variant.params,
        score: score?.score ?? null,
        counts: countTrials(ofVariant),
      };
    }),
    scorers: scorerColumns(experiment, frozen.map(({ versionId }) => versionId)),
    rows: frozen.map((row) => {
      const version = byVersion.get(row.versionId);
      const ofRow = own.filter(({ caseVersionId }) => caseVersionId === row.versionId);
      return {
        caseId: row.caseId,
        versionId: row.versionId,
        name: row.name,
        input: version ? preview(version.input) : "",
        expectedOutput: version?.expectedOutput ? preview(version.expectedOutput) : null,
        cells: variants.map((variant) => {
          const cell = ofRow
            .filter((trial) => trial.variant === variant.index)
            .sort((a, b) => a.index - b.index);
          const output = cell.map(({ id }) => outputs.get(id)).find((one) => one !== undefined);
          return {
            variant: variant.index,
            output: output === undefined ? null : preview(output),
            counts: countTrials(cell),
            scorers: scorerCells(cell),
            trials: cell.map((trial) => ({
              trialId: trial.id,
              index: trial.index,
              result: trial.result,
              href: trialHref(projectId, evalId, experiment.id, trial.id),
            })),
          };
        }),
      };
    }),
  };
}

/** The scorer names of the frozen rows, each one time. Gating when one row has it gating. */
function scorerColumns(experiment: Pick<Experiment, "scorerSnapshots">, versionIds: string[]) {
  const columns = new Map<string, { name: string; gating: boolean }>();
  for (const versionId of versionIds) {
    for (const { name, gating } of experiment.scorerSnapshots[versionId] ?? []) {
      const known = columns.get(name);
      columns.set(name, { name, gating: gating || (known?.gating ?? false) });
    }
  }
  return [...columns.values()];
}

function scorerCells(trials: readonly Pick<Trial, "scorers">[]): Record<string, ScorerCell> {
  const cells: Record<string, ScorerCell> = {};
  for (const { scorers } of trials) {
    for (const { name, status } of scorers) {
      const cell = cells[name] ?? { pass: 0, rated: 0 };
      cells[name] = cell;
      if (status === "pass") cell.pass += 1;
      if (status !== "not_scored") cell.rated += 1;
    }
  }
  return cells;
}
