import { runCheck } from "./check";
import { type JudgeDeps, judgeTraces } from "./judge";
import { scorePresetTraces } from "./preset";
import { countMatchingTraces, latestMatchingTraces } from "./traces";
import type { ScoreOutcome, ScorerDraft, ScorerTarget } from "./types";

/** How many traces a test runs on. */
export const PREVIEW_TRACES = 5;
const WEEK_MS = 7 * 86_400_000;

export interface PreviewResult {
  traceId: string;
  startedAt: string;
  outcome: ScoreOutcome;
}

export interface PreviewDeps {
  latest: typeof latestMatchingTraces;
  count: typeof countMatchingTraces;
  judge: typeof judgeTraces;
  preset: typeof scorePresetTraces;
  judgeDeps?: JudgeDeps;
}

const defaults: PreviewDeps = {
  latest: latestMatchingTraces,
  count: countMatchingTraces,
  judge: judgeTraces,
  preset: scorePresetTraces,
};

/**
 * Run a draft on the newest matching traces, the sample rate ignored, and store no result. A judge
 * spends from the daily budget here as it does in the sweep.
 */
export async function previewScorer(
  projectId: string,
  draft: ScorerDraft,
  deps: PreviewDeps = defaults,
): Promise<PreviewResult[]> {
  const traces = await deps.latest(projectId, draft, PREVIEW_TRACES);
  let outcomes: ScoreOutcome[];
  if (draft.kind === "check") {
    const { config } = draft;
    outcomes = traces.map((trace) => runCheck(config, trace));
  } else if (draft.kind === "preset") {
    outcomes = await deps.preset(projectId, draft.config, traces, draft.tasks ?? []);
  } else {
    outcomes = await deps.judge(projectId, draft.config, traces, deps.judgeDeps);
  }
  return traces.flatMap((trace, index) => {
    const outcome = outcomes[index];
    return outcome
      ? { traceId: trace.traceId, startedAt: trace.startedAt.toISOString(), outcome }
      : [];
  });
}

/** How many traces of the last 7 days a scorer takes. */
export function countLastWeek(
  projectId: string,
  target: ScorerTarget,
  now: Date = new Date(),
  deps: Pick<PreviewDeps, "count"> = defaults,
): Promise<number> {
  return deps.count(projectId, target, new Date(now.getTime() - WEEK_MS));
}
