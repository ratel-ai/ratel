import {
  type HealthReadiness,
  WINDOW_DAY_OPTIONS,
  type WindowDays,
} from "@/lib/readings/trace-signals/view";
import type { ImportSource, ImportSummary } from "@/lib/views/health/imports-types";
import type { LedgerFacts, LedgerWindow, RunFacts } from "@/lib/views/health/ledger-facts";

/**
 * What the Agent health page can truthfully say about the selected window,
 * decided from three sources that can disagree for a while: the reading (the
 * latest signal run, `model.turns`), the turn ledger right now
 * (`LedgerFacts`), and the project's imports. The reading wins when it has
 * enough turns; otherwise the ledger and the imports say why it does not:
 *
 * - `nothing_yet`: no turns anywhere and no import bringing any;
 * - `building`: runs exist (or are arriving) that no reading has read yet;
 * - `too_few`: the window has turns, fewer than a reading needs;
 * - `outside_window`: turns exist, none in this window;
 * - `imported_no_tools`: an import brought runs, and none called a tool;
 * - `ready`: the reading has enough turns: the normal page.
 *
 * "Building" is only said while a run is on its way or there are turns the
 * latest reading has not read: a reading that has read everything and still
 * counts too few says so, rather than promising another one forever. A
 * reading whose runs keep failing says that too, and is asked for less and
 * less often.
 *
 * Pure, so every state is pinned by a unit test; the route reads the facts.
 */

/** A wider window to offer, and the plan that includes it when the current one does not. */
export interface WindowSuggestion {
  days: WindowDays;
  /** The cheapest plan with this window; always null here, where no plan table exists. */
  plan: string | null;
}

/**
 * - `importing`: an import is storing runs right now;
 * - `computing`: there are runs no reading has read, and a reading of them can
 *   be (or is being) computed;
 * - `finishing`: enough turns, but some are still in progress, and a reading
 *   only counts finished ones;
 * - `held`: an import is waiting on our team, with nothing stored yet;
 * - `stalled`: the last reading of these runs failed and none is on its way:
 *   it is retried on its own, less and less often (`requestCooldownMs`).
 */
export type BuildingPhase = "importing" | "computing" | "finishing" | "held" | "stalled";

export type HealthPageState =
  /** `updating`: a reading of runs this one missed is on its way, and the page watches for it. */
  | { kind: "ready"; updating?: boolean }
  | { kind: "nothing_yet" }
  /** Model calls arrive with no tool spans: no run can be made (`ToolSpansMissing`). */
  | { kind: "tool_spans" }
  /** The reading, the ledger or the imports could not be read: the page says so instead of guessing. */
  | { kind: "unavailable" }
  | {
      kind: "building";
      phase: BuildingPhase;
      /** Turns (or imported runs) the reading is being built from. */
      turns: number;
      /** Every one of them came from an import. */
      imported: boolean;
      /** The import behind an `importing`, `held` or freshly stored phase. */
      source: ImportSource | null;
      /** A signal run is queued or running right now. */
      working: boolean;
    }
  /**
   * `turns`: the window's closed turns, what a reading reads; `inProgress`:
   * its turns still open, which count once they close (absent when none).
   */
  | {
      kind: "too_few";
      turns: number;
      floor: number;
      imported: boolean;
      wider: WindowSuggestion | null;
      inProgress?: number;
    }
  | {
      kind: "outside_window";
      /** Turns in the suggested window; 0 without a suggestion. */
      turns: number;
      imported: boolean;
      /** The days those turns span; without a suggestion, `lastDay` is the newest turn's day. */
      firstDay: string | null;
      lastDay: string | null;
      suggestion: WindowSuggestion | null;
    }
  /** A reading ran after the import and found no turns: its runs called no tool this page reads. */
  | { kind: "imported_no_tools"; runs: number; source: ImportSource };

/** The import fields the decision reads. */
export type ImportFacts = Pick<
  ImportSummary,
  "status" | "source" | "runsImported" | "startedAt" | "finishedAt"
