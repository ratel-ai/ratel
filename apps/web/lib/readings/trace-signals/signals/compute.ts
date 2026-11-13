import {
  listClosedTurnsPage as listClosedTurnsPageFn,
  TURN_PAGE_SIZE,
} from "@/lib/ledger/closed-turns";
import { walkClosedTurnPages } from "@/lib/ledger/turn-pages";
import { envNumber } from "@/lib/platform/env-number";
import { loadAnalysisContext as loadAnalysisContextFn } from "@/lib/readings/trace-signals/signals/analysis-context";
import { type AnalysisResult, createAnalysis } from "@/lib/readings/trace-signals/signals/analyze";
import { DEFAULT_FLOORS, type Floors } from "@/lib/readings/trace-signals/signals/catalog";
import { linkRunsPage as linkRunsPageFn } from "@/lib/readings/trace-signals/signals/linked-runs-query";
import type { AnalysisContext, SignalTurn } from "@/lib/readings/trace-signals/signals/types";

/**
 * The compute pass over the stored ledger: page closed turns by `(ended_at,
 * id)` (steps in chunks of the same size) through the two-pass analysis, under
 * a wall-clock budget. The window arithmetic lives here too, pure, so the job
 * and its tests agree on what "shrink the window next time" means.
 */

const DAY_MS = 86_400_000;

/** The default detector window. The ledger is durable, so up to 90 is allowed. */
export const DEFAULT_SIGNAL_WINDOW_DAYS = Math.floor(envNumber("TRACE_SIGNALS_WINDOW_DAYS", 30));
export const MAX_SIGNAL_WINDOW_DAYS = 90;
/** A shrunk window never goes below a week. */
export const MIN_SIGNAL_WINDOW_DAYS = 7;
/** Days scanned before the window so the health band has a previous window to compare. */
export const COMPARISON_DAYS = 30;
/** Wall-clock budget of one run, inside the stale-job reaper's ten minutes. */
export const SIGNAL_TIME_BUDGET_MS = envNumber("TRACE_SIGNALS_TIME_BUDGET_MS", 6 * 60_000);

export { TimeBudgetError } from "@/lib/ledger/turn-pages";

/** What the previous run tells the next one about its window. */
export interface PreviousRun {
  status: string;
  error: string | null;
  windowDays: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** The run's stored summary; `windowShrunk` there marks a window cut by a time-budget failure. */
  summary?: unknown;
}

/** The window a plan's runs aim for: its longest page window, kept between the default and 90 days. */
export function targetWindowDays(planWindowDays: number): number {
  return Math.min(
    MAX_SIGNAL_WINDOW_DAYS,
    Math.max(DEFAULT_SIGNAL_WINDOW_DAYS, Math.floor(planWindowDays)),
  );
}

/** Whether a completed run's window was cut by a time-budget failure (see `resolveWindowDays`). */
export function wasWindowShrunk(previous: Pick<PreviousRun, "summary">): boolean {
  const summary = previous.summary;
  return (
    !!summary &&
    typeof summary === "object" &&
    (summary as { windowShrunk?: unknown }).windowShrunk === true
  );
}

/**
 * The next run's window in days. The target is the plan's
 * ({@link targetWindowDays}). Only a `time_budget` failure shrinks it: the
 * window halves (never below a week), and the runs that follow on that shrunk
 * window (stored with `windowShrunk`) climb back: one that finished in under a
 * third of the budget doubles toward the target, a slower one keeps its
 * window, so a project that barely fits does not alternate between overrun and
 * success. Any other run uses the target directly: a 30-day run from before an
 * upgrade is not a shrunk window, so the next run on Pro reads 90 days at once
 * rather than climbing 30, 60, 90.
 */
