import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import { runCheck } from "./check";
import { type JudgeDeps, judgeTraces } from "./judge";
import { countMatchingTraces, latestMatchingTraces } from "./traces";
import type { ScoreOutcome, ScorerDraft } from "./types";

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
  judgeDeps?: JudgeDeps;
}

const defaults: PreviewDeps = {
  latest: latestMatchingTraces,
  count: countMatchingTraces,
  judge: judgeTraces,
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
  const traces = await deps.latest(projectId, draft.filter, PREVIEW_TRACES);
  let outcomes: ScoreOutcome[];
  if (draft.kind === "check") {
    const { config } = draft;
    outcomes = traces.map((trace) => runCheck(config, trace));
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

/** How many traces of the last 7 days a filter matches. */
export function countLastWeek(
  projectId: string,
  filter: TraceFilter,
  now: Date = new Date(),
  deps: Pick<PreviewDeps, "count"> = defaults,
): Promise<number> {
  return deps.count(projectId, filter, new Date(now.getTime() - WEEK_MS));
}