>;

export interface HealthStateInputs {
  windowDays: WindowDays;
  /** Turns the reading counts in the selected window (`model.turns`); 0 without a reading. */
  readingTurns: number;
  /** Turns a reading needs (`model.floor`). */
  floor: number;
  /** Read for `windowDays`: `unreadClosed` counts that window. */
  ledger: LedgerFacts;
  /** Null when they could not be read: unknown, which is not none. */
  imports: readonly ImportFacts[] | null;
  /** The longest window the plan includes (`agentHealthWindowDays`). */
  planWindowDays: number;
  /** `model.waitingOn`: model calls arrive with no tool spans. */
  waitingOn?: "tool_spans";
}

const READY: HealthPageState = { kind: "ready" };

/**
 * The plan whose Agent health window reaches `days`: none here. The open-source edition has
 * no plan table, so a window the limits do not include is simply not offered by name.
 */
export function planWithWindow(_days: number): string | null {
  return null;
}

/** The smallest window wider than the selected one whose ledger passes `fits`. */
function widerWindow(
  input: HealthStateInputs,
  fits: (window: LedgerWindow) => boolean,
): WindowSuggestion | null {
  const days = WINDOW_DAY_OPTIONS.find(
    (option) => option > input.windowDays && fits(input.ledger.windows[option]),
  );
  if (days === undefined) return null;
  return { days, plan: days <= input.planWindowDays ? null : planWithWindow(days) };
}

function allImported(window: LedgerWindow): boolean {
  return window.turns > 0 && window.imported >= window.turns;
}

function newest<T extends ImportFacts>(
  imports: readonly T[],
  keep: (item: T) => boolean,
): T | null {
  return (
    [...imports]
      .filter(keep)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null
  );
}

/**
 * The latest run failed and none is on its way. A run cut by its time budget
 * counts too: the next one reads a shorter window, but nothing starts it
 * sooner than the next ask, so the page promises no minute.
 */
function lastRunStalled(runs: RunFacts): boolean {
  return !runs.working && runs.lastRunStatus === "failed";
}

/** Whether a reading completed after the import finished: it has read the import's runs. */
function readSince(item: ImportFacts, lastCompletedAt: string | null): boolean {
  if (lastCompletedAt === null) return false;
  return Date.parse(lastCompletedAt) >= Date.parse(item.finishedAt ?? item.startedAt);
}

/** A reading still to be computed: `stalled` instead when the last run of it failed. */
function pendingPhase(runs: RunFacts): BuildingPhase {
  return lastRunStalled(runs) ? "stalled" : "computing";
}

