import { MIN_SIGNAL_WINDOW_DAYS } from "@/lib/readings/trace-signals/signals/compute";

/**
 * The quick first reading (RC-224): a new project's first findings, before
 * the whole post-processing has run.
 *
 * A project's first signal run does not wait for its turn backlog to be
 * built in full, nor read the plan's whole window (up to 90 days) under the
 * run's time budget:
 * - the first run reads the last week only (`QUICK_FIRST_READING_DAYS`, the
 *   window the page opens on) and queues the full-window run as soon as it
 *   lands;
 * - a long backlog does not hold the first reading back: once the last week
 *   holds enough closed turns, the first run starts while older turns are
 *   still being built;
 * - every reading made before the full one is stored as early
 *   (`summary.earlyReading`): a narrow window, a backlog still being built,
 *   or an import still running. The page says so, and asks for the full one.
 */

/** The first reading's window: a week, which is also the page's default window. */
export const QUICK_FIRST_READING_DAYS = MIN_SIGNAL_WINDOW_DAYS;

/** The parts of a stored run these rules read. */
export interface ReadingFacts {
  status: string;
  turnsScanned: number;
  summary?: unknown;
  finishedAt?: Date | null;
}

/**
 * How long an early reading stands before a caught-up build asks for the next
 * one. A long import drains its build after every batch it stores: one reading
 * per batch would run the model-backed steps after it (task names, Intents)
 * that often for nothing.
 */
export const EARLY_REFRESH_AFTER_MS = 10 * 60_000;

/** Whether a caught-up build should ask for the reading that follows an early one. */
export function earlyRefreshDue(latest: ReadingFacts, now: Date): boolean {
  if (latest.status !== "completed" || !isEarlyReadingSummary(latest.summary) || !latest.finishedAt)
    return false;
  return now.getTime() - latest.finishedAt.getTime() >= EARLY_REFRESH_AFTER_MS;
}

/** Whether a stored run summary marks an early reading. */
export function isEarlyReadingSummary(summary: unknown): boolean {
  return (
    !!summary &&
    typeof summary === "object" &&
    (summary as { earlyReading?: unknown }).earlyReading === true
  );
}

/**
 * Whether a project still waits for its full reading: it has no completed
 * reading, its latest one read fewer turns than the floor (the page still
 * shows the collecting meter), or that one was early.
 */
export function awaitsFullReading(latestCompleted: ReadingFacts | null, floor: number): boolean {
  if (!latestCompleted || latestCompleted.status !== "completed") return true;
  return latestCompleted.turnsScanned < floor || isEarlyReadingSummary(latestCompleted.summary);
}

/**
 * The quick window for this run, or null for the usual one. Only a project
 * without a reading the page shows yet (none, or a thin one) gets it, and only
 * when its usual window is wider. Once any early reading has landed, even a
 * thin one, the next is the full window, never another quick one: a quiet
 * last week must not keep a busier month from being read.
 */
export function quickWindowDays(
  latestCompleted: ReadingFacts | null,
  targetDays: number,
  floor: number,
): number | null {
  if (targetDays <= QUICK_FIRST_READING_DAYS) return null;
  if (!latestCompleted || latestCompleted.status !== "completed") return QUICK_FIRST_READING_DAYS;
  if (latestCompleted.turnsScanned >= floor || isEarlyReadingSummary(latestCompleted.summary))
    return null;
  return QUICK_FIRST_READING_DAYS;
}

export interface EarlyReadingInput {
  /** The project still waits for its full reading (`awaitsFullReading`). */
  awaitingFull: boolean;
  /** This run reads the quick window. */
  quick: boolean;
  /** This run started while enough turn events were still unbuilt (`missedBacklog`). */
  partial: boolean;
  /** An import was still storing runs when this run started. */
  importing: boolean;
}

/**
 * Whether this run is early. Only a project still waiting for its full
 * reading can have one: a later backlog on an established project keeps the
 * existing "updating" path (`unbuiltAtStart`), which the page handles quietly.
 */
export function isEarlyReading(input: EarlyReadingInput): boolean {
  return input.awaitingFull && (input.quick || input.partial || input.importing);
}

/** How far an early reading has got (RC-225): runs it read of the runs there are to read. */
export interface EarlyProgress {
  /** Closed turns this reading read. */
  read: number;
  /** Closed turns in the plan's whole window now; grows while the backlog is built. */
  total: number;
  /** Whole percent, 1 to {@link EARLY_PROGRESS_MAX}: an early reading is never shown as done. */
  percent: number;
}

/** The most an early reading shows: the full reading is what says 100. */
export const EARLY_PROGRESS_MAX = 95;

export function earlyProgress(read: number, total: number): EarlyProgress {
  const safeRead = Math.max(0, Math.floor(read));
  const safeTotal = Math.max(safeRead, Math.floor(total));
  const share = safeTotal > 0 ? safeRead / safeTotal : 0;
  return {
    read: safeRead,
    total: safeTotal,
    percent: Math.min(EARLY_PROGRESS_MAX, Math.max(1, Math.floor(share * 100))),
  };
}
