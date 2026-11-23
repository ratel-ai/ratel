/**
 * The name search box against the URL it writes (DESIGN.md, Everything is a
 * URL). Pure, so the rules are tested:
 *
 * - The box shows what was typed. Typing never waits on the URL.
 * - A value sent to the URL is in flight until the URL says it. When it
 *   lands, the box keeps whatever was typed since.
 * - When the URL moves for another reason (Back, a shared link), the box shows
 *   what the URL says and forgets what was in flight.
 * - When every navigation has finished and a value is still in flight, another
 *   navigation overtook it; the box keeps its text so it can be sent again.
 */

export interface SearchBoxState {
  /** What the box shows. */
  text: string;
  /** The name filter the URL holds now. */
  url: string;
  /** Values sent to the URL that it does not say yet, oldest first. */
  inFlight: readonly string[];
}

export type SearchBoxEvent =
  | { type: "typed"; text: string }
  | { type: "sent"; value: string }
  /** Clear filters: the box empties, and the URL's name goes with the rest. */
  | { type: "cleared" }
  /** The URL's name filter is `value`; `settled` when no navigation is still loading. */
  | { type: "url"; value: string; settled: boolean };

export function searchBoxState(url: string): SearchBoxState {
  return { text: url, url, inFlight: [] };
}

export function searchBoxReducer(state: SearchBoxState, event: SearchBoxEvent): SearchBoxState {
  switch (event.type) {
    case "typed":
      return event.text === state.text ? state : { ...state, text: event.text };
    case "sent":
      return lastOf(state.inFlight) === event.value
        ? state
        : { ...state, inFlight: [...state.inFlight, event.value] };
    case "cleared":
      // The clear is itself a write in flight, unless the URL has no name to drop.
      return {
        text: "",
        url: state.url,
        inFlight: state.url === "" && state.inFlight.length === 0 ? [] : [...state.inFlight, ""],
      };
    case "url":
      return overtaken(landed(state, event.value), event);
  }
}

/** The value to send for what the box shows, or null when the URL (or the newest write in flight) already says it. */
export function searchToSend(state: SearchBoxState): string | null {
  const value = state.text.trim();
  return value === (lastOf(state.inFlight) ?? state.url) ? null : value;
}

/** Whether the box has something it should reconcile with the URL's `value`. */
export function needsUrlSync(state: SearchBoxState, value: string, settled: boolean): boolean {
  return value !== state.url || (settled && state.inFlight.length > 0);
}

function landed(state: SearchBoxState, value: string): SearchBoxState {
  const position = state.inFlight.lastIndexOf(value);
  // Our own write: keep what was typed since, and anything sent after it.
  if (position >= 0) return { ...state, url: value, inFlight: state.inFlight.slice(position + 1) };
  if (value === state.url) return state;
  // The URL moved without us: show what it says.
  return searchBoxState(value);
}

function overtaken(
  state: SearchBoxState,
  event: { value: string; settled: boolean },
): SearchBoxState {
  if (!event.settled || state.inFlight.length === 0) return state;
  // Every navigation finished and these never landed: the text stays, so the
  // box sends it again on top of whatever overtook it.
  return { ...state, url: event.value, inFlight: [] };
}

function lastOf<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}
