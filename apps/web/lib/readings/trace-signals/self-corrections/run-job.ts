import { listClosedTurnsPage, TURN_PAGE_SIZE } from "@/lib/ledger/closed-turns";
import {
  recordSelfCorrections,
  type SelfCorrectionRunDeps,
  type SelfCorrectionRunInput,
  type SelfCorrectionRunResult,
} from "@/lib/readings/trace-signals/self-corrections/run";
import {
  loadCorrectionPageFacts,
  loadTopicNames,
  replaceSelfCorrections,
} from "@/lib/readings/trace-signals/self-corrections/run-queries";
import { loadRunBasisCounts } from "@/lib/readings/trace-signals/signals/analysis-context";
import { DEFAULT_FLOORS } from "@/lib/readings/trace-signals/signals/catalog";
import { chooseRunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";

/** The run's clock: the reading shares the signal run's wall-clock budget. */
export interface SelfCorrectionBudget {
  startedAt: number;
  now: () => Date;
  timeBudgetMs: number;
}

/** The reading's deps against the app database. */
export function selfCorrectionRunDeps(budget: SelfCorrectionBudget): SelfCorrectionRunDeps {
  return {
    listPage: listClosedTurnsPage,
    loadBasis: async (projectId, window) =>
      chooseRunBasis(await loadRunBasisCounts(projectId, window)),
    loadPageFacts: (projectId, turns) => loadCorrectionPageFacts(projectId, turns),
    loadTopicNames: (projectId) => loadTopicNames(projectId),
    replaceRows: (projectId, range, rows) => replaceSelfCorrections(projectId, range, rows),
    pageSize: TURN_PAGE_SIZE,
    floors: DEFAULT_FLOORS.self_correcting,
    ...budget,
  };
}

/** One self-correction reading of a signal run's window, against the app database. */
export function recordSelfCorrectionsForRun(
  projectId: string,
  input: SelfCorrectionRunInput,
  budget: SelfCorrectionBudget,
): Promise<SelfCorrectionRunResult> {
  return recordSelfCorrections(projectId, input, selfCorrectionRunDeps(budget));
}
