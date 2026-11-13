import type { InvokeOutcome, StepDraft } from "@/lib/ledger/types";
import { nodeIdOf } from "@/lib/readings/tool-explorer/units";
import {
  classifyReply,
  type PhraseMatch,
} from "@/lib/readings/trace-signals/self-corrections/phrases";

/**
 * The agent's own words in a turn, for the phrase kind of self-correction:
 * the reply each captured model call produced (content capture stores the
 * call in `events.payload`), classified by `phrases.ts`, and the tool call
 * that came before each phrase. Pure: the read is `queries.ts`.
 *
 * A stored call holds its input messages, then its output. The reply is the
 * output: the assistant messages after the last message that is not the
 * assistant's (the user's ask or a tool's result), their text blocks joined
 * by a blank line. Tool-call blocks carry no words and are skipped. An
 * assistant message inside the input repeats an earlier call's reply, so it
 * is never read again here; and the same reply captured twice in one turn
 * (an exporter that sends the output as the next call's input) counts once.
 *
 * The match ranges index into exactly this text, so an example is read back
 * by running {@link replyTextOf} on the same stored messages.
 */

/** Between two text blocks of one reply: a paragraph break, so no quote or code span reaches across. */
export const REPLY_BLOCK_SEPARATOR = "\n\n";

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The text blocks of one message's content: a bare string, or `text` blocks of an array. */
function textBlocks(content: Json): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return [];
    return block.text.trim() ? [block.text] : [];
  });
}

/**
 * The reply a stored model call produced: the text of its trailing assistant
 * messages, or null when it produced none (a tool call only, or nothing
 * captured). Reads any JSON defensively: the payload is customer-shaped.
 */
export function replyTextOf(messages: Json): string | null {
  if (!Array.isArray(messages)) return null;
  let first = messages.length;
  while (first > 0) {
    const message = messages[first - 1];
    if (!isRecord(message) || message.role !== "assistant") break;
    first -= 1;
  }
  const blocks = messages
    .slice(first)
    .flatMap((message) => (isRecord(message) ? textBlocks(message.content) : []));
  return blocks.length > 0 ? blocks.join(REPLY_BLOCK_SEPARATOR) : null;
}

/** One captured reply of a turn. */
export interface CapturedReply {
  /** The `events` row it was read from. */
  eventId: string;
  /** When the model call started (its event time). */
  at: Date;
  text: string;
}

/** A phrase match in a turn's reply, with where it sits and the call before it. */
export interface PhraseCorrection extends PhraseMatch {
  sourceEventId: string;
  occurredAt: Date;
  /** The last tool call that started before the reply, as a node id; null when the reply came first. */
  tool: string | null;
  toolOrdinal: number | null;
  toolOutcome: InvokeOutcome | null;
}

const byTimeThenId = (a: CapturedReply, b: CapturedReply): number =>
  a.at.getTime() - b.at.getTime() || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);

/** The calls of a turn (invocations with a target), in step order, with their node ids. */
function callsOf(steps: readonly StepDraft[]): { step: StepDraft; node: string }[] {
  return steps.flatMap((step) => {
    const node = nodeIdOf(step);
    return node === null ? [] : [{ step, node }];
  });
}

/**
 * Every phrase in a turn's replies, in reply order, each with the tool call
 * that started at or before its reply (the result the agent was answering).
 * Replies read earlier in the turn win over the same text read again.
 */
export function phraseCorrections(
  steps: readonly StepDraft[],
  replies: readonly CapturedReply[],
): PhraseCorrection[] {
  const calls = callsOf(steps);
  const seen = new Set<string>();
  return [...replies].sort(byTimeThenId).flatMap((reply) => {
    if (seen.has(reply.text)) return [];
    seen.add(reply.text);
    const before = calls
      .filter((call) => call.step.occurredAt.getTime() <= reply.at.getTime())
      .at(-1);
    return classifyReply(reply.text).map((match) => ({
      ...match,
      sourceEventId: reply.eventId,
      occurredAt: reply.at,
      tool: before?.node ?? null,
      toolOrdinal: before?.step.ordinal ?? null,
      toolOutcome: before?.step.outcome ?? null,
    }));
  });
}

/** How much text an example shows on each side of its phrase. */
export const EXAMPLE_CONTEXT_CHARS = 160;

export interface ReplyExcerpt {
  /** Text before the phrase, cut at a word and marked with an ellipsis when cut. */
  before: string;
  phrase: string;
  after: string;
}

/**
 * The phrase and the words around it, for an example. Null when the stored
 * range no longer fits the reply (the event changed or the text was cut).
 */
export function replyExcerpt(
  text: string,
  start: number,
  end: number,
  context: number = EXAMPLE_CONTEXT_CHARS,
): ReplyExcerpt | null {
  if (
    !(Number.isInteger(start) && Number.isInteger(end)) ||
    start < 0 ||
    end <= start ||
    end > text.length
  )
    return null;
  const from = Math.max(0, start - context);
  const to = Math.min(text.length, end + context);
  const head = text.slice(from, start);
  const tail = text.slice(end, to);
  // Cut at a word boundary, so the excerpt never opens or ends mid-word.
  const before = from > 0 ? `…${head.replace(/^\S*\s+/, "")}` : head;
  const after = to < text.length ? `${tail.replace(/\s+\S*$/, "")}…` : tail;
  return { before, phrase: text.slice(start, end), after };
}
