import type {
  ChatCall,
  ChatMessage,
  ChatModel,
  ChatReply,
  ChatRequest,
  ChatTool,
  ModelEffort,
  ModelStop,
  ModelUsage,
  TextModel,
  TextReply,
  TextRequest,
} from "@/lib/contracts/models";
import { configured } from "@/lib/platform/env-configured";
import { trackModelCall } from "@/lib/platform/model-call";
import type { ContentMessage, ModelCallContent } from "@/lib/platform/model-call-content";
import { wellFormedJson } from "@/lib/readings/text/well-formed";
import type { Env } from "../config";
import type { ModelContext, ModelProviderAdapter } from "../index";

/**
 * Any server that speaks OpenAI's chat completions (`POST {base}/chat/completions`): OpenAI,
 * Gemini's compatible endpoint, vLLM, llama.cpp, Ollama (ADR-0033). Written over `fetch`, with
 * no vendor SDK.
 *
 * Servers differ, so the adapter asks for the most and steps down:
 *   - JSON output: by schema (`json_schema`, not strict), then as a JSON object, then by the
 *     prompt alone. A 400 or 422 to a request that carried a `response_format` moves one step
 *     down, and what worked is remembered for that server and model.
 *   - Effort and `max_completion_tokens` go only to a model named in `MODEL_REASONING_MODELS`
 *     (comma-separated id prefixes); every other model gets `max_tokens` and no effort.
 *   - Usage a server does not report is estimated, so a budget still moves.
 *
 * One call, its retries and its steps down included, is one spend line.
 */

const PROVIDER = "openai-compatible";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8_000;

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

export interface OpenAiCompatibleOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type Json = Record<string, unknown>;
type JsonMode = "json_schema" | "json_object" | "prompt";

const JSON_LADDER: readonly JsonMode[] = ["json_schema", "json_object", "prompt"];

/** What worked last, per server and model, so the ladder is walked once. */
const jsonModes = new Map<string, JsonMode>();

/** Forget what each server took (tests). */
export function resetJsonModes(): void {
  jsonModes.clear();
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** About four characters a token, for a server that reports no usage. */
function estimateTokens(...parts: unknown[]): number {
  let chars = 0;
  for (const part of parts) {
    if (part === undefined || part === null) continue;
    chars += typeof part === "string" ? part.length : JSON.stringify(part).length;
  }
  return Math.ceil(chars / 4);
}

/** Whether `MODEL_REASONING_MODELS` names this model, by a prefix of its id. */
function isReasoningModel(model: string, env: Env): boolean {
  return (configured(env.MODEL_REASONING_MODELS) ?? "")
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(Boolean)
    .some((prefix) => model.startsWith(prefix));
}

/** The token cap and the effort, as this model takes them. */
function generation(
  model: string,
  env: Env,
  maxTokens: number,
  effort: ModelEffort | undefined,
): Json {
  if (!isReasoningModel(model, env)) return { max_tokens: maxTokens };
  return {
    max_completion_tokens: maxTokens,
    ...(effort ? { reasoning_effort: effort === "xhigh" ? "high" : effort } : {}),
  };
}

function stopOf(finish: unknown, refusal: unknown): ModelStop {
  if (finish === "content_filter" || (typeof refusal === "string" && refusal.length > 0))
    return "refused";
  return finish === "length" ? "cut_off" : "end";
}

/** A message's text: a string, or the text parts of a content array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function usageOf(usage: unknown, estimate: () => ModelUsage): ModelUsage {
  if (!isRecord(usage) || typeof usage.prompt_tokens !== "number") return estimate();
  const details = usage.prompt_tokens_details;
  const cached = isRecord(details) ? details.cached_tokens : undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    ...(typeof cached === "number" && cached > 0 ? { cachedTokens: cached } : {}),
  };
}

/** What one completion came to, streamed or not. */
interface Completion {
  message: Json;
  finish: unknown;
  usage: unknown;
  model: string | undefined;
}

function readCompletion(data: unknown): Completion {
  const body = isRecord(data) ? data : {};
  const choice = Array.isArray(body.choices) && isRecord(body.choices[0]) ? body.choices[0] : {};
  return {
    message: isRecord(choice.message) ? choice.message : {},
    finish: choice.finish_reason,
    usage: body.usage,
    model: typeof body.model === "string" ? body.model : undefined,
  };
}

/** A streamed completion, put back together from its server-sent events. */
function readStream(text: string): Completion {
  let content = "";
  let refusal = "";
  let finish: unknown;
  let usage: unknown;
  let model: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(chunk)) continue;
    if (typeof chunk.model === "string") model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice =
      Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : null;
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.refusal === "string") refusal += delta.refusal;
  }
  return {
    message: { role: "assistant", content, ...(refusal ? { refusal } : {}) },
    finish,
    usage,
    model,
  };
}

