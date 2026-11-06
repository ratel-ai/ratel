import { loadOrFallback } from "@/lib/platform/resilient-read";
import { getLatestRun, listProposals } from "@/lib/synthesis/match-quality/queries";
import type {
  MatchQualityProposalRow,
  MatchQualityRunRow,
} from "@/lib/synthesis/match-quality/schema";
import {
  countCapturedSearchesPerWindow,
  isSearchTelemetry,
  resolveEvidenceSource,
} from "@/lib/synthesis/match-quality/search-source";
import {
  nextBillingPeriodStart,
  RUN_WINDOW_OPTIONS,
  resolveRunWindow,
} from "@/lib/synthesis/match-quality/window";
import { countComparisonsPerWindow } from "@/lib/synthesis/quality/queries";
import { entitled, type QualityContext } from "./context";
import { type RunBudget, type RunMenuModel, runMenuModel } from "./run-menu";

/**
 * Match quality's side of the page: the latest run (for the header's menu)
 * and its proposals (the header's count of rewrites waiting on Fixes, where
 * `lib/fixes` lists them). Reuses the v1 page's reads; nothing here writes.
 */

export interface QualityRunState {
  run: MatchQualityRunRow | null;
  proposals: MatchQualityProposalRow[];
  /** The header's menu; null when match quality is off or not on the plan. */
  menu: RunMenuModel | null;
  /** True when the run or its proposals could not be read. */
  failed: boolean;
}

export async function loadRunState(context: QualityContext): Promise<QualityRunState> {
  const { project, now } = context;
  if (!context.sources.matchQuality || !entitled(context)) {
    return { run: null, proposals: [], menu: null, failed: false };
  }
  const read = await loadOrFallback<{
    run: MatchQualityRunRow | null;
    proposals: MatchQualityProposalRow[];
  } | null>({
    operation: "quality_v2_run_state",
    distinctId: `project:${project.id}`,
    fallback: null,
    load: async () => {
      const [run, proposals] = await Promise.all([
        getLatestRun(project.id),
        listProposals(project.id),
      ]);
      return { run, proposals };
    },
  });
  if (!read) return { run: null, proposals: [], menu: null, failed: true };

  const counts = await loadOrFallback({
    operation: "quality_v2_run_windows",
    distinctId: `project:${project.id}`,
    fallback: new Map<number, number>(),
    load: () => runWindowCounts(project.id, now),
  });
  return {
    ...read,
    menu: runMenuModel({
      run: read.run,
      windows: RUN_WINDOW_OPTIONS,
      counts,
      budget: runBudget(context),
      now,
    }),
    failed: false,
  };
}

function runBudget(context: QualityContext): RunBudget {
  const access = context.access;
  if (access && !access.ok && access.reason === "exhausted") {
    return { spent: true, limit: access.limit, resetsAt: nextBillingPeriodStart(context.now) };
  }
  return { spent: false, remaining: access?.ok ? access.remaining : 0 };
}

/** Searches per run window, from the same source a run would read (the v1 page's rule). */
async function runWindowCounts(projectId: string, now: Date): Promise<Map<number, number>> {
  const widest = resolveRunWindow(Math.max(...RUN_WINDOW_OPTIONS), now);
  const source = await resolveEvidenceSource(projectId, widest);
  if (!source) return new Map();
  const { counts } = isSearchTelemetry(source.experimentName)
    ? await countCapturedSearchesPerWindow(projectId, RUN_WINDOW_OPTIONS)
    : await countComparisonsPerWindow(projectId, source.experimentName, RUN_WINDOW_OPTIONS);
  return counts;
}
