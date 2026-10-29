/**
 * The internal event shape a single LLM call reduces to — provider, model,
 * messages, tools, usage. It is the reconstruction target for OTLP ingest
 * (`lib/otlp/reconstruct.ts` builds one of these from `gen_ai.*` spans) and the
 * input the categorizer derives the dashboard's context categories from
 * (`categorize.ts`); it is also the `events.payload` JSONB shape.
 *
 * This used to be the public wire contract (an ADR-0013 Zod schema validated at
 * `POST /api/v1/events`). Since the cutover to stock OTLP ingest (ADR-0007), Ratel
 * no longer accepts this shape over the wire — it is reconstructed internally from
 * OpenTelemetry `gen_ai.*` telemetry — so it is now a plain type, not a validator.
 */

/** A `text` content block. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** An assistant tool-call block — `arguments` is a parsed object, never a JSON string. */
export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** An image block — exactly one of `source` (inline) or `url`. */
export interface ImageBlock {
  type: "image";
  source?: string;
  url?: string;
  media_type: string;
}

/** A file block — exactly one of `source` (inline) or `url`. */
export interface FileBlock {
  type: "file";
  source?: string;
  url?: string;
  media_type: string;
}

export type ContentBlock = TextBlock | ToolCallBlock | ImageBlock | FileBlock;

/** Message content: a bare string or an ordered list of typed blocks. */
export type MessageContent = string | ContentBlock[];

export interface UserMessage {
  role: "user";
  content: MessageContent;
}

export interface AssistantMessage {
  role: "assistant";
  content: MessageContent;
}

export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type CloudMessage = UserMessage | AssistantMessage | ToolMessage;

/** A tool definition offered to the model — `parameters` is a JSON Schema object. */
export interface CloudToolDef {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface CloudParams {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
}

export interface CloudUsage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
}

export type FinishReason = "stop" | "length" | "tool_call" | "content_filter" | "refusal";

/** A single agent LLM call — the unit of cloud telemetry. */
export interface CloudEvent {
  provider: string;
  model: string;
  ts: string;
  stream?: boolean;
  latency_ms?: number;
  system?: string;
  tools?: CloudToolDef[];
  messages: CloudMessage[];
  params?: CloudParams;
  usage?: CloudUsage;
  finish_reason?: FinishReason;
}