export function resolveWindowDays(
  previous: PreviousRun | null,
  planWindowDays: number,
  budgetMs: number = SIGNAL_TIME_BUDGET_MS,
): number {
  const base = targetWindowDays(planWindowDays);
  if (!previous) return base;
  if (previous.status === "failed" && previous.error === "time_budget") {
    return Math.min(base, Math.max(MIN_SIGNAL_WINDOW_DAYS, Math.floor(previous.windowDays / 2)));
  }
  if (previous.status !== "completed" || previous.windowDays >= base || !wasWindowShrunk(previous))
    return base;
  const took =
    previous.startedAt && previous.finishedAt
      ? previous.finishedAt.getTime() - previous.startedAt.getTime()
      : budgetMs;
  return took < budgetMs / 3 ? Math.min(base, previous.windowDays * 2) : previous.windowDays;
}

export interface SignalWindow {
  start: Date;
  end: Date;
  /** Start of the scan: the window plus the comparison days before it. */
  scanStart: Date;
  days: number;
}

export function signalWindow(end: Date, days: number): SignalWindow {
  const start = new Date(end.getTime() - days * DAY_MS);
  return { start, end, scanStart: new Date(start.getTime() - COMPARISON_DAYS * DAY_MS), days };
}

export interface ComputeDeps {
  listPage: typeof listClosedTurnsPageFn;
  loadContext: typeof loadAnalysisContextFn;
  /** Links a page's SDK runs to their OpenTelemetry model calls (pass one only). */
  linkPage: (projectId: string, turns: readonly SignalTurn[]) => Promise<SignalTurn[]>;
  now: () => Date;
  timeBudgetMs: number;
  pageSize: number;
  floors: Floors;
}

function defaultDeps(): ComputeDeps {
  return {
    listPage: listClosedTurnsPageFn,
    loadContext: loadAnalysisContextFn,
    linkPage: (projectId, turns) => linkRunsPageFn(projectId, turns),
    now: () => new Date(),
    timeBudgetMs: SIGNAL_TIME_BUDGET_MS,
    pageSize: TURN_PAGE_SIZE,
    floors: DEFAULT_FLOORS,
  };
}

export interface ComputeOutcome {
  result: AnalysisResult;
  fingerprint: string | null;
  pages: number;
}

/**
 * Whether the window has OpenTelemetry model calls, so SDK runs may link to
 * some. Without them (every SDK-only project) no page pays for the read.
 */
export function sendsModelCalls(context: Pick<AnalysisContext, "otel">): boolean {
  for (const trace of context.otel?.traces.values() ?? []) if (trace.modelCalls > 0) return true;
  return false;
}

/** Run both passes over the project's ledger. Throws `TimeBudgetError` on overrun. */
export async function computeSignals(
  projectId: string,
  window: SignalWindow,
  overrides: Partial<ComputeDeps> = {},
): Promise<ComputeOutcome> {
  const deps = { ...defaultDeps(), ...overrides };
  const startedAt = deps.now().getTime();
  const { context, fingerprint } = await deps.loadContext(projectId, {
    start: window.start,
    end: window.end,
  });
  const analysis = createAnalysis(context, { floors: deps.floors, scanStart: window.scanStart });
  let pages = 0;

  const link = sendsModelCalls(context);
  const walkOptions = {
    pageSize: deps.pageSize,
    startedAt,
    now: deps.now,
    timeBudgetMs: deps.timeBudgetMs,
  };
  const walk = async (
    from: Date,
    visit: (turn: SignalTurn) => void,
    linked = false,
  ): Promise<void> => {
    pages += await walkClosedTurnPages(
      deps.listPage,
      projectId,
      { from, to: window.end },
      walkOptions,
      async (page) => {
        const turns = linked ? await deps.linkPage(projectId, page.turns) : page.turns;
        for (const turn of turns) visit(turn);
      },
    );
  };

  await walk(window.scanStart, (turn) => analysis.feed(turn), link);
  if (analysis.secondPass()) await walk(window.start, (turn) => analysis.feedPairs(turn));
  return { result: analysis.finish(), fingerprint, pages };
}
