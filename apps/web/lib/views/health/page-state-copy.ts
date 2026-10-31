import { formatCount } from "@/lib/readings/trace-signals/claims";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import { SOURCE_LABEL } from "@/lib/views/health/imports-types";
import type { HealthPageState, WindowSuggestion } from "@/lib/views/health/page-state";

/**
 * The words for each page state, shared by the v1 and the design-system
 * blocks so both say the same thing. Plain language, sentence case, numerals,
 * no engine names. Days are UTC calendar days, as the ledger counts them.
 */

export interface StateCopy {
  title: string;
  body: string;
}

const MONTH_DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
const MONTH_DAY_YEAR: Intl.DateTimeFormatOptions = { ...MONTH_DAY, year: "numeric" };

/** "Oct 9" for a `YYYY-MM-DD` day this year, "Oct 9, 2025" for an earlier one. */
export function formatLedgerDay(day: string, now: Date): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(at.getTime())) return day;
  const sameYear = at.getUTCFullYear() === now.getUTCFullYear();
  return at.toLocaleDateString("en-US", sameYear ? MONTH_DAY : MONTH_DAY_YEAR);
}

/** "Oct 9", or "Sep 2 to Oct 9" when the days differ. */
export function formatDayRange(first: string, last: string, now: Date): string {
  return first === last
    ? formatLedgerDay(first, now)
    : `${formatLedgerDay(first, now)} to ${formatLedgerDay(last, now)}`;
}

