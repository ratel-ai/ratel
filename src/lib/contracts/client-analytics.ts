/**
 * The browser's analytics seam. Core components report an interaction or a caught error through
 * `lib/platform/track-client.ts`, which forwards here. An edition installs its client once, from
 * its provider; until then, and always in the open-source edition, nothing is sent.
 *
 * Installed with the edition's provider, not before hydration: a crash of the root layout on a
 * hard load can happen before anything is installed and then goes unreported.
 */
export type ClientAnalytics = {
  /** A named browser event with ids, names and numbers only. */
  track(event: string, properties?: Record<string, unknown>): void;
  /** An error an error boundary caught, with its `digest`, `pathname` and `boundary`. */
  captureException(error: unknown, properties?: Record<string, unknown>): void;
};

let installed: ClientAnalytics | null = null;

/** Install the edition's browser analytics; `null` removes it. */
export function installClientAnalytics(analytics: ClientAnalytics | null): void {
  installed = analytics;
}

/** The installed browser analytics, or null when none is. */
export function clientAnalytics(): ClientAnalytics | null {
  return installed;
}
