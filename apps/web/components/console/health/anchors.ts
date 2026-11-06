/**
 * The DOM id a signal card carries, so the flow map can link to `#signal-<id>`
 * and the card can open itself when that hash is targeted. Kept in its own file
 * so the client card and the server list share it without importing each other.
 */
export function signalAnchorId(signalId: string): string {
  return `signal-${signalId}`;
}

const ANCHOR_PREFIX = "signal-";

/** The signal anchor a `location.hash` points at, or null for any other hash. */
export function signalAnchorFromHash(hash: string): string | null {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  return id.startsWith(ANCHOR_PREFIX) && id.length > ANCHOR_PREFIX.length ? id : null;
}

/**
 * Asks the problem list to open one card (and close the rest) without a hash
 * change: the flow map sends it when the hash already names that card, where
 * setting the same hash again would fire nothing.
 */
export const SIGNAL_OPEN_EVENT = "health:open-signal";

export function requestSignalOpen(anchor: string): void {
  window.dispatchEvent(new CustomEvent<string>(SIGNAL_OPEN_EVENT, { detail: anchor }));
}
