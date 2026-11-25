import type {
  OutcomeAsk,
  OutcomeQuestion,
  OutcomeVerdict,
} from "@/lib/readings/trace-signals/outcomes/ask";
import { REPLY_REACTIONS, type ReplyReaction } from "@/lib/readings/trace-signals/outcomes/kinds";
import {
  clip,
  OUTCOME_MAX_REPLY_CHARS,
} from "@/lib/readings/trace-signals/outcomes/question-content";
import { describeCalls, type QuestionCall } from "@/lib/readings/trace-signals/outcomes/questions";
import { classifyReply } from "@/lib/readings/trace-signals/self-corrections/phrases";

/**
 * How the person took a turn, read from the agent's NEXT reply when their own
 * message was not sent: a reply answers the message before it, and that
 * message reacts to the turn before it. "You're right, I stopped early" says
 * the person corrected the agent; "I've passed this to our billing team" says
 * they asked for a human; "You're welcome" says they were satisfied.
 *
 * Two readers, the same closed answers:
 *   - rules (`replyReactionByRule`), no model: the reply phrases the
 *     self-corrections read (apology, concession, admission) plus a few
 *     handoff and thanks patterns, in English and the languages Ratel's demo
 *     data uses. They see only what the reply says outright;
 *   - the reply question (`REPLY_QUESTION`), when the model layer is on: the
 *     work before and the reply, and what the reply shows about the message
 *     it answers ("Restored v2 and archived the 2024 one instead").
 * The model's answer wins over the rule's. Either is stored apart from the
 * person's own words (`reply_reaction`), and the page says it was inferred.
 *
 * What this cannot see: a person who leaves sends no message, so there is no
 * reply to read; and models apologise unprompted, so an apology is a hint.
 *
 * PRIVACY: replies are read in memory and dropped; only the closed answer is kept.
 */

export { REPLY_REACTIONS, type ReplyReaction } from "@/lib/readings/trace-signals/outcomes/kinds";

const HANDOFF =
  /\b(passed|handed|handing|escalat\w*|transferr\w*|connect(?:ing)? you)\b[^.]*\b(team|human|support|colleague|manager|agent|specialist)\b|\breach (?:the|our) (?:support )?team\b|\bsupport@|yetkili|temsilci|un agente humano|einen? Mitarbeiter/i;
const THANKS =
  /^\s*(you'?re (very )?welcome|glad (?:it|that|to)|happy to help|anytime|no problem|rica ederim|de nada|gern geschehen|bitte sehr)\b/i;
const CONCEDE =
  /\b(you'?re (?:absolutely )?right|my mistake|i was wrong|i misread|i stopped early|sorry about that|i apologi[sz]e)\b|haklısınız|tienes razón|perdón|entschuldig|du hast recht|sie haben recht/i;
const AGAIN = /\b(let me try (?:that )?again|trying again|retrying|one more time)\b/i;

/** What a reply says outright about the message it answers; null when it says nothing a rule can read. */
export function replyReactionByRule(reply: string | null | undefined): ReplyReaction | null {
  if (!reply || reply.trim() === "") return null;
  if (HANDOFF.test(reply)) return "asks_human";
  if (CONCEDE.test(reply)) return "corrects";
  const phrases = classifyReply(reply).map((match) => match.category);
  if (
    phrases.some(
      (category) => category === "apology" || category === "concession" || category === "admission",
    )
  )
    return "corrects";
  if (AGAIN.test(reply) || phrases.includes("retry")) return "repeats";
  if (THANKS.test(reply)) return "satisfied";
  return null;
}

const DESCRIPTIONS: Record<ReplyReaction | "cant_tell", string> = {
  satisfied: "The person thanked the agent or said the result was right.",
  corrects: "The person said the agent got something wrong or did something they did not ask for.",
  repeats: "The person asked again for the same thing.",
  asks_human: "The person asked for a human, a manager or a support team.",
  new_request: "The person moved on to something new.",
  cant_tell: "The reply does not show what the person said.",
};

export const REPLY_QUESTION: OutcomeQuestion = {
  id: "reply_reaction",
  version: 1,
  kind: "choice",
  instructions:
    "An AI agent did some work, then the person sent a message we cannot see, and the agent replied to it. What does the agent's reply show the person's message said about the work?",
  options: [...REPLY_REACTIONS, "cant_tell"].map((option) => ({
    option,
    description: DESCRIPTIONS[option as ReplyReaction | "cant_tell"],
  })),
};

/** The reply question's content: the work before, and the reply that answers the unseen message. */
export function replyContent(calls: readonly QuestionCall[], reply: string): string {
  return [
    `The agent did: ${describeCalls(calls)}`,
    `Then the person sent a message. The agent replied: ${clip(reply, OUTCOME_MAX_REPLY_CHARS)}`,
  ].join("\n");
}

export const replyAskKey = (turnId: string): string => `${turnId}:${REPLY_QUESTION.id}`;

/** The reply question about one turn: the turn's calls, and the reply of the turn after it. */
export function replyAsk(
  turnId: string,
  calls: readonly QuestionCall[],
  nextReply: string,
): OutcomeAsk {
  return {
    key: replyAskKey(turnId),
    question: REPLY_QUESTION,
    content: replyContent(calls, nextReply),
  };
}

/** A cached or fresh answer read back; null for can't tell, an abstention or no answer. */
export function replyReactionOf(verdict: OutcomeVerdict | undefined): ReplyReaction | null {
  return REPLY_REACTIONS.find((known) => known === verdict?.answer) ?? null;
}
