/**
 * The full trace's Conversation tab. Every model call carries the whole
 * history as its input, so the raw message list repeats itself once per call;
 * the conversation keeps each message once, where it first appeared.
 */

import type { TraceMessageView } from "@/lib/synthesis/traces/content-view";

export const ROLE_LABEL: Readonly<Record<TraceMessageView["role"], string>> = {
  system: "Instructions",
  user: "User",
  assistant: "Agent",
  tool: "Tool result",
};

export function conversationMessages(messages: readonly TraceMessageView[]): TraceMessageView[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = `${message.role}\u0000${message.text.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
