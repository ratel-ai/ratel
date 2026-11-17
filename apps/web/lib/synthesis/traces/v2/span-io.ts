import type { CloudMessage } from "@/lib/ingest/cloud-schema";
import { GEN_AI } from "@/lib/ingest/otlp/constants";
import { mapMessages, systemFromInstructions } from "@/lib/ingest/otlp/content";
import type { AttrValue } from "@/lib/ingest/otlp/types";
import type { TraceContentView, TraceMessageView } from "@/lib/synthesis/traces/content-view";
import { messageText } from "@/lib/synthesis/traces/content-view";

/**
 * One span's input and output for the span pane (RC-412): messages for a
 * model call, arguments and result for a tool call. The span's own
 * attributes win (stored, or raw from `otlp_raw_exports`); the run's
 * `events.payload` content fills in when they carry none.
 */
export type SpanIO =
  | { kind: "messages"; source: SpanIOSource; input: SpanMessage[]; output: SpanMessage[] }
  | { kind: "tool"; source: SpanIOSource; arguments: unknown; result: unknown }
  | { kind: "none" };

export type SpanIOSource = "span" | "payload";

export interface SpanMessage {
  role: TraceMessageView["role"];
  text: string;
  toolCalls: { name: string; arguments: unknown }[];
}

export interface SpanIOInput {
  spanId: string;
  spanClass: string;
  attributes: Readonly<Record<string, unknown>>;
}

export function buildSpanIO(span: SpanIOInput, payload: TraceContentView | null): SpanIO {
  if (span.spanClass === "tool") return toolIO(span, payload);
  if (span.spanClass === "llm_call") return messagesIO(span, payload);
  return { kind: "none" };
}

function toolIO(span: SpanIOInput, payload: TraceContentView | null): SpanIO {
  const args = parsed(span.attributes[GEN_AI.toolCallArguments]);
  const result = parsed(span.attributes[GEN_AI.toolCallResult]);
  if (args !== null || result !== null)
    return { kind: "tool", source: "span", arguments: args, result };
  const callId = span.attributes[GEN_AI.toolCallId];
  const call =
    typeof callId === "string"
      ? payload?.toolCalls.find((candidate) => candidate.id === callId)
      : undefined;
  if (call && (call.arguments !== null || call.result !== null)) {
    return { kind: "tool", source: "payload", arguments: call.arguments, result: call.result };
  }
  return { kind: "none" };
}

function messagesIO(span: SpanIOInput, payload: TraceContentView | null): SpanIO {
  const fromSpan = spanMessages(span.attributes);
  if (fromSpan.input.length > 0 || fromSpan.output.length > 0)
    return { kind: "messages", source: "span", ...fromSpan };
  const prefix = `${span.spanId}:`;
  const own = (payload?.messages ?? []).filter((message) => message.id.startsWith(prefix));
  const calls = (payload?.toolCalls ?? [])
    .filter((call) => call.spanId === span.spanId)
    .map((call) => ({ name: call.name, arguments: call.arguments }));
  if (own.length === 0 && calls.length === 0) return { kind: "none" };
  // The payload keeps no input/output split: the call's answer is its trailing assistant messages.
  let split = own.length;
  while (split > 0 && own[split - 1].role === "assistant") split -= 1;
  const toMessage = ({ role, text }: TraceMessageView): SpanMessage => ({
    role,
    text,
    toolCalls: [],
  });
  const output = own.slice(split).map(toMessage);
  if (calls.length > 0) {
    const last = output.at(-1);
    if (last) last.toolCalls = calls;
    else output.push({ role: "assistant", text: "", toolCalls: calls });
  }
  return { kind: "messages", source: "payload", input: own.slice(0, split).map(toMessage), output };
}

function spanMessages(attributes: Readonly<Record<string, unknown>>): {
  input: SpanMessage[];
  output: SpanMessage[];
} {
  const mapped = mapMessages(
    parsed(attributes[GEN_AI.inputMessages]) as AttrValue | undefined,
    parsed(attributes[GEN_AI.outputMessages]) as AttrValue | undefined,
  );
  const system = [
    systemFromInstructions(
      (parsed(attributes[GEN_AI.systemInstructions]) ?? undefined) as AttrValue | undefined,
    ),
    mapped.system,
  ]
    .filter(Boolean)
    .join("\n");
  const toView = (message: CloudMessage): SpanMessage => ({
    role: message.role,
    text: messageText(message),
    toolCalls:
      message.role === "assistant" && typeof message.content !== "string"
        ? message.content.flatMap((block) =>
            block.type === "tool_call" ? [{ name: block.name, arguments: block.arguments }] : [],
          )
        : [],
  });
  const keep = (message: SpanMessage) => message.text !== "" || message.toolCalls.length > 0;
  return {
    input: [
      ...(system ? [{ role: "system" as const, text: system, toolCalls: [] }] : []),
      ...mapped.messages.slice(0, mapped.inputCount).map(toView).filter(keep),
    ],
    output: mapped.messages.slice(mapped.inputCount).map(toView).filter(keep),
  };
}

/** An attribute value as data: JSON strings parsed, other strings kept as text, absent as null. */
function parsed(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
