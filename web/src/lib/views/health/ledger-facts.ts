import { windowDays } from "@/lib/readings/trace-signals/signals/project-metrics";
import { WINDOW_DAY_OPTIONS, type WindowDays } from "@/lib/readings/trace-signals/view";

/**
 * What the turn ledger holds right now, window by window. The page reads it
 * before it says anything about a window without a reading: a reading is a
 * signal run, and a run can lag the ledger (turns still open, or closed after
 * it ran), so "no reading" is not "no turns".
 *
 * Windows are whole UTC days, as the reading's own (`windowDays` in
 * `project-metrics.ts`): "7 days" is today and the six days before it.
 */

/** Turns that ended on one UTC day, by state. */
export interface LedgerDayCount {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  closed: number;
  open: number;
  /** Open turns quiet long enough that the next build closes them. */
  idleOpen: number;
  /** Turns (closed or open) an Agent health import brought. */
  imported: number;
}

/** The ledger over one window option. */
export interface LedgerWindow {
  /** Closed and still open turns. */
  turns: number;
  closed: number;
  idleOpen: number;
  imported: number;
  /** The first and last day with a turn; null when the window has none. */
  firstDay: string | null;
  lastDay: string | null;
}

/** The project's signal runs as the page needs them: what is on its way, and how the last ones ended. */
export interface RunFacts {
  /** A signal run is queued or running for the project, or a build asked for one: a reading is on its way. */
  working: boolean;
  /** When the project's latest signal run (any status) was created; null before the first. */
  lastRunAt: string | null;
  /** The latest finished run's status (`completed`, `failed`); null before the first. */
  lastRunStatus: string | null;
  /** When the latest completed run was created; null before the first. */
  lastCompletedAt: string | null;
  /** Failed runs in a row since the last completed one (up to a cap): the page backs off on them. */
  failedRuns: number;
}

export const NO_RUNS: RunFacts = {
  working: false,
  lastRunAt: null,
  lastRunStatus: null,
  lastCompletedAt: null,
  failedRuns: 0,
};

export interface LedgerFacts extends RunFacts {
  windows: Readonly<Record<WindowDays, LedgerWindow>>;
  /** The newest day with a turn anywhere in the ledger, older than every window included; null when it is empty. */
  newestDay: string | null;
  /**
   * Closed turns in the window the facts were read for that changed (were
   * written or closed) after the latest completed run started: turns the
   * reading has not read. Every closed turn there before a first reading.
   */
  unreadClosed: number;
}

/** A run row as `runFacts` reads it, newest first. */
export interface RunRow {
  status: string;
  createdAt: Date;
}

/**
 * The run facts from the project's latest runs, newest first: the latest one
 * (any status) times the page's cooldown; a live one (queued or running) does
 * not end the streak of failures before it.
 */
export function runFacts(rows: readonly RunRow[], working: boolean): RunFacts {
  const finished = rows.filter((row) => row.status === "completed" || row.status === "failed");
  const lastCompleted = finished.find((row) => row.status === "completed");
  const streak = finished.findIndex((row) => row.status !== "failed");
  return {
    working,
    lastRunAt: rows[0]?.createdAt.toISOString() ?? null,
    lastRunStatus: finished[0]?.status ?? null,
    lastCompletedAt: lastCompleted?.createdAt.toISOString() ?? null,
    failedRuns: streak === -1 ? finished.length : streak,
  };
}

/** The longest window the page offers: how far back the per-day counts reach. */
export const LEDGER_HORIZON_DAYS: WindowDays = WINDOW_DAY_OPTIONS[WINDOW_DAY_OPTIONS.length - 1]!;

/** The UTC day of an instant. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The first instant of a `days` window ending now: midnight UTC of its first day. */
export function ledgerWindowStart(now: Date, days: number): Date {
  return new Date(`${windowDays(now, days)[0] ?? utcDay(now)}T00:00:00.000Z`);
}

const EMPTY_DAY = { closed: 0, open: 0, idleOpen: 0, imported: 0 } as const;

function addDays(a: LedgerDayCount, b: LedgerDayCount): LedgerDayCount {
  return {
    day: a.day,
    closed: a.closed + b.closed,
    open: a.open + b.open,
    idleOpen: a.idleOpen + b.idleOpen,
    imported: a.imported + b.imported,
  };
}

/** Merges the three per-day reads (closed, open, imported) into one row per day, oldest first. */
export function mergeDayCounts(parts: {
  closed: readonly { day: string; n: number }[];
  open: readonly { day: string; n: number; idle: number }[];
  imported: readonly { day: string; n: number }[];
}): LedgerDayCount[] {
  const entries: LedgerDayCount[] = [
    ...parts.closed.map(({ day, n }) => ({ ...EMPTY_DAY, day, closed: n })),
    ...parts.open.map(({ day, n, idle }) => ({ ...EMPTY_DAY, day, open: n, idleOpen: idle })),
    ...parts.imported.map(({ day, n }) => ({ ...EMPTY_DAY, day, imported: n })),
  ];
  const byDay = entries.reduce((merged, entry) => {
    const prior = merged.get(entry.day);
    return new Map(merged).set(entry.day, prior ? addDays(prior, entry) : entry);
  }, new Map<string, LedgerDayCount>());
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function windowOf(rows: readonly LedgerDayCount[], days: ReadonlySet<string>): LedgerWindow {
  const inside = rows.filter((row) => days.has(row.day) && row.closed + row.open > 0);
  const sum = (pick: (row: LedgerDayCount) => number) =>
    inside.reduce((total, row) => total + pick(row), 0);
  return {
    turns: sum((row) => row.closed + row.open),
    closed: sum((row) => row.closed),
    idleOpen: sum((row) => row.idleOpen),
    imported: sum((row) => row.imported),
    firstDay: inside[0]?.day ?? null,
    lastDay: inside.at(-1)?.day ?? null,
  };
}

/**
 * The facts the page decides on. `rows` hold the days the reads covered (the
 * horizon for closed turns, every day for open ones), one per day;
 * `newestClosedAt` is the newest closed turn anywhere, which may be older
 * than the horizon.
 */
export function ledgerFacts(input: {
  rows: readonly LedgerDayCount[];
  newestClosedAt: Date | null;
  /** Defaults to no runs at all. */
  runs?: RunFacts;
  /** Defaults to 0: everything closed has been read. */
  unreadClosed?: number;
  now: Date;
}): LedgerFacts {
  const rows = [...input.rows].sort((a, b) => a.day.localeCompare(b.day));
  const windows = Object.fromEntries(
    WINDOW_DAY_OPTIONS.map((days) => [days, windowOf(rows, new Set(windowDays(input.now, days)))]),
  ) as Record<WindowDays, LedgerWindow>;
  const days = [
    ...rows.filter((row) => row.closed + row.open > 0).map((row) => row.day),
    ...(input.newestClosedAt ? [utcDay(input.newestClosedAt)] : []),
  ];
  return {
    ...(input.runs ?? NO_RUNS),
    windows,
    newestDay: [...days].sort().at(-1) ?? null,
    unreadClosed: Math.max(0, input.unreadClosed ?? 0),
  };
}
