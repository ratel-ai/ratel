import type { Trial } from "./domain/experiment";
import type { PairedTrial } from "./suite-view";

/** A trial and its run. The trial panel reads its output and tool calls, with the content rule. */
export type TrialSide = { runId: string; trial: Trial };

export type TrialPageModel = {
  projectId: string;
  caseId: string;
  caseName: string;
  evalId: string | null;
  /** The name of the eval as the run froze it. */
  evalName: string | null;
  candidate: TrialSide;
  /** The trial of the same row and index in the baseline run. Null when there is none. */
  baseline: TrialSide | null;
};

/** One trial and the trial of the same row and index in the baseline run of its eval. */
export function trialPageModel(
  projectId: string,
  paired: PairedTrial,
  runId: string,
  evalName: string | null = null,
): TrialPageModel {
  return {
    projectId,
    caseId: paired.caseId,
    caseName: paired.caseName,
    evalId: paired.evalId,
    evalName,
    candidate: { runId, trial: paired.trial },
    baseline:
      paired.baselineTrial && paired.baselineId
        ? { runId: paired.baselineId, trial: paired.baselineTrial }
        : null,
  };
}
