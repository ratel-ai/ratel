/**
 * What the trace and session views call one agent run. With
 * `cloud-trace-views-v3` (RC-413) the UI says "Turn"; without it, "Run" as
 * before. Only UI text changes: code identifiers, routes, MCP tool names and
 * stored data keep "run".
 */
export interface RunNoun {
  one: "Run" | "Turn";
  many: "Runs" | "Turns";
  lower: "run" | "turn";
  lowerMany: "runs" | "turns";
}

export const RUN_NOUN: RunNoun = { one: "Run", many: "Runs", lower: "run", lowerMany: "runs" };
export const TURN_NOUN: RunNoun = { one: "Turn", many: "Turns", lower: "turn", lowerMany: "turns" };

/** Characters of an id an untitled title keeps. */
const SHORT_ID = 8;

export function runNoun(viewsV3: boolean): RunNoun {
  return viewsV3 ? TURN_NOUN : RUN_NOUN;
}

/** "Untitled turn · 35d8a7b7": a title in place of a raw id. */
export function untitledTitle(kind: "turn" | "session", id: string): string {
  return `Untitled ${kind} · ${id.slice(0, SHORT_ID)}`;
}

/** The session page's title: its first ask, else untitled. Without the flag, the session id as before. */
export function sessionPageTitle(
  sessionId: string,
  asks: readonly (string | null)[],
  viewsV3: boolean,
): string {
  if (!viewsV3) return sessionId;
  const ask = asks.map((text) => text?.replace(/\s+/g, " ").trim()).find(Boolean);
  return ask ?? untitledTitle("session", sessionId);
}
