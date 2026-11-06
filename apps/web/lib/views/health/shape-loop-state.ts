/**
 * When the turn-shape loops run, kept pure so every way of arriving on the
 * page can be tested without a browser.
 *
 * The loops run only while someone can see them: the list is on screen and
 * the tab is visible. They start from what the page can observe at that
 * moment, never from how it was loaded, so a hard load, a client-side
 * navigation, back and forward, a tab brought forward or a window switched
 * back all start (or resume) the same way.
 */

/**
 * Where the list's loops stand: `idle` until it has been seen (every
 * pictogram shows its finished picture), `running` while it is seen, and
 * `paused` once it has been seen and is not now (the rows hold where they are
 * and resume on return, costing no frames meanwhile).
 */
export type LoopState = "idle" | "running" | "paused";

/** What the page can observe about the list right now. */
export interface LoopSignals {
  /** The list intersects the viewport. */
  onScreen: boolean;
  /** The tab is visible (`document.visibilityState === "visible"`). */
  pageVisible: boolean;
}

/** The next state for what the page observes now. Once started, never back to idle. */
export function nextLoopState(current: LoopState, signals: LoopSignals): LoopState {
  if (signals.onScreen && signals.pageVisible) return "running";
  return current === "idle" ? "idle" : "paused";
}

/** Reads the tab's visibility, treating a document without the API as visible. */
export function pageIsVisible(doc: Pick<Document, "visibilityState"> | undefined): boolean {
  return !doc || doc.visibilityState !== "hidden";
}
