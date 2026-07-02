// Mirror of the canonical `ratel-ai-cloud` Rust schema (ADR-0013). Kept honest
// against the Rust spec by the shared conformance fixtures in `../../fixtures`.

/** Any JSON value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object — used for tool-call arguments and JSON-Schema `parameters`. */
export type JsonObject = { [key: string]: JsonValue };

export interface TextBlock {
  type: "text";
  text: string;
}

/** An assistant tool call. `arguments` is a parsed object, never a JSON string. */
export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface ImageBlock {
  type: "image";
  /** Inline data (e.g. base64). Exactly one of `source` / `url`. */
  source?: string;
  url?: string;
  media_type: string;
}

export interface FileBlock {
  type: "file";
  source?: string;
  url?: string;
  media_type: string;
}

export type ContentBlock = TextBlock | ToolCallBlock | ImageBlock | FileBlock;

/** Message content: a bare string or an ordered list of typed blocks. */
export type Content = string | ContentBlock[];

export interface UserMessage {
  role: "user";
  content: Content;
}

export interface AssistantMessage {
  role: "assistant";
  content: Content;
}

export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the tool's parameters — an object (enforced at runtime by `validate`). */
  parameters: JsonObject;
}

export interface Params {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  /** Subset of `input_tokens` served from cache. */
  cached_tokens?: number;
  /** Subset of `output_tokens` spent on reasoning; not counted on top of them. */
  reasoning_tokens?: number;
}

export type FinishReason = "stop" | "length" | "tool_call" | "content_filter" | "refusal";

/** A single LLM-call event — the entire v1 telemetry surface. */
export interface Event {
  /** Resolved provider, e.g. `openai`, `anthropic`, `bedrock`. */
  provider: string;
  /** Resolved model, e.g. `gpt-5.5`. */
  model: string;
  /** Event timestamp, RFC 3339. */
  ts: string;
  stream?: boolean;
  latency_ms?: number;
  system?: string;
  tools?: ToolDef[];
  messages: Message[];
  params?: Params;
  usage?: Usage;
  finish_reason?: FinishReason;
}