function counted(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** "60 imported runs", "1 turn". */
export function runsNoun(count: number, imported: boolean): string {
  return imported
    ? counted(count, "imported run", "imported runs")
    : counted(count, "turn", "turns");
}

/** "30 days", the number and its unit kept on one line (a no-break space, DESIGN.md Typography). */
export function daysText(days: number): string {
  return `${days} days`;
}

/** The button that switches the window: "Show 30 days". */
export function windowActionLabel(days: WindowDays): string {
  return `Show ${daysText(days)}`;
}

/**
 * For a window the plan does not include: "Plus includes 30 days." Null when
 * it does, and when `plans` is off (billing is off: no plan can be picked, so
 * the page does not name one).
 */
export function planNote(suggestion: WindowSuggestion | null, plans = true): string | null {
  if (!suggestion?.plan || !plans) return null;
  return `A larger plan includes ${daysText(suggestion.days)}.`;
}

/**
 * Where a reading has enough turns, after "A reading needs 50.": "The last 30
 * days have enough." (and the plan that has them). Null when no wider window
 * does, or when it needs a plan and billing is off.
 */
export function widerLine(wider: WindowSuggestion | null, plans = true): string | null {
  if (!wider || (wider.plan && !plans)) return null;
  const enough = `The last ${daysText(wider.days)} have enough`;
  return wider.plan ? `${enough}, and a larger plan includes them.` : `${enough}.`;
}

/** After "A reading needs 50.": where there are enough, or that it comes on its own. */
export function widerNote(wider: WindowSuggestion | null, plans = true): string {
  return widerLine(wider, plans) ?? "It appears on its own once there are enough.";
}

/**
 * Beside a too-few count, the turns still in progress, on its own line:
 * "3 more are in progress and count once they finish.", or "1 turn is in
 * progress and counts once it finishes." when none has finished. Null when
 * none is in progress.
 */
export function inProgressLine(
  state: Extract<HealthPageState, { kind: "too_few" }>,
): string | null {
  const open = state.inProgress ?? 0;
  if (open <= 0) return null;
  const one = open === 1;
  const rest = one
    ? "in progress and counts once it finishes."
    : "in progress and count once they finish.";
  const subject = state.turns === 0 ? runsNoun(open, state.imported) : `${formatCount(open)} more`;
  return `${subject} ${one ? "is" : "are"} ${rest}`;
}

function buildingCopy(state: Extract<HealthPageState, { kind: "building" }>): StateCopy {
  const source = state.source ? SOURCE_LABEL[state.source] : null;
  switch (state.phase) {
    case "importing":
      return {
        title: source ? `Importing runs from ${source}…` : "Importing runs…",
        body:
          state.turns > 0
            ? `${counted(state.turns, "run", "runs")} so far. Your reading follows as soon as they are in.`
            : "Reading runs from the source. Your reading follows as soon as they are in.",
      };
    case "held":
      return {
        title: source ? `We are finishing your ${source} import` : "We are finishing your import",
        body: "Part of it needs a closer look from our team. This page fills in once it is done.",
      };
    case "finishing":
      return {
        title: `Building your reading from ${runsNoun(state.turns, state.imported)}…`,
        body: "Some of them are still in progress. Each one counts once it finishes.",
      };
    case "computing":
      return {
        title: `Building your reading from ${runsNoun(state.turns, state.imported)}…`,
        // The page watches for it either way (`RefreshWhileBuilding`), and asks for the run once the cooldown allows.
        body: state.working
          ? "This takes about a minute. The page updates on its own."
          : "It starts within a few minutes. The page updates on its own.",
      };
    case "stalled":
      return {
        title: "Your reading did not finish",
        body: "It is retried on its own. This page fills in once a reading is done.",
      };
  }
}

export interface StateCopyContext {
  windowDays: WindowDays;
  now: Date;
  /** The page can open the importer; off, the words do not offer it. */
  canImport?: boolean;
  /** Plans can be picked (billing is on); off, no plan is named. */
  plans?: boolean;
}

export function healthStateCopy(state: HealthPageState, context: StateCopyContext): StateCopy {
  const { windowDays, now, canImport = true, plans = true } = context;
  switch (state.kind) {
    case "ready":
    case "tool_spans":
      return { title: "", body: "" };
    case "nothing_yet":
      return {
        title: "No runs yet",
        body: canImport
          ? "Import past runs for a reading today, or connect your agent with a project API key."
          : "Connect your agent with a project API key, and this page reads its runs.",
      };
    case "unavailable":
      return {
        title: "The reading did not load",
        body: "Something went wrong on our side. Reload the page to try again.",
      };
    case "imported_no_tools": {
      const source = SOURCE_LABEL[state.source];
      const from =
        state.runs === 1
          ? `the 1 run imported from ${source} called none`
          : `none of the ${counted(state.runs, "run", "runs")} imported from ${source} called one`;
      return {
        title: "Your imported runs have no tool calls",
        body: canImport
          ? `This page reads the tools your agent calls, and ${from}. Import runs that call tools, or connect your agent with a project API key.`
          : `This page reads the tools your agent calls, and ${from}. Connect your agent with a project API key to send runs that do.`,
      };
    }
    case "building":
      return buildingCopy(state);
    case "too_few": {
      const wider = widerNote(state.wider, plans);
      // Only open turns so far: that is what the window has, never "0 turns".
      if (state.turns === 0 && state.inProgress) {
        const unit = state.imported ? "runs" : "turns";
        return {
          title: `${runsNoun(state.inProgress, state.imported)} in progress`,
          body: `A reading needs ${formatCount(state.floor)} finished ${unit}. ${wider}`,
        };
      }
      return {
        title: `${runsNoun(state.turns, state.imported)} in the last ${daysText(windowDays)}`,
        body: [inProgressLine(state), `A reading needs ${formatCount(state.floor)}.`, wider]
          .filter(Boolean)
          .join(" "),
      };
    }
    case "outside_window": {
      const title = `No runs in the last ${daysText(windowDays)}`;
      if (!state.suggestion || !state.firstDay || !state.lastDay) {
        const latest = state.lastDay
          ? ` Your agent's latest runs are from ${formatLedgerDay(state.lastDay, now)}.`
          : "";
        const next = canImport
          ? "Send new runs with your API key, or import recent ones."
          : "Send new runs with your API key.";
        return { title, body: `${latest} ${next}`.trim() };
      }
      const verb = state.turns === 1 ? "is" : "are";
      const from = `Your ${runsNoun(state.turns, state.imported)} ${verb} from ${formatDayRange(state.firstDay, state.lastDay, now)}.`;
      return { title, body: [from, planNote(state.suggestion, plans)].filter(Boolean).join(" ") };
    }
  }
}
