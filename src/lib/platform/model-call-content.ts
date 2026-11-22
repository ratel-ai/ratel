import type { Attributes } from "@opentelemetry/api";

/**
 * The gen_ai content attributes ingest reads back (`GEN_AI` in lib/ingest/otlp/constants.ts).
 * Owned (ADR-0004): spelled here, since the platform layer does not import ingest.
 */
const GEN_AI = {
  systemInstructions: "gen_ai.system_instructions",
  inputMessages: "gen_ai.input.messages",
  outputMessages: "gen_ai.output.messages",
} as const;

/**
 * The prompt and answer of a Ratel-paid model call, as `gen_ai.*` content
 * attributes on its self-telemetry span (RC-721), for every organization.
 *
 * Parts follow the gen_ai v1.42.0 message shape that ingest reads back
 * (lib/otlp/content.ts): `text`, `reasoning`, `tool_call` and
 * `tool_call_response`. Images and documents stay out. The content is the
 * prompt Ratel built and the answer the model gave: never a key or a header,
 * which live on the client, not in the request body.
 *
 * Each attribute is capped at `MODEL_CALL_CONTENT_MAX_CHARS`: a long text is
 * cut with a `[truncated]` mark, then the oldest messages go first, so the
 * last ask always survives.
 */

/** The longest a content attribute may be, in characters of its JSON. */
export const MODEL_CALL_CONTENT_MAX_CHARS = 32_000;

const PART_MAX_CHARS = MODEL_CALL_CONTENT_MAX_CHARS / 2;
const TRUNCATED = "…[truncated]";

export type ContentPart =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_call_response"; id: string; response: unknown };

export interface ContentMessage {
  role: "user" | "assistant" | "system" | "tool";
  parts: ContentPart[];
  finish_reason?: string;
}

/** What a call offers to show: its prompt now, its answer once it has one. */
export interface ModelCallContent<T> {
  system?: ContentPart[];
  input: ContentMessage[];
  output?: (result: T) => ContentMessage[];
}

/** The content attributes for a call: the prompt always, the answer when there is one. */
export function contentAttributes<T>(
  content: ModelCallContent<T>,
  ...answer: [] | [T]
): Attributes {
  const attributes: Attributes = {};
  // Well-formed, as every provider request is (lib/text/well-formed.ts): a lone surrogate must not break the export.
  if (content.system?.length)
    attributes[GEN_AI.systemInstructions] = cappedParts(content.system).toWellFormed();
  if (content.input.length)
    attributes[GEN_AI.inputMessages] = cappedMessages(content.input).toWellFormed();
  if (answer.length && content.output) {
    const output = content.output(answer[0] as T);
    if (output.length) attributes[GEN_AI.outputMessages] = cappedMessages(output).toWellFormed();
  }
  return attributes;
}

/** The Anthropic Messages API blocks content reads; anything else is left out. */
type AnthropicBlock = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
};

export interface AnthropicRequestContent {
  system?: string | ReadonlyArray<AnthropicBlock> | null;
  messages: ReadonlyArray<{
    role: "user" | "assistant" | "system";
    content: string | ReadonlyArray<AnthropicBlock>;
  }>;
}

export interface AnthropicAnswerContent {
  content: ReadonlyArray<AnthropicBlock>;
  stop_reason?: string | null;
}

/** The content of a Messages API request; its answer is read off the returned message. */
export function anthropicContent(
  request: AnthropicRequestContent,
): ModelCallContent<AnthropicAnswerContent> {
  return {
    system: request.system ? partsOf(request.system) : undefined,
    input: request.messages.map((message) => ({
      role: message.role,
      parts: partsOf(message.content),
    })),
    output: (answer) => [
      {
        role: "assistant",
        parts: partsOf(answer.content),
        ...(answer.stop_reason ? { finish_reason: answer.stop_reason } : {}),
      },
    ],
  };
}

function partsOf(content: string | ReadonlyArray<AnthropicBlock>): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", content }];
  const parts: ContentPart[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string")
      parts.push({ type: "text", content: block.text });
    else if (block.type === "thinking" && typeof block.thinking === "string")
      parts.push({ type: "reasoning", content: block.thinking });
    else if (block.type === "tool_use")
      parts.push({
        type: "tool_call",
        id: block.id ?? "",
        name: block.name ?? "",
        arguments: block.input ?? {},
      });
    else if (block.type === "tool_result")
      parts.push({
        type: "tool_call_response",
        id: block.tool_use_id ?? "",
        response: block.content ?? "",
      });
  }
  return parts;
}

function cappedParts(parts: ContentPart[]): string {
  const cut = parts.map((part) => cutPart(part, PART_MAX_CHARS));
  const json = JSON.stringify(cut);
  if (json.length <= MODEL_CALL_CONTENT_MAX_CHARS) return json;
  return fitByShare([{ role: "system", parts: cut }], (messages) => messages[0]!.parts);
}

/** Cut long texts, then drop the oldest messages until the JSON fits; the last one always stays. */
function cappedMessages(messages: ContentMessage[]): string {
  let kept = messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => cutPart(part, PART_MAX_CHARS)),
  }));
  let json = JSON.stringify(kept);
  while (json.length > MODEL_CALL_CONTENT_MAX_CHARS && kept.length > 1) {
    kept = kept.slice(1);
    json = JSON.stringify(kept);
  }
  if (json.length <= MODEL_CALL_CONTENT_MAX_CHARS) return json;
  return fitByShare(kept, (fitted) => fitted);
}

/** Give each part an equal share of what is left; if that still can't fit (huge escapes, arguments), a bare mark. */
function fitByShare(
  messages: ContentMessage[],
  shape: (messages: ContentMessage[]) => unknown,
): string {
  const partCount = messages.reduce((sum, message) => sum + message.parts.length, 0) || 1;
  const share = Math.max(64, Math.floor((MODEL_CALL_CONTENT_MAX_CHARS - 1_024) / partCount));
  const fitted = messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => cutPart(part, share)),
  }));
  const json = JSON.stringify(shape(fitted));
  if (json.length <= MODEL_CALL_CONTENT_MAX_CHARS) return json;
  const last = messages.at(-1)!;
  return JSON.stringify(
    shape([{ role: last.role, parts: [{ type: "text", content: TRUNCATED }] }]),
  );
}

function cutPart(part: ContentPart, max: number): ContentPart {
  switch (part.type) {
    case "text":
    case "reasoning":
      return { ...part, content: cutText(part.content, max) };
    case "tool_call": {
      const args = JSON.stringify(part.arguments ?? {});
      return args.length > max ? { ...part, arguments: cutText(args, max) } : part;
    }
    case "tool_call_response": {
      const response =
        typeof part.response === "string" ? part.response : JSON.stringify(part.response ?? "");
      return response.length > max ? { ...part, response: cutText(response, max) } : part;
    }
  }
}

function cutText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - TRUNCATED.length)) + TRUNCATED;
}
