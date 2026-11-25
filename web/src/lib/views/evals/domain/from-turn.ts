import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import {
  messageText,
  type TraceMessageView,
  type TraceToolCallView,
} from "@/lib/synthesis/traces/content-view";
import { callInput, callMessages } from "@/lib/synthesis/traces/payload-content";
import { conversationMessages } from "@/lib/synthesis/traces/v2/conversation";
import { type CaseContent, type EarlierTurn, MAX_LIST, TOOL_NAME } from "./case";

/** What one turn recorded, as the traces pages read it. */
export type TurnContent = {
  ask: string | null;
  messages: readonly TraceMessageView[];
  toolCalls: readonly TraceToolCallView[];
  /** The messages as the agent sent them, when the calls kept them. The views above keep each text once. */
  conversation?: Conversation | null;
};

export type Conversation = { earlier: EarlierTurn[]; ask: string; answer: string | null };

export type CaseFromTurn = { name: string; content: CaseContent; sourceOutput: string | null };

/** Neutral: a name reaches readers that may not read captured text. */
const NAME = "Case from a turn";
const SOURCE_OUTPUT_CHARS = 64 * 1024;

/**
 * A case from a turn. `readOnlyTools` are the tools that run for real in a sandbox, so they need
 * no fixture. A tool that no sandbox declares counts as one with side effects. Null: the turn has
 * no captured input.
 */
export function caseFromTurn(
  turn: TurnContent,
  readOnlyTools: ReadonlySet<string>,
): CaseFromTurn | null {
  const { conversation } = turn;
  const messages = conversationMessages(turn.messages);
  const own = messages.filter((message) => !message.earlier);
  const asked = own
    .filter(({ role }) => role === "user")
    .map(({ text }) => text)
    .join("\n\n");
  const text = conversation?.ask || asked || turn.ask;
  if (!text) return null;
  return {
    name: NAME,
    content: {
      input: inputOf(text),
      earlierTurns: (conversation?.earlier ?? messages.flatMap(earlierTurn)).slice(-MAX_LIST),
      toolFixtures: turn.toolCalls
        .filter((call) => !call.earlier && call.result !== null && !readOnlyTools.has(call.name))
        // No sandbox tool can have another name, so no fixture of it can match.
        .filter((call) => TOOL_NAME.test(call.name))
        .slice(0, MAX_LIST)
        .map((call) => ({
          tool: call.name,
          arguments: call.arguments ?? null,
          result: call.result ?? null,
        })),
      expectedOutput: null,
      scorers: [],
    },
    sourceOutput:
      (conversation?.answer ?? own.findLast(({ role }) => role === "assistant")?.text)?.slice(
        0,
        SOURCE_OUTPUT_CHARS,
      ) ?? null,
  };
}

/** The conversation of the calls of one trace, in order. Null when no call kept the person's text. */
export function recordedConversation(calls: readonly CloudEvent[]): Conversation | null {
  for (const call of calls) {
    const input = callInput(call);
    const at = input.findLastIndex((message) => message.role === "user" && messageText(message));
    const ask = input[at];
    if (!ask) continue;
    const last = calls.at(-1);
    const answer = last && callMessages(last).findLast((message) => message.role === "assistant");
    return {
      earlier: input.slice(0, at).flatMap(textTurn),
      ask: messageText(ask),
      answer: (answer && messageText(answer)) || null,
    };
  }
  return null;
}

function textTurn(message: CloudMessage): EarlierTurn[] {
  const { role } = message;
  const text = messageText(message);
  return text && (role === "user" || role === "assistant") ? [{ role, text }] : [];
}

function earlierTurn({ role, text, earlier }: TraceMessageView): EarlierTurn[] {
  return earlier && (role === "user" || role === "assistant") ? [{ role, text }] : [];
}

/** The recorded JSON input of a sandbox run, else the person's message. */
function inputOf(text: string): object {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null) return value;
  } catch {
    // A message is text.
  }
  return { message: text };
}