export function healthPageState(input: HealthStateInputs): HealthPageState {
  if (input.readingTurns >= input.floor) return READY;
  const { ledger, floor } = input;
  const window = ledger.windows[input.windowDays];
  const imports = input.imports ?? [];

  const importing = newest(imports, (item) => item.status === "running");
  if (importing) {
    return {
      kind: "building",
      phase: "importing",
      turns: importing.runsImported,
      imported: true,
      source: importing.source,
      working: true,
    };
  }
  if (window.turns >= floor) {
    const building = {
      kind: "building",
      turns: window.turns,
      imported: allImported(window),
      source: null,
      working: ledger.working,
    } as const;
    // Closed turns that changed after the latest reading started, and open
    // ones the next build closes: a run would read what the reading has not.
    if (ledger.working || ledger.unreadClosed + window.idleOpen > 0)
      return { ...building, phase: pendingPhase(ledger) };
    if (window.turns > window.closed + window.idleOpen) return { ...building, phase: "finishing" };
    // The reading has read every turn here and still counts fewer than it
    // needs (it leaves some out, e.g. guessed turns once turn ids arrive): say
    // what it counts rather than promise a reading that would not change. No
    // wider window is offered: the ledger's count there says nothing about
    // what the reading would leave out.
    return { kind: "too_few", turns: input.readingTurns, floor, imported: false, wider: null };
  }
  if (window.turns > 0) {
    // The meter counts what a reading will read: closed turns. The ones still
    // in progress are said apart, so a window of open turns never reads as empty.
    const inProgress = window.turns - window.closed;
    return {
      kind: "too_few",
      turns: window.closed,
      floor,
      imported: allImported(window),
      wider: widerWindow(input, (w) => w.closed >= floor),
      ...(inProgress > 0 ? { inProgress } : {}),
    };
  }
  if (ledger.newestDay !== null) {
    const suggestion = widerWindow(input, (w) => w.turns > 0);
    const shown = suggestion ? ledger.windows[suggestion.days] : null;
    return {
      kind: "outside_window",
      turns: shown?.turns ?? 0,
      imported: shown ? allImported(shown) : false,
      firstDay: shown?.firstDay ?? null,
      lastDay: shown?.lastDay ?? ledger.newestDay,
      suggestion,
    };
  }

  // The ledger is empty. An import's stored runs are on their way into it
  // until a reading after the import has completed: then they made no turns.
  const stored = newest(imports, (item) => item.status === "completed" && item.runsImported > 0);
  if (stored && (ledger.working || !readSince(stored, ledger.lastCompletedAt))) {
    return {
      kind: "building",
      phase: pendingPhase(ledger),
      turns: stored.runsImported,
      imported: true,
      source: stored.source,
      working: ledger.working,
    };
  }
  const held = newest(imports, (item) => item.status === "received" || item.status === "failed");
  if (held) {
    return {
      kind: "building",
      phase: "held",
      turns: held.runsImported,
      imported: true,
      source: held.source,
      working: false,
    };
  }
  if (input.waitingOn === "tool_spans") return { kind: "tool_spans" };
  if (stored)
    return { kind: "imported_no_tools", runs: stored.runsImported, source: stored.source };
  // Imports that could not be read may hold runs: that is not "nothing yet".
  return input.imports === null ? { kind: "unavailable" } : { kind: "nothing_yet" };
}

/** The page's older three-way readiness for a state, kept on `data-health-readiness`. */
export function stateReadiness(state: HealthPageState): HealthReadiness {
  if (state.kind === "ready") return "ready";
  if (state.kind === "too_few" || state.kind === "building") return "collecting";
  return "no_telemetry";
}

/** A page asks for a reading at most this often: a run that just ran and still misses turns is not retried in a loop. */
export const READING_REQUEST_COOLDOWN_MS = 10 * 60_000;
/** The longest a page waits between asks, however many runs failed: the daily sweep's own interval. */
export const READING_REQUEST_MAX_COOLDOWN_MS = 24 * 60 * 60_000;

/** The wait before asking again: the cooldown, doubled for every run in a row that failed, a day at most. */
export function requestCooldownMs(failedRuns: number): number {
  const doublings = Math.min(Math.max(0, failedRuns), 8);
  return Math.min(READING_REQUEST_MAX_COOLDOWN_MS, READING_REQUEST_COOLDOWN_MS * 2 ** doublings);
}

/** Whether the latest run started long enough ago to ask for another. */
export function cooldownPassed(
  runs: Pick<RunFacts, "lastRunAt" | "failedRuns">,
  now: Date,
): boolean {
  const last = runs.lastRunAt === null ? Number.NaN : Date.parse(runs.lastRunAt);
  return !Number.isFinite(last) || now.getTime() - last >= requestCooldownMs(runs.failedRuns);
}

/**
 * Whether the page should ask for a reading itself: it is about to say one
 * is being built (or retried) from runs no reading has read, nothing is
 * queued or running, and the cooldown since the latest run has passed. Turns
 * still in progress ask for nothing; the build that closes them comes first.
 */
export function readingRequestDue(
  state: HealthPageState,
  runs: Pick<RunFacts, "lastRunAt" | "failedRuns">,
  now: Date,
): boolean {
  if (
    state.kind !== "building" ||
    (state.phase !== "computing" && state.phase !== "stalled") ||
    state.working
  )
    return false;
  return cooldownPassed(runs, now);
}
