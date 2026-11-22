import type {
  CloudMessage,
  CloudToolDef,
  MessageContent,
  ToolCallBlock,
} from "@/lib/ingest/cloud-schema";
import type { RowContent } from "./rows";

/**
 * The export format (RC-1131, decision `backend-later`): one OpenAI chat
 * fine-tuning example per row, `{"messages": [...], "tools": [...]}`. The
 * system text is the first message, the input messages follow, and the
 * recorded reply ends the list as the last assistant message, with its tool
 * calls. Pure.
 *
 * A row the format cannot express is skipped with a reason, never sent half
 * mapped: no assistant message in the reply, an assistant reply with no text
 * and no tool call, no input message, or an image or file block.
 */

export const EXPORT_SKIP_REASONS = [
  "no_reply",
  "empty_reply",
  "no_input",
  "unsupported_content",
] as const;
export type ExportSkipReason = (typeof EXPORT_SKIP_REASONS)[number];

export type ChatExample = { ok: true; line: string } | { ok: false; reason: ExportSkipReason };

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

class Unsupported extends Error {}

/** One row as one JSONL line (no trailing newline), or why it is skipped. */
export function toChatExample(content: RowContent): ChatExample {
  if (content.messages.length === 0) return { ok: false, reason: "no_input" };
  const lastReply = content.output.findLastIndex((message) => message.role === "assistant");
  if (lastReply < 0) return { ok: false, reason: "no_reply" };
  const reply = content.output.slice(0, lastReply + 1);
  try {
    const messages: ChatMessage[] = [
      ...(content.system ? [{ role: "system" as const, content: content.system }] : []),
      ...content.messages.map(chatMessage),
      ...reply.map(chatMessage),
    ];
    const last = messages[messages.length - 1] as Extract<ChatMessage, { role: "assistant" }>;
    if (!last.content?.trim() && !last.tool_calls?.length)
      return { ok: false, reason: "empty_reply" };
    const tools = content.tools?.length ? { tools: content.tools.map(chatTool) } : {};
    return { ok: true, line: JSON.stringify({ messages, ...tools }) };
  } catch (err) {
    if (err instanceof Unsupported) return { ok: false, reason: "unsupported_content" };
    throw err;
  }
}

function chatMessage(message: CloudMessage): ChatMessage {
  switch (message.role) {
    case "user":
      return { role: "user", content: textOf(message.content) };
    case "tool":
      return { role: "tool", tool_call_id: message.tool_call_id, content: message.content };
    case "assistant": {
      const calls =
        typeof message.content === "string"
          ? []
          : message.content.filter((block): block is ToolCallBlock => block.type === "tool_call");
      const text = textOf(message.content);
      return {
        role: "assistant",
        content: text.length > 0 || calls.length === 0 ? text : null,
        ...(calls.length > 0 ? { tool_calls: calls.map(chatToolCall) } : {}),
      };
    }
  }
}

/** The text of a message; a tool call is carried apart. An image or a file has no text form here. */
function textOf(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_call") return "";
      throw new Unsupported(block.type);
    })
    .join("");
}

function chatToolCall(block: ToolCallBlock): ChatToolCall {
  return {
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: JSON.stringify(block.arguments) },
  };
}

function chatTool(tool: CloudToolDef) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  };
}
