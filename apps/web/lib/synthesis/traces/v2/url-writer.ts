/**
 * Writes view state the server never reads (the full trace's tab and selected
 * step) into the URL, coalesced. Browsers cap `history.replaceState` (Safari
 * throws after 100 calls in 30 seconds), and holding `j` in the timeline would
 * reach that in seconds. Changes merge and are written once the selection
 * rests, so each write needs a pause and the cap is out of reach.
 */

export type QueryUpdates = Readonly<Record<string, string | null>>;

/** How long the selection rests before the URL follows it. */
export const URL_WRITE_DELAY_MS = 400;

export interface UrlWriter {
  /** Queue changes; they merge with any not yet written. */
  set(updates: QueryUpdates): void;
  /** Drop what is queued, for a page that is going away. */
  cancel(): void;
}

export interface WriterTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const BROWSER_TIMERS: WriterTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createUrlWriter(
  write: (updates: QueryUpdates) => void,
  delayMs: number = URL_WRITE_DELAY_MS,
  timers: WriterTimers = BROWSER_TIMERS,
): UrlWriter {
  let queued: QueryUpdates = {};
  let handle: unknown = null;
  const stop = () => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
  };
  return {
    set(updates) {
      queued = { ...queued, ...updates };
      stop();
      handle = timers.setTimeout(() => {
        handle = null;
        const due = queued;
        queued = {};
        write(due);
      }, delayMs);
    },
    cancel() {
      stop();
      queued = {};
    },
  };
}

/** The query string (with its `?`, or empty) after applying `updates`; null removes a parameter. */
export function withQueryUpdates(search: string, updates: QueryUpdates): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const [name, value] of Object.entries(updates)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}
