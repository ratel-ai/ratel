import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import { messageText } from "@/lib/synthesis/traces/content-view";

/**
 * The recorded reply of a sandbox item's model call (RC-1103). Ingest strips
 * content from `otel_spans`, so the reply comes from the call's ADR-0013
 * payload in `events.payload`: its own `output`, else the assistant messages
 * after the input. Parsed as JSON when it parses, the way a structured sandbox
 * returns it; null when the call stored no reply.
 */
export function recordedReply(payload: CloudEvent | null | undefined): unknown {
  if (!payload) return null;
  const text = replyMessages(payload)
    .filter((message) => message.role === "assistant")
    .map((message) => messageText(message))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: the reply is plain text.
    return text;
  }
}

function replyMessages(payload: CloudEvent): CloudMessage[] {
  if (payload.output && payload.output.length > 0) return payload.output;
  if (payload.input_message_count === undefined) return [];
  return (payload.messages ?? []).slice(payload.input_message_count);
}
