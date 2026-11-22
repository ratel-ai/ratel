import type { ChatCallText } from "./model";

/**
 * One model call's chat text from its ADR-0013 payload (RC-281): the person's
 * last message in the input (the ask) and the call's own reply, in full. The
 * reply is the stored `output` (RC-280) when present, else the assistant
 * messages after the input, else (rows stored before the input count) the
 * trailing assistant messages. Pure.
 */
export function chatTextOf(payload: unknown): ChatCallText {
  if (!payload || typeof payload !== "object") return { ask: null, reply: null };
  const {
    messages,
    input_message_count: inputCount,
    output,
  } = payload as { messages?: unknown; input_message_count?: unknown; output?: unknown };
  const all = Array.isArray(messages) ? (messages as RawMessage[]) : [];
  const split =
    typeof inputCount === "number" && inputCount >= 0 && inputCount <= all.length
      ? inputCount
      : trailingAssistantStart(all);
  const ask = [...all.slice(0, split)]
    .reverse()
    .find((message) => message?.role === "user" && textOf(message.content) !== "");
  const replies = Array.isArray(output) ? (output as RawMessage[]) : all.slice(split);
  const reply = replies
    .filter((message) => message?.role === "assistant")
    .map((message) => textOf(message?.content))
    .filter((text) => text !== "")
    .join("\n");
  return { ask: ask ? textOf(ask.content) : null, reply: reply === "" ? null : reply };
}

type RawMessage = { role?: unknown; content?: unknown } | null;

/** Where the messages after the last one that is not the assistant's begin. */
function trailingAssistantStart(messages: readonly RawMessage[]): number {
  let i = messages.length;
  while (i > 0 && messages[i - 1]?.role === "assistant") i -= 1;
  return i;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part?.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}
