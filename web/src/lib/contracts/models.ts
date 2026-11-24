/**
 * What a model is to the platform, whoever serves it (ADR-0009). A feature asks the model kit
 * (`lib/readings/models`) for one of these and never names a provider or a model id; an adapter
 * per provider implements them. Types only: nothing here knows a vendor's request shape.
 */

/** How strong a model a feature wants. A vendor has a model per tier; a deployment sets none. */
export type ModelTier = "deep" | "standard" | "fast";

/** How hard to think, where the model takes the setting. Dropped where it does not. */
export type ModelEffort = "low" | "medium" | "high" | "xhigh";

/**
 * Why the model stopped: it finished (`end`), ran out of `maxTokens` (`cut_off`), or declined
 * (`refused`). Returned, never thrown, so each feature keeps its own error for it.
 */
export type ModelStop = "end" | "cut_off" | "refused";

/** Tokens of one call. `inputTokens` counts every prompt token, the cached ones included. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** The part of `inputTokens` read from the provider's cache. */
  cachedTokens?: number;
}

/* - Text ------------------------------------------------------------------- */

export interface TextRequest {
  system: string;
  user: string;
  /** A JSON schema the answer must fit. Without it the answer is free text. */
  schema?: Record<string, unknown>;
  /** The most the model may generate, its thinking included. */
  maxTokens: number;
  effort?: ModelEffort;
  /** The answer may take minutes to write: the adapter streams it so no time limit cuts it. */
  longOutput?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface TextReply {
  text: string;
  usage: ModelUsage;
  /** The model that answered, as the provider names it. */
  model: string;
  stop: ModelStop;
}

/** System and user in, text out. */
export interface TextModel {
  readonly provider: string;
  readonly model: string;
  complete(request: TextRequest): Promise<TextReply>;
}

/* - Chat with tools -------------------------------------------------------- */

export interface ChatTool {
  name: string;
  description: string;
  /** JSON schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "user"; text: string }
  /**
   * `raw`: what the provider itself returned for this turn (thinking blocks, signatures),
   * handed back unchanged on the next call. An adapter reads only a shape it wrote.
   */
  | { role: "assistant"; text: string; calls: ChatCall[]; raw?: unknown[] }
  | { role: "tool"; callId: string; content: string; isError: boolean };

export interface ChatRequest {
  system?: string;
  tools: readonly ChatTool[];
  messages: readonly ChatMessage[];
  maxTokens: number;
  effort?: ModelEffort;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ChatReply {
  text: string;
  calls: ChatCall[];
  raw: unknown[];
  usage: ModelUsage;
  model: string;
  stop: ModelStop;
}

/** One turn of a conversation that may call tools. */
export interface ChatModel {
  readonly provider: string;
  readonly model: string;
  next(request: ChatRequest): Promise<ChatReply>;
}

/* - Decisions -------------------------------------------------------------- */

/** One option of a closed-set question, as the model reads it. */
export interface DecisionOption {
  id: string;
  /** What it does. */
  does: string;
  /** When to use it, when that differs. */
  searchable?: string;
}

/** The situation and the question, worded per surface. */
export interface DecisionFraming {
  about: string;
  question: string;
}

export interface DecisionAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface DecisionResult {
  /** Null when the engine declined to answer. */
  answer: DecisionAnswer | null;
  inputTokens: number;
}

/** What an engine can be relied on for; the judge reads its thresholds from these. */
export interface DecisionCapabilities {
  /** The engine may decline a question. */
  refusals: boolean;
  /**
   * What `confidence` means: a probability measured against an answer key (`calibrated`), a
   * relevance score that only orders the options (`score`), or nothing usable (`none`).
   */
  confidence: "calibrated" | "score" | "none";
  /** The most options one question may carry. */
  maxOptions: number;
}

/** One closed-set choice: which of these options fits, and how surely. */
export interface DecisionClient {
  readonly model: string;
  readonly capabilities: DecisionCapabilities;
  decideChoice(
    query: string,
    options: readonly DecisionOption[],
    framing: DecisionFraming,
  ): Promise<DecisionResult>;
}