function retryable(error: unknown): boolean {
  if (error instanceof ModelHttpError)
    return error.status === 408 || error.status === 429 || error.status >= 500;
  // Anything else `fetch` threw: the network, or the time limit.
  return true;
}

/** One provider's HTTP: a request with its retries, answered as a completion. */
function transport(context: ModelContext, options: OpenAiCompatibleOptions) {
  const doFetch = options.fetch ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const url = `${context.provider.baseUrl}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (context.provider.apiKey) headers.authorization = `Bearer ${context.provider.apiKey}`;

  async function once(body: Json, timeoutMs: number): Promise<Completion> {
    const response = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(wellFormedJson(body)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ModelHttpError(
        response.status,
        `${PROVIDER} answered ${response.status}: ${detail.slice(0, 500)}`,
      );
    }
    return body.stream === true
      ? readStream(await response.text())
      : readCompletion(await response.json());
  }

  return async function send(
    body: Json,
    limits: { timeoutMs?: number; maxRetries?: number },
  ): Promise<Completion> {
    const retries = Math.max(0, limits.maxRetries ?? DEFAULT_MAX_RETRIES);
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(body, limits.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      } catch (error) {
        if (attempt >= retries || !retryable(error)) throw error;
        await sleep(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt));
      }
    }
  };
}

/* - Text ------------------------------------------------------------------- */

function schemaInstruction(schema: Json): string {
  return `Answer with one JSON object and nothing else. It must fit this JSON schema:\n${JSON.stringify(schema)}`;
}

function textMessages(request: TextRequest, mode: JsonMode | null): Json[] {
  const system =
    request.schema && mode !== null && mode !== "json_schema"
      ? [request.system, schemaInstruction(request.schema)].filter(Boolean).join("\n\n")
      : request.system;
  return [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: request.user },
  ];
}

function responseFormat(schema: Json, mode: JsonMode): Json {
  if (mode === "json_schema")
    return {
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", schema, strict: false },
      },
    };
  return mode === "json_object" ? { response_format: { type: "json_object" } } : {};
}

function textContent(request: TextRequest): ModelCallContent<TextReply> {
  return {
    ...(request.system ? { system: [{ type: "text", content: request.system }] } : {}),
    input: [{ role: "user", parts: [{ type: "text", content: request.user }] }],
    output: (reply) => [{ role: "assistant", parts: [{ type: "text", content: reply.text }] }],
  };
}

function textModel(context: ModelContext, options: OpenAiCompatibleOptions): TextModel {
  const send = transport(context, options);
  const { model, env } = context;
  const modeKey = `${context.provider.baseUrl}|${model}`;

  async function ask(request: TextRequest, mode: JsonMode | null): Promise<TextReply> {
    const body: Json = {
      model,
      messages: textMessages(request, mode),
      ...generation(model, env, request.maxTokens, request.effort),
      ...(request.schema && mode ? responseFormat(request.schema, mode) : {}),
      ...(request.longOutput ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
    const done = await send(body, request);
    const text = textOf(done.message.content);
    return {
      text,
      usage: usageOf(done.usage, () => ({
        inputTokens: estimateTokens(request.system, request.user),
        outputTokens: estimateTokens(text),
      })),
      model: done.model ?? model,
      stop: stopOf(done.finish, done.message.refusal),
    };
  }

  /** With a schema: from what this server last took, one step down on each refusal of the format. */
  async function withSchema(request: TextRequest): Promise<TextReply> {
    let index = JSON_LADDER.indexOf(jsonModes.get(modeKey) ?? "json_schema");
    for (;;) {
      const mode = JSON_LADDER[index];
      try {
        const reply = await ask(request, mode);
        jsonModes.set(modeKey, mode);
        return reply;
      } catch (error) {
        const refusedFormat =
          error instanceof ModelHttpError && (error.status === 400 || error.status === 422);
        if (!refusedFormat || mode === "prompt") throw error;
        index += 1;
      }
    }
  }

  return {
    provider: PROVIDER,
    model,
    complete(request) {
      return trackModelCall(
        {
          provider: PROVIDER,
          model,
          feature: context.feature,
          payer: context.payer,
          content: textContent(request),
        },
        () => (request.schema ? withSchema(request) : ask(request, null)),
        (reply) => reply.usage,
      );
    },
  };
}

/* - Chat with tools -------------------------------------------------------- */

/** The marker on a `raw` turn this adapter wrote, so it reads back only its own. */
const RAW_KEY = "openAiCompatible";

/** Tool names as the API takes them (`^[a-zA-Z0-9_-]{1,64}$`), and the way back. */
function toolNames(tools: readonly ChatTool[]) {
  const safeOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  for (const tool of tools) {
    const base = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
    let safe = base;
    for (let n = 2; nameOf.has(safe); n++) safe = `${base.slice(0, 60)}_${n}`;
    safeOf.set(tool.name, safe);
    nameOf.set(safe, tool.name);
  }
  return {
    safe: (name: string) => safeOf.get(name) ?? name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
    original: (safe: string) => nameOf.get(safe) ?? safe,
  };
}

function chatMessages(request: ChatRequest, names: ReturnType<typeof toolNames>): Json[] {
  const out: Json[] = [];
  if (request.system) out.push({ role: "system", content: request.system });
  for (const message of request.messages) {
    if (message.role === "user") {
      const last = out.at(-1);
      // Many chat templates need the roles to alternate, so two asks in a row are one turn.
      if (last?.role === "user") last.content = `${last.content}\n\n${message.text}`;
      else out.push({ role: "user", content: message.text });
    } else if (message.role === "assistant") {
      out.push(assistantMessage(message, names));
    } else {
      out.push({
        role: "tool",
        tool_call_id: message.callId,
        content: message.isError ? `Error: ${message.content}` : message.content,
      });
    }
  }
  return out;
}

function assistantMessage(
  message: Extract<ChatMessage, { role: "assistant" }>,
  names: ReturnType<typeof toolNames>,
): Json {
  const own = message.raw?.[0];
  if (isRecord(own) && isRecord(own[RAW_KEY])) return own[RAW_KEY];
  return {
    role: "assistant",
    content: message.text || (message.calls.length > 0 ? null : ""),
    ...(message.calls.length > 0
      ? {
          tool_calls: message.calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: names.safe(call.name), arguments: JSON.stringify(call.args) },
          })),
        }
      : {}),
  };
}

/** The calls of a reply. Arguments that are not a JSON object are no arguments; an id is made up when missing or repeated. */
function readCalls(
  message: Json,
  names: ReturnType<typeof toolNames>,
): { calls: ChatCall[]; toolCalls: Json[] | undefined } {
  if (!Array.isArray(message.tool_calls)) return { calls: [], toolCalls: undefined };
  const seen = new Set<string>();
  const calls: ChatCall[] = [];
  const toolCalls: Json[] = [];
  for (const [index, entry] of message.tool_calls.entries()) {
    if (!isRecord(entry)) continue;
    const fn = isRecord(entry.function) ? entry.function : {};
    const given = typeof entry.id === "string" ? entry.id : "";
    const id = given && !seen.has(given) ? given : `call_${index + 1}`;
    seen.add(id);
    let args: Record<string, unknown> = {};
    try {
      const parsed = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
      if (isRecord(parsed)) args = parsed;
    } catch {
      // Arguments that are not JSON: the tool is called with none.
    }
    calls.push({ id, name: names.original(typeof fn.name === "string" ? fn.name : ""), args });
    toolCalls.push(id === entry.id ? entry : { ...entry, id });
  }
  return { calls, toolCalls };
}

function chatContent(request: ChatRequest): ModelCallContent<ChatReply> {
  const input: ContentMessage[] = request.messages.map((message) => {
    if (message.role === "user")
      return { role: "user", parts: [{ type: "text", content: message.text }] };
    if (message.role === "tool")
      return {
        role: "tool",
        parts: [{ type: "tool_call_response", id: message.callId, response: message.content }],
      };
    return {
      role: "assistant",
      parts: [
        ...(message.text ? [{ type: "text" as const, content: message.text }] : []),
        ...message.calls.map((call) => ({
          type: "tool_call" as const,
          id: call.id,
          name: call.name,
          arguments: call.args,
        })),
      ],
    };
  });
  return {
    ...(request.system ? { system: [{ type: "text", content: request.system }] } : {}),
    input,
    output: (reply) => [
      {
        role: "assistant",
        parts: [
          ...(reply.text ? [{ type: "text" as const, content: reply.text }] : []),
          ...reply.calls.map((call) => ({
            type: "tool_call" as const,
            id: call.id,
            name: call.name,
            arguments: call.args,
          })),
        ],
      },
    ],
  };
}

function chatModel(context: ModelContext, options: OpenAiCompatibleOptions): ChatModel {
  const send = transport(context, options);
  const { model, env } = context;

  async function next(request: ChatRequest): Promise<ChatReply> {
    const names = toolNames(request.tools);
    const messages = chatMessages(request, names);
    const body: Json = {
      model,
      messages,
      ...generation(model, env, request.maxTokens, request.effort),
      ...(isReasoningModel(model, env) ? {} : { temperature: 0 }),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: names.safe(tool.name),
                description: tool.description,
                parameters: { properties: {}, ...tool.parameters, type: "object" },
              },
            })),
            tool_choice: "auto",
          }
        : {}),
    };
    const done = await send(body, request);
    const { calls, toolCalls } = readCalls(done.message, names);
    const text = textOf(done.message.content);
    const written = {
      ...done.message,
      role: "assistant",
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    };
    return {
      text,
      calls,
      raw: [{ [RAW_KEY]: written }],
      usage: usageOf(done.usage, () => ({
        inputTokens: estimateTokens(messages, body.tools),
        outputTokens: estimateTokens(text, toolCalls),
      })),
      model: done.model ?? model,
      stop: stopOf(done.finish, done.message.refusal),
    };
  }

  return {
    provider: PROVIDER,
    model,
    next(request) {
      return trackModelCall(
        {
          provider: PROVIDER,
          model,
          feature: context.feature,
          payer: context.payer,
          content: chatContent(request),
        },
        () => next(request),
        (reply) => reply.usage,
      );
    },
  };
}

/** The adapter. Without a base URL there is no server to ask, so no model. */
export function openAiCompatibleProvider(
  options: OpenAiCompatibleOptions = {},
): ModelProviderAdapter {
  return {
    text: (context) => (context.provider.baseUrl ? textModel(context, options) : null),
    chat: (context) => (context.provider.baseUrl ? chatModel(context, options) : null),
  };
}
