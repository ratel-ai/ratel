/**
 * What the session chat's side panel shows, as its `?peek=` id (RC-282): a
 * person's message (`ask:2`), a reply (`reply:2`), a work line (`work:2`) or
 * one timeline step (`step:7`). Pure.
 */

export type ChatPeek =
  | { kind: "ask" | "reply" | "work"; turnIndex: number }
  | { kind: "step"; stepIndex: number };

const PEEK = /^(ask|reply|work|step):([1-9]\d*)$/;

export function parseChatPeek(id: string | null | undefined): ChatPeek | null {
  const match = id ? PEEK.exec(id) : null;
  if (!match) return null;
  const n = Number(match[2]);
  if (!Number.isSafeInteger(n)) return null;
  return match[1] === "step"
    ? { kind: "step", stepIndex: n }
    : { kind: match[1] as "ask" | "reply" | "work", turnIndex: n };
}

export function chatPeekId(peek: ChatPeek): string {
  return peek.kind === "step" ? `step:${peek.stepIndex}` : `${peek.kind}:${peek.turnIndex}`;
}

/** The page's view from `?view=`: the chat, today's step list (`steps`), or a turn's full trace (`trace`). */
export type SessionPageView = "chat" | "steps" | "trace";

/**
 * The chat unless `?view=steps` or `?view=trace`; a repeated `?view=` reads as
 * its first value. The page itself exists only with `cloud-session-replay` on.
 */
export function sessionPageView(view: string | readonly string[] | undefined): SessionPageView {
  const first = firstOf(view);
  return first === "steps" || first === "trace" ? first : "chat";
}

/** The Trace view's turn: `?turn=` when the session has it, else its last turn; null without turns. */
export function traceViewTurn(
  turn: string | readonly string[] | undefined,
  turnIndexes: readonly number[],
): number | null {
  if (turnIndexes.length === 0) return null;
  const asked = Number(firstOf(turn));
  return turnIndexes.includes(asked) ? asked : turnIndexes[turnIndexes.length - 1]!;
}

/** The session's Trace view at a turn, and at one of its runs when picked. */
export function sessionTraceHref(
  projectId: string,
  sessionId: string,
  turnIndex: number,
  traceId?: string,
): string {
  const params = new URLSearchParams({ view: "trace", turn: String(turnIndex) });
  if (traceId) params.set("trace", traceId);
  return `/project/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`;
}

function firstOf(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}
