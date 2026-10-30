import type { InvokeOutcome, StepDraft, TurnEndedBy, TurnSource } from "@/lib/ledger/types";
import { tokenize } from "@/lib/readings/text/cluster";
import { isRetryRequest } from "@/lib/readings/topics/sentiment";
import type { AskSourceKind } from "@/lib/readings/topics/types";
import {
  ASKED_AGAIN_MAX_GAP_MS,
  askedAgain,
  nextInSession,
  readsTurn,
  type SelfCorrectionTrust,
} from "@/lib/readings/trace-signals/self-corrections/detect";
import {
  hashText,
  normalizeAsk,
  preferUserAsks,
} from "@/lib/readings/trace-signals/workflows/decide";
import type { AskSource } from "@/lib/readings/trace-signals/workflows/label-queries";

/**
 * The asks a reading groups: each turn's ask (the user's message, else the
 * OTel prompt, else the agent's first search), the users' own words winning
 * once there are enough of them (`preferUserAsks`), folded into distinct asks.
 * A turn that asks the previous turn's question again in the same session is
 * a retry, read with the one asked-again rule (`self-corrections/detect.ts`).
 * Pure: no clock, no I/O.
 */

/** Longest ask text read; the rest of a long prompt adds nothing to a topic. */
export const MAX_ASK_CHARS = 500;

/** One closed turn as a reading keeps it: no text, only what topics and flows need. */
export interface TopicTurn {
  id: string;
  sessionId: string;
  endUserKey: string | null;
  turnSource: TurnSource;
  startedAt: Date;
  endedAt: Date;
  endedBy: TurnEndedBy | null;
  /** Tool and skill calls in order, as node ids (`skill:<id>` for a skill). */
  calls: { tool: string; outcome: InvokeOutcome | null }[];
  /** The turn's first search step, to tell a repeated ask without text. */
  firstSearch: StepDraft | null;
  /** The task (`trace_turns.workflow_id`) the run belongs to. */
  workflowId: string | null;
  /** The OpenTelemetry trace the turn is, when it is one: where its captured reply is found. */
  traceId?: string | null;
  /** Its captured final reply says the agent could not do it ("I can't book rentals"). */
  refused?: boolean;
  /** A skill search in the turn returned at least one skill, whether or not it ran. */
  skillOffered?: boolean;
}

/** A turn's ask as a reading uses it. */
export interface TurnAskText {
  text: string;
  source: AskSourceKind;
}

/** Whether the ask is the user's own words (their message or a prompt), never an agent's search. */
export function isUserWords(source: AskSourceKind): boolean {
  return source !== "search";
}

/**
 * Answered: a tool ran and the turn did not end on a failed call. No call, or
 * giving up, is unanswered; so is a turn whose captured reply says the agent
 * could not do it, whatever it looked up first.
 */
export function isAnswered(turn: Pick<TopicTurn, "calls" | "refused">): boolean {
  const last = turn.calls.at(-1);
  return last !== undefined && last.outcome !== "error" && turn.refused !== true;
}

const SOURCE: Record<AskSource, AskSourceKind> = {
  user_message: "user",
  prompt: "prompt",
  search: "search",
};

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ASK_CHARS ? flat.slice(0, MAX_ASK_CHARS) : flat;
}

/**
 * Each turn's ask to read. Once at least `min` turns carry the users' own
 * words, the search stand-ins are dropped: those turns have no ask.
 */
export function chooseAsks(
  asks: ReadonlyMap<string, { text: string; source: AskSource }>,
  min?: number,
): Map<string, TurnAskText> {
  const all = [...asks].flatMap(([turnId, ask]) => {
    const text = clip(ask.text);
    if (text === "") return [];
    const kind = SOURCE[ask.source] ?? "search";
    return [
      { turnId, text, kind, source: kind === "search" ? ("search" as const) : ("user" as const) },
    ];
  });
  const kept = preferUserAsks(all, min);
  return new Map(kept.map((ask) => [ask.turnId, { text: ask.text, source: ask.kind }]));
}

