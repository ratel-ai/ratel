import {
  listClosedTurnsPage as listClosedTurnsPageFn,
  TURN_PAGE_SIZE,
} from "@/lib/ledger/closed-turns";
import { walkClosedTurnPages } from "@/lib/ledger/turn-pages";
import { envNumber } from "@/lib/platform/env-number";
import {
  createExplorerAnalysis,
  type ExplorerAnalysisOptions,
} from "@/lib/readings/tool-explorer/analyze";
import { MAX_SET_SIZE } from "@/lib/readings/tool-explorer/cousage";
import {
  errorMessagesFor as errorMessagesForFn,
  intentsForTurns as intentsForTurnsFn,
  loadIntentTexts as loadIntentTextsFn,
} from "@/lib/readings/tool-explorer/ledger";
import type { ErrorInfo } from "@/lib/readings/tool-explorer/reliability";
import type { ExplorerResult, ExplorerWorkflowCore } from "@/lib/readings/tool-explorer/types";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import { loadPreviousWorkflows as loadPreviousWorkflowsFn } from "@/lib/readings/trace-signals/signals/workflow-previous";
import { DEFAULT_WORKFLOW_CONFIG } from "@/lib/readings/trace-signals/workflows/types";

/**
 * The compute pass over the stored ledger: Agent health's keyset walk
 * (`walkClosedTurnPages`) over the window, one pass, no comparison days: the
 * explorer reads a window, not a trend.
 */

const DAY_MS = 86_400_000;

/** Wall-clock budget of one run, inside the stale-job reaper's window. */
export const EXPLORER_TIME_BUDGET_MS = envNumber("TOOL_EXPLORER_TIME_BUDGET_MS", 6 * 60_000);
export const DEFAULT_EXPLORER_WINDOW_DAYS = Math.floor(envNumber("TOOL_EXPLORER_WINDOW_DAYS", 30));
export const MAX_EXPLORER_WINDOW_DAYS = 90;

export interface ExplorerWindow {
  start: Date;
  end: Date;
  days: number;
}

export function explorerWindow(end: Date, days: number): ExplorerWindow {
  return { start: new Date(end.getTime() - days * DAY_MS), end, days };
}

/** The window a plan allows: its Agent health window, kept between the default and 90 days. */
export function explorerWindowDays(planWindowDays: number): number {
  return Math.min(
    MAX_EXPLORER_WINDOW_DAYS,
    Math.max(DEFAULT_EXPLORER_WINDOW_DAYS, Math.floor(planWindowDays)),
  );
}

/**
 * The largest co-used set mined: four tools, or as many as the biggest task's
 * core, so a set can always be named after its task, never past the task
 * miner's own largest set.
 */
export function cousageSizeFor(workflows: readonly ExplorerWorkflowCore[]): number {
  const biggest = Math.max(0, ...workflows.map((workflow) => workflow.coreTools.length));
  return Math.min(DEFAULT_WORKFLOW_CONFIG.maxSize, Math.max(MAX_SET_SIZE, biggest));
}

export interface ExplorerComputeDeps {
  listPage: typeof listClosedTurnsPageFn;
  /** The latest Agent health workflows, so a co-used set can be named after one. */
  loadWorkflows: (projectId: string) => Promise<readonly ExplorerWorkflowCore[]>;
  /** A page's turns to the intents their searches were categorized into. */
  intentsForTurns: (
    projectId: string,
    turns: readonly SignalTurn[],
  ) => Promise<Map<string, string[]>>;
  /** Intent texts by id, read once before `finish` to name the groups. */
  loadIntentTexts: (
    projectId: string,
    intentIds: readonly string[],
  ) => Promise<Map<string, string>>;
  /** The error message behind each error step's end event, so a retried error can be classed. */
  loadErrorMessages: (
    projectId: string,
    eventIds: readonly string[],
  ) => Promise<Map<string, ErrorInfo>>;
  now: () => Date;
  timeBudgetMs: number;
  pageSize: number;
  analysis?: Omit<ExplorerAnalysisOptions, "workflows">;
}

function defaultDeps(): ExplorerComputeDeps {
  return {
    listPage: listClosedTurnsPageFn,
    loadWorkflows: (projectId) => loadPreviousWorkflowsFn(projectId),
    intentsForTurns: (projectId, turns) => intentsForTurnsFn(projectId, turns),
    loadIntentTexts: (projectId, ids) => loadIntentTextsFn(projectId, ids),
    loadErrorMessages: (projectId, ids) => errorMessagesForFn(projectId, ids),
    now: () => new Date(),
    timeBudgetMs: EXPLORER_TIME_BUDGET_MS,
    pageSize: TURN_PAGE_SIZE,
  };
}

export interface ExplorerComputeOutcome {
  result: ExplorerResult;
  pages: number;
}

/** Run the analysis over the project's ledger. Throws `TimeBudgetError` on overrun. */
export async function computeToolExplorer(
  projectId: string,
  window: ExplorerWindow,
  overrides: Partial<ExplorerComputeDeps> = {},
): Promise<ExplorerComputeOutcome> {
  const deps = { ...defaultDeps(), ...overrides };
  const startedAt = deps.now().getTime();
  const workflows = await deps.loadWorkflows(projectId);
  const analysis = createExplorerAnalysis({
    ...deps.analysis,
    cousage: { maxSize: cousageSizeFor(workflows), ...deps.analysis?.cousage },
    workflows,
  });
  const pages = await walkClosedTurnPages(
    deps.listPage,
    projectId,
    { from: window.start, to: window.end },
    { pageSize: deps.pageSize, startedAt, now: deps.now, timeBudgetMs: deps.timeBudgetMs },
    async (page) => {
      const intents = await deps.intentsForTurns(projectId, page.turns);
      const errorIds = page.turns.flatMap((turn) =>
        turn.steps
          .filter((s) => s.kind !== "search" && s.outcome === "error" && s.endTraceEventId)
          .map((s) => s.endTraceEventId!),
      );
      const errorMessages =
        errorIds.length > 0 ? await deps.loadErrorMessages(projectId, errorIds) : undefined;
      for (const turn of page.turns) analysis.feed(turn, intents.get(turn.id), errorMessages);
    },
  );
  const seen = analysis.intentIds();
  const texts =
    seen.length > 0 ? await deps.loadIntentTexts(projectId, seen) : new Map<string, string>();
  return { result: analysis.finish(texts), pages };
}
