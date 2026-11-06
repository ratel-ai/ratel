import type { CloudMessage, ContentBlock } from "@/lib/ingest/cloud-schema";
import { GEN_AI } from "@/lib/ingest/otlp/constants";
import { mapMessages, systemFromInstructions } from "@/lib/ingest/otlp/content";
import type { AttrValue } from "@/lib/ingest/otlp/types";

interface TraceContentSpan {
  spanId: string;
  name: string;
  spanClass: string;
  durationMs: number;
  statusCode: number;
  attributes: Readonly<Record<string, unknown>>;
}

export interface TraceMessageView {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  text: string;
}

export interface TraceToolCallView {
  id: string;
  name: string;
  arguments: unknown | null;
  result: unknown | null;
  spanId: string;
  durationMs: number;
  statusCode: number;
}

export interface TraceContentView {
  messages: TraceMessageView[];
  toolCalls: TraceToolCallView[];
  contentCaptured: boolean;
}

/** Build the detail-page conversation/tool model from any retained span content. */
export function buildTraceContentView(spans: readonly TraceContentSpan[]): TraceContentView {
  const messages: TraceMessageView[] = [];
  const toolCalls: TraceToolCallView[] = [];
  let contentCaptured = false;

  for (const span of spans) {
    const attributes = span.attributes;
    const input = structuredAttribute(attributes, GEN_AI.inputMessages);
    const output = structuredAttribute(attributes, GEN_AI.outputMessages);
    const mapped = mapMessages(input, output);
    const systemRaw =
      structuredAttribute(attributes, GEN_AI.systemInstructions) ??
      stringAttribute(attributes, GEN_AI.systemInstructions);
    const system = systemFromInstructions(systemRaw);
    if (system) {
      messages.push({ id: span.spanId, role: "system", text: system });
      contentCaptured = true;
    }

    const results = toolResults(mapped.messages);
    for (const [index, message] of mapped.messages.entries()) {
      const text = messageText(message);
      if (text) {
        messages.push({
          id: `${span.spanId}:${index}`,
          role: message.role,
          text,
        });
        contentCaptured = true;
      }
      if (message.role !== "assistant" || typeof message.content === "string") {
        continue;
      }
      for (const block of message.content) {
        if (block.type !== "tool_call") continue;
        toolCalls.push({
          id: block.id || `${span.spanId}:${toolCalls.length}`,
          name: block.name,
          arguments: block.arguments,
          result: block.id ? (results.get(block.id) ?? null) : null,
          spanId: span.spanId,
          durationMs: span.durationMs,
          statusCode: span.statusCode,
        });
        contentCaptured = true;
      }
    }

    if (span.spanClass !== "tool") continue;
    const argumentsValue = valueOrNull(structuredAttribute(attributes, GEN_AI.toolCallArguments));
    const resultValue = valueOrNull(structuredAttribute(attributes, GEN_AI.toolCallResult));
    toolCalls.push({
      id: stringAttribute(attributes, GEN_AI.toolCallId) ?? span.spanId,
      name: stringAttribute(attributes, GEN_AI.toolName) ?? span.name,
      arguments: argumentsValue,
      result: resultValue,
      spanId: span.spanId,
      durationMs: span.durationMs,
      statusCode: span.statusCode,
    });
    contentCaptured ||= argumentsValue !== null || resultValue !== null;
  }

  return { messages, toolCalls, contentCaptured };
}

function structuredAttribute(
  attributes: Readonly<Record<string, unknown>>,
  key: string,
): AttrValue | undefined {
  const value = attributes[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as AttrValue;
    } catch {
      return undefined;
    }
  }
  return value as AttrValue;
}

function stringAttribute(
  attributes: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = attributes[key];
  return typeof value === "string" ? value : undefined;
}

function toolResults(messages: readonly CloudMessage[]): Map<string, unknown> {
  return new Map(
    messages.flatMap((message): [string, unknown][] =>
      message.role === "tool" ? [[message.tool_call_id, parseJson(message.content)]] : [],
    ),
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function messageText(message: CloudMessage): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .flatMap((block) => blockText(block))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function blockText(block: ContentBlock): string[] {
  if (block.type === "text") return [block.text];
  if (block.type === "image") return ["[Image attachment]"];
  if (block.type === "file") return ["[File attachment]"];
  return [];
}

function valueOrNull(value: AttrValue | undefined): AttrValue | null {
  return value === undefined ? null : value;
}