/** One distinct ask (same words once case and spacing are normalized) and the turns that asked it. */
export interface DistinctAsk {
  /** The normalized text. */
  key: string;
  /** `hashText(key)`: how verdicts are cached and turns remember their ask. */
  hash: string;
  /** The ask as one turn put it (the newest). */
  text: string;
  /** Newest first. */
  turnIds: string[];
  /** Whether any of its turns carried the user's own words. */
  user: boolean;
  tokens: ReadonlySet<string>;
}

/**
 * Distinct asks of the given turns, busiest first (then newest). Turns with
 * no ask, and retries (they ask a question already counted), are left out.
 */
export function distinctAsks(
  turns: readonly Pick<TopicTurn, "id" | "startedAt">[],
  asks: ReadonlyMap<string, TurnAskText>,
  skip: ReadonlySet<string> = new Set(),
): DistinctAsk[] {
  const newestFirst = [...turns].sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? -1 : 1),
  );
  const byKey = new Map<
    string,
    { text: string; turnIds: string[]; user: boolean; newest: number }
  >();
  for (const turn of newestFirst) {
    if (skip.has(turn.id)) continue;
    const ask = asks.get(turn.id);
    if (!ask) continue;
    const key = normalizeAsk(ask.text);
    if (key === "") continue;
    const entry = byKey.get(key);
    if (entry) {
      entry.turnIds.push(turn.id);
      entry.user ||= isUserWords(ask.source);
    } else {
      byKey.set(key, {
        text: ask.text,
        turnIds: [turn.id],
        user: isUserWords(ask.source),
        newest: turn.startedAt.getTime(),
      });
    }
  }
  return [...byKey]
    .map(([key, entry]) => ({ key, ...entry }))
    .sort(
      (a, b) =>
        b.turnIds.length - a.turnIds.length || b.newest - a.newest || (a.key < b.key ? -1 : 1),
    )
    .map(({ key, text, turnIds, user }) => ({
      key,
      hash: hashText(key),
      text,
      turnIds,
      user,
      tokens: new Set(tokenize(key)),
    }));
}

/** Whether `next` is the same user's turn right after `turn`, close enough to be about it. */
function followsClosely(turn: TopicTurn, next: TopicTurn): boolean {
  const gap = next.startedAt.getTime() - turn.endedAt.getTime();
  return turn.endedBy !== "cap" && gap >= 0 && gap <= ASKED_AGAIN_MAX_GAP_MS;
}

/**
 * Turns that ask the same user's previous turn's question again, mapped to
 * that previous turn: the asked-again rule of `self-corrections/detect.ts`
 * (their own words when both turns carry them, else the two first searches),
 * or, in their own words, a short request to try again ("Still nothing? Try
 * once more."), only where the run-boundary rules trust sessions and read
 * both runs.
 */
export function retryTurns(
  turns: readonly TopicTurn[],
  asks: ReadonlyMap<string, TurnAskText>,
  trust: SelfCorrectionTrust,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!trust.sessions) return out;
  const asRead = turns.map((turn) => {
    const ask = asks.get(turn.id);
    return {
      ...turn,
      askText: ask && isUserWords(ask.source) ? ask.text : null,
      steps: turn.firstSearch ? [turn.firstSearch] : [],
    };
  });
  const nexts = nextInSession(asRead);
  asRead.forEach((turn, index) => {
    const next = nexts[index];
    if (!next || !readsTurn(trust, turn.turnSource) || !readsTurn(trust, next.turnSource)) return;
    if (askedAgain(turn, next, { sessionsTrusted: true }) === true) out.set(next.id, turn.id);
    else if (next.askText && isRetryRequest(next.askText) && followsClosely(turn, next))
      out.set(next.id, turn.id);
  });
  return out;
}
