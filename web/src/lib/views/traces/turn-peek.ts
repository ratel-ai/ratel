/**
 * A turn opened beside a list, in the list page's address (pure): the turn,
 * and the call it is about, when there is one.
 */
export const TURN_PEEK = "turn";
export const CALL_PEEK = "call";

export interface TurnPeek {
  turnId: string;
  eventId: string | null;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const uuidOf = (raw: string | readonly string[] | undefined): string | null => {
  const value = typeof raw === "string" ? raw : raw?.[0];
  return value && UUID.test(value) ? value : null;
};

/** The turn a page URL opens beside its list; null when it names none. */
export function parseTurnPeek(
  search: Readonly<Record<string, string | string[] | undefined>>,
): TurnPeek | null {
  const turnId = uuidOf(search[TURN_PEEK]);
  return turnId ? { turnId, eventId: uuidOf(search[CALL_PEEK]) } : null;
}

/** An address's query with this turn open in it. */
export function withTurnPeek(search: string, peek: TurnPeek): string {
  const query = new URLSearchParams(search);
  query.set(TURN_PEEK, peek.turnId);
  if (peek.eventId) query.set(CALL_PEEK, peek.eventId);
  else query.delete(CALL_PEEK);
  return `?${query.toString()}`;
}
