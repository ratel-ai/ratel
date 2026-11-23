import type {
  ChatMessage,
  ChatReply,
  ChatRequest,
  ChatTool,
  ModelUsage,
  TextReply,
  TextRequest,
} from "@/lib/contracts/models";
import type { ContentPart, ModelCallContent } from "@/lib/platform/model-call-content";
import { wellFormedJson } from "@/lib/readings/text/well-formed";
import { type Env, maxOutputTokens } from "../config";

/** What the adapters that speak a vendor's HTTP API share: the request with its retries, and the neutral shapes. */

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8_000;

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The server answered with an error status. The message is the server's own text. */
export class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ModelHttpError";
  }
}

export interface HttpOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Headers that sign a request: a key, a cloud login's token, or a signature over the body. */
export type Authorize = (request: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<Record<string, string>> | Record<string, string>;

export function bearer(apiKey: string | undefined): Authorize {
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  return () => headers;
}

function retryable(error: unknown): boolean {
  if (error instanceof ModelHttpError)
    return error.status === 408 || error.status === 429 || error.status >= 500;
  // Anything else `fetch` threw: the network, or the time limit.
  return true;
}

/** POSTs a JSON body, with the caller's time limit and retries; hands back the answer's text. */
export function poster(url: string, label: string, authorize: Authorize, options: HttpOptions) {
  const doFetch = options.fetch ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  async function once(payload: string, timeoutMs: number): Promise<string> {
    const base = { "content-type": "application/json" };
    const headers = { ...base, ...(await authorize({ url, headers: base, body: payload })) };
    const response = await doFetch(url, {
      method: "POST",
      headers,
      body: payload,
      // A redirect would carry the prompt, and on some hosts the key, to another address.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok)
      throw new ModelHttpError(
        response.status,
        `${label} answered ${response.status}: ${text.slice(0, 500)}`,
      );
    return text;
  }

  return async function post(
    body: Json,
    limits: { timeoutMs?: number; maxRetries?: number },
  ): Promise<string> {
    const payload = JSON.stringify(wellFormedJson(body));
    const retries = Math.max(0, limits.maxRetries ?? DEFAULT_MAX_RETRIES);
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(payload, limits.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      } catch (error) {
        if (attempt >= retries || !retryable(error)) throw error;
        await sleep(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt));
      }
    }
  };
}

/** A model that thinks spends its cap on thinking first, so a small cap gets this much. */
export const REASONING_MIN_TOKENS = 4_096;

/** What a reasoning model may generate for a call that asked for `maxTokens`, within the deployment's cap. */
export function reasoningCap(maxTokens: number, env: Env): number {
  return Math.min(
    Math.max(maxTokens, REASONING_MIN_TOKENS),
    maxOutputTokens(env) ?? Number.POSITIVE_INFINITY,
  );
}

/** The JSON events of a server-sent stream. */
export function streamEvents(text: string): Json[] {
  const events: Json[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const event: unknown = JSON.parse(payload);
      if (isRecord(event)) events.push(event);
    } catch {
      // A partial event carries nothing.
    }
  }
  return events;
}

/** About four characters a token, for a server that reports no usage. */
export function estimateTokens(...parts: unknown[]): number {
  let chars = 0;
  for (const part of parts) {
    if (part === undefined || part === null) continue;
    chars += typeof part === "string" ? part.length : JSON.stringify(part).length;
  }
  return Math.ceil(chars / 4);
}

export function usageWith(input: number, output: unknown, cached: unknown): ModelUsage {
  return {
    inputTokens: input,
    outputTokens: typeof output === "number" ? output : 0,
    ...(typeof cached === "number" && cached > 0 ? { cachedTokens: cached } : {}),
  };
}

/** A tool's arguments: a JSON object, else none. */
export function readArgs(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Tool names as the APIs take them (`^[a-zA-Z0-9_-]{1,64}$`), and the way back. */
export function toolNames(tools: readonly ChatTool[]) {
  const clean = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
  const safeOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  for (const tool of tools) {
    const base = clean(tool.name);
    let safe = base;
    for (let n = 2; nameOf.has(safe); n++) safe = `${base.slice(0, 60)}_${n}`;
    safeOf.set(tool.name, safe);
    nameOf.set(safe, tool.name);
  }
  return {
    safe: (name: string) => safeOf.get(name) ?? clean(name),
    original: (safe: string) => nameOf.get(safe) ?? safe,
  };
}

export type ToolNames = ReturnType<typeof toolNames>;

export function toolParameters(tool: ChatTool): Json {
  return { properties: {}, ...tool.parameters, type: "object" };
}

/** A result whose call is not in the conversation can't be sent as one; it becomes plain text, as on Claude. */
export function orphanResult(message: Extract<ChatMessage, { role: "tool" }>): string {
  return `Tool result: ${message.content}`;
}

export function resultText(message: Extract<ChatMessage, { role: "tool" }>): string {
  return message.isError ? `Error: ${message.content}` : message.content;
}

/* - What a call's span may show --------------------------------------------- */

export function textContent(request: TextRequest): ModelCallContent<TextReply> {
  return {
    ...(request.system ? { system: [{ type: "text", content: request.system }] } : {}),
    input: [{ role: "user", parts: [{ type: "text", content: request.user }] }],
    output: (reply) => [{ role: "assistant", parts: [{ type: "text", content: reply.text }] }],
  };
}

function turnParts(turn: { text: string; calls: ChatReply["calls"] }): ContentPart[] {
  return [
    ...(turn.text ? [{ type: "text" as const, content: turn.text }] : []),
    ...turn.calls.map((call) => ({
      type: "tool_call" as const,
      id: call.id,
      name: call.name,
      arguments: call.args,
    })),
  ];
}

export function chatContent(request: ChatRequest): ModelCallContent<ChatReply> {
  return {
    ...(request.system ? { system: [{ type: "text", content: request.system }] } : {}),
    input: request.messages.map((message) => {
      if (message.role === "user")
        return { role: "user", parts: [{ type: "text", content: message.text }] };
      if (message.role === "tool")
        return {
          role: "tool",
          parts: [{ type: "tool_call_response", id: message.callId, response: message.content }],
        };
      return { role: "assistant", parts: turnParts(message) };
    }),
    output: (reply) => [{ role: "assistant", parts: turnParts(reply) }],
  };
}

/** A schema put into words, for a server that takes no schema. */
export function schemaInstruction(schema: Json): string {
  return `Answer with one JSON object and nothing else. It must fit this JSON schema:\n${JSON.stringify(schema)}`;
}
