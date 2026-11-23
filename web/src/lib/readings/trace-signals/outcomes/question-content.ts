import { getConfig } from "@/config";
import { sliceWellFormed } from "@/lib/readings/text/well-formed";

/**
 * The text a question is asked about, kept short before it is sent. A request
 * to Sage 2 is never truncated by the server, only refused, and every
 * question is billed for the content it reads, so long text is clipped here.
 *
 * PRIVACY: an agent's reply is captured content. It is put into a question
 * only for a project that captures content, and like every text here it is
 * read in memory, sent and dropped: never stored or logged.
 */

/** Characters of a user's message a question reads. Env `TRACE_OUTCOMES_MAX_MESSAGE_CHARS`, default 1,500. */
export const OUTCOME_MAX_MESSAGE_CHARS = getConfig().traceOutcomes.maxMessageChars;

/** Characters of an agent's reply a question reads. Env `TRACE_OUTCOMES_MAX_REPLY_CHARS`, default 1,200. */
export const OUTCOME_MAX_REPLY_CHARS = getConfig().traceOutcomes.maxReplyChars;

const CUT = " […]";

/** `text` with its whitespace runs collapsed, cut to `max` characters with a mark where it was cut. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max
    ? flat
    : `${sliceWellFormed(flat, Math.max(0, max - CUT.length)).trimEnd()}${CUT}`;
}

/**
 * The reply a question may read: clipped, and only when the project captures
 * content. Null when there is none to send.
 */
export function replyToSend(
  reply: string | null | undefined,
  contentCapture: boolean,
  max: number = OUTCOME_MAX_REPLY_CHARS,
): string | null {
  if (!contentCapture || !reply) return null;
  return clip(reply, max) || null;
}
