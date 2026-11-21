/**
 * What the trace and session views call one agent run: a "Turn" (RC-413).
 * Only UI text says it: code identifiers, routes, MCP tool names and stored
 * data keep "run".
 */
export const TURN_NOUN = { one: "Turn", many: "Turns", lower: "turn", lowerMany: "turns" } as const;

export type RunNoun = typeof TURN_NOUN;

/** Characters of an id an untitled title keeps. */
const SHORT_ID = 8;

/** The list of runs under Traces: the Turns tab, after Sessions (RC-503). */
export function runsListPath(tracesPath: string): string {
  return `${tracesPath}/turns`;
}

/** "Untitled turn · 35d8a7b7": a title in place of a raw id. */
export function untitledTitle(kind: "turn" | "session", id: string): string {
  return `Untitled ${kind} · ${id.slice(0, SHORT_ID)}`;
}

/** The session page's title: its first ask, else untitled. */
export function sessionPageTitle(sessionId: string, asks: readonly (string | null)[]): string {
  const ask = asks.map((text) => text?.replace(/\s+/g, " ").trim()).find(Boolean);
  return ask ?? untitledTitle("session", sessionId);
}
