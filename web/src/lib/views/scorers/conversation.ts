import { buildTraceContentView, preferSpanContent } from "@/lib/synthesis/traces/content-view";
import { loadPayloadContentSafely } from "@/lib/synthesis/traces/payload-content";
import { getTraceSpansWithTruncation } from "@/lib/synthesis/traces/queries";
import { conversationMessages } from "@/lib/synthesis/traces/v2/conversation";
import { buildTraceWaterfall } from "@/lib/synthesis/traces/waterfall";
import { contentOptIn } from "@/lib/views/session-replay/runs";

/** What was asked in a trace, and what the agent answered; captured text, so never logged. */
export interface TraceConversation {
  input: string;
  output: string;
}

/**
 * The trace's conversation, read as `get_trace_conversation` reads it. Null when no message content
 * was captured, or when the project does not let the product read it.
 */
export async function loadTraceConversation(
  projectId: string,
  traceId: string,
): Promise<TraceConversation | null> {
  if (!(await contentOptIn(projectId))) return null;
  const { spans } = await getTraceSpansWithTruncation(projectId, traceId);
  const ordered = buildTraceWaterfall(spans).rows.map((row) => row.span);
  const payload = await loadPayloadContentSafely(projectId, traceId, "scorer_judge");
  const content = preferSpanContent(buildTraceContentView(ordered), payload?.view ?? null);
  const messages = conversationMessages(content.messages).filter((message) => !message.earlier);
  const input = messages
    .filter((message) => message.role === "user")
    .map((message) => message.text)
    .join("\n\n");
  const output = messages.findLast((message) => message.role === "assistant")?.text ?? "";
  return input || output ? { input, output } : null;
}
