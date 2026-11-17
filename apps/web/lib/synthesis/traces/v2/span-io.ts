import type { CloudMessage } from "@/lib/ingest/cloud-schema";
import { GEN_AI } from "@/lib/ingest/otlp/constants";
import { mapMessages, systemFromInstructions } from "@/lib/ingest/otlp/content";
import { splitPromptMessages } from "@/lib/ingest/otlp/normalize-ai-sdk";
import { mastraMessageList } from "@/lib/ingest/otlp/semconv/mastra-content";
import type { AttrValue } from "@/lib/ingest/otlp/types";
import type { TraceContentView, TraceMessageView } from "@/lib/synthesis/traces/content-view";
import { messageText } from "@/lib/synthesis/traces/content-view";

/**
 * One span's input and output for the span pane (RC-412): messages for a
 * model call, arguments and result for a tool call. The span's own
 * attributes win (stored, or raw from `otlp_raw_exports`); the run's
 * `events.payload` content fills in when they carry none. A wrapper step
 * (Mastra's `agent_step`, `model_generation`) shows its own `mastra.*`
 * input and output, else its nearest child model call's (RC-501).
 */
export type SpanIO =
  | {
      kind: "messages";
      source: Exclude<SpanIOSource, "child">;
      input: SpanMessage[];
      output: SpanMessage[];
    }
  | {
      kind: "messages";
      source: "child";
      childSpanId: string;
      input: SpanMessage[];
      output: SpanMessage[];
    }
  | { kind: "tool"; source: SpanIOSource; arguments: unknown; result: unknown }
  | { kind: "none" };

export type SpanIOSource = "span" | "payload" | "child";

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

/** Mastra's wrapper inputs and outputs, the step's own first. */
const MASTRA_KINDS = ["model_step", "model_generation", "agent_run"] as const;

/** `descendants`: the span's descendants in timeline order, so the first model call is the nearest. */
export function buildSpanIO(
  span: SpanIOInput,
  payload: TraceContentView | null,
  descendants: readonly SpanIOInput[] = [],
): SpanIO {
  if (span.spanClass === "tool") return toolIO(span, payload);
  if (span.spanClass === "llm_call") return messagesIO(span, payload);
  const own = mastraMessages(span.attributes);
  if (own) return { kind: "messages", source: "span", ...own };
  for (const child of descendants) {
    if (child.spanClass !== "llm_call") continue;
    const io = messagesIO(child, payload);
    if (io.kind === "messages")
      return {
        kind: "messages",
        source: "child",
        childSpanId: child.spanId,
        input: io.input,
        output: io.output,
      };
  }
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

/** A Mastra wrapper's `mastra.<kind>.input` / `.output`, read as gen_ai messages; null when it has neither. */
function mastraMessages(
  attributes: Readonly<Record<string, unknown>>,
): { input: SpanMessage[]; output: SpanMessage[] } | null {
  for (const kind of MASTRA_KINDS) {
    const input = attributes[`mastra.${kind}.input`];
    const output = attributes[`mastra.${kind}.output`];
    if (input === undefined && output === undefined) continue;
    const messages =
      typeof input === "string" && parsed(input) === input
        ? [{ role: "user", content: input }]
        : mastraMessageList(input as AttrValue | undefined);
    const { systemInstructions, inputMessages } = messages
      ? splitPromptMessages(JSON.stringify(messages))
      : {};
    const io = spanMessages({
      [GEN_AI.systemInstructions]: systemInstructions,
      [GEN_AI.inputMessages]: inputMessages,
      [GEN_AI.outputMessages]: mastraOutput(parsed(output)),
    });
    if (io.input.length > 0 || io.output.length > 0) return io;
  }
  return null;
}

/** Mastra's `{ text, toolCalls }` output (or plain text) as one gen_ai assistant message. */
function mastraOutput(value: unknown): string | undefined {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { text?: unknown; toolCalls?: unknown })
      : null;
  const text =
    typeof value === "string" ? value : typeof record?.text === "string" ? record.text : "";
  const calls = Array.isArray(record?.toolCalls)
    ? (record.toolCalls as { toolCallId?: unknown; toolName?: unknown; args?: unknown }[])
    : [];
  const parts = [
    ...(text ? [{ type: "text", content: text }] : []),
    ...calls.flatMap((call) =>
      typeof call?.toolName === "string"
        ? [
            {
              type: "tool_call",
              id: call.toolCallId,
              name: call.toolName,
              arguments: call.args ?? null,
            },
          ]
        : [],
    ),
  ];
  return parts.length > 0 ? JSON.stringify([{ role: "assistant", parts }]) : undefined;
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
