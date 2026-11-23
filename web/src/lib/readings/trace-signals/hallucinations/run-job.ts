import { listClosedTurnsPage, TURN_PAGE_SIZE } from "@/lib/ledger/closed-turns";
import { hallucinationReadingEnabled } from "@/lib/readings/trace-signals/hallucinations/gate";
import {
  type HallucinationRunDeps,
  type HallucinationRunInput,
  type HallucinationRunResult,
  recordHallucinations,
} from "@/lib/readings/trace-signals/hallucinations/run";
import {
  loadCallFacts,
  loadFalseSuccessTurns,
  replaceHallucinations,
} from "@/lib/readings/trace-signals/hallucinations/run-queries";
import { loadTurnReplies } from "@/lib/readings/trace-signals/outcomes/text-queries";
import {
  loadCatalogNames,
  loadRunBasisCounts,
} from "@/lib/readings/trace-signals/signals/analysis-context";
import { catalogIdentities } from "@/lib/readings/trace-signals/signals/unknown-tool-standing";
import { chooseRunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";

/** The run's clock: the reading shares the signal run's wall-clock budget. */
export interface HallucinationBudget {
  startedAt: number;
  now: () => Date;
  timeBudgetMs: number;
}

/** The catalog's names and ids; null for a project with no catalog, where "not in the catalog" would be true of everything. */
export async function loadCatalogIdentities(
  projectId: string,
  load: typeof loadCatalogNames = loadCatalogNames,
): Promise<ReadonlySet<string> | null> {
  const names = await load(projectId);
  return names.size === 0 ? null : catalogIdentities(names);
}

/** The reading's deps against the app database, behind the flag of the project's organization. */
export function hallucinationRunDeps(budget: HallucinationBudget): HallucinationRunDeps {
  return {
    enabled: (projectId) => hallucinationReadingEnabled(projectId),
    listPage: listClosedTurnsPage,
    loadBasis: async (projectId, window) =>
      chooseRunBasis(await loadRunBasisCounts(projectId, window)),
    loadCallFacts: (projectId, eventIds) => loadCallFacts(projectId, eventIds),
    loadCatalog: (projectId) => loadCatalogIdentities(projectId),
    loadReplyTexts: (projectId, turns) => loadTurnReplies(projectId, turns),
    loadFalseSuccessTurns: (projectId, range) => loadFalseSuccessTurns(projectId, range),
    replaceRows: (projectId, range, rows) => replaceHallucinations(projectId, range, rows),
    pageSize: TURN_PAGE_SIZE,
    ...budget,
  };
}

/** One hallucination reading of a signal run's window, against the app database. */
export function recordHallucinationsForRun(
  projectId: string,
  input: HallucinationRunInput,
  budget: HallucinationBudget,
): Promise<HallucinationRunResult | null> {
  return recordHallucinations(projectId, input, hallucinationRunDeps(budget));
}
