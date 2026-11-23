import type { Config } from "@/config";
import { extractModelJsonObject } from "@/lib/catalog/skills/model-json";
import type {
  ChatCall,
  ChatMessage,
  ChatModel,
  ChatReply,
  ChatRequest,
  ModelEffort,
  ModelStop,
  ModelUsage,
  TextModel,
  TextReply,
  TextRequest,
} from "@/lib/contracts/models";
import { trackModelCall } from "@/lib/platform/model-call";
import type { ModelContext, ModelProviderAdapter } from "../index";
import { VENDORS } from "../vendors";
import {
  type Authorize,
  bearer,
  chatContent,
  estimateTokens,
  type HttpOptions,
  isRecord,
  type Json,
  ModelHttpError,
  orphanResult,
  poster,
  REASONING_MIN_TOKENS,
  readArgs,
  reasoningCap,
  resultText,
  schemaInstruction,
  streamEvents,
  type ToolNames,
  textContent,
  toolNames,
  toolParameters,
  usageWith,
} from "./http";

/**
 * A server that speaks chat completions (`POST {base}/chat/completions`): Ollama,
 * llama.cpp, vLLM, LiteLLM, Gemini on Vertex and the open models on Bedrock (ADR-0009). Written
 * over `fetch`, with no vendor SDK. What a vendor does differently is its `Dialect`.
 *
 * Servers differ, so the adapter asks for the most and steps down:
 *   - JSON output: by schema (`json_schema`, not strict), then as a JSON object, then by the
 *     prompt alone. A 400 or 422 to a request that carried a `response_format`, or an answer that
 *     ignored it, moves one step down, and what worked is remembered for that server and model.
 *   - Thinking a server writes into the answer (`<think>`, `<reasoning>`) is taken out of it.
 *   - Effort goes only to a model that reasons: one the dialect names, or one in
 *     `MODEL_REASONING_MODELS` (comma-separated id prefixes).
 *   - Usage a server does not report is estimated, so a budget still moves.
 *
 * One call, its retries and its steps down included, is one spend line.
 */

/** How one vendor's chat completions differ from the common form. */
export interface Dialect {
  /** Which of its models reason, and so take an effort and spend tokens thinking. */
  reasons?: (model: string) => boolean;
  /** The field that caps a reasoning model's tokens. */
  reasoningCap?: "max_tokens" | "max_completion_tokens";
  /** The model id as the endpoint takes it. */
  modelId?: (model: string) => string;
}

type JsonMode = "json_schema" | "json_object" | "prompt";

const JSON_LADDER: readonly JsonMode[] = ["json_schema", "json_object", "prompt"];

/** What worked last, per server and model, so the ladder is walked once. */
const jsonModes = new Map<string, JsonMode>();

/** Forget what each server took (tests). */
export function resetJsonModes(): void {
  jsonModes.clear();
}

/** Whether `MODEL_REASONING_MODELS` names this model, by a prefix of its id. */
function namedAsReasoning(model: string, config: Config): boolean {
  return (config.modelVendor.reasoningModels ?? "")
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(Boolean)
    .some((prefix) => model.startsWith(prefix));
}

function stopOf(finish: unknown, refusal: unknown): ModelStop {
  if (finish === "content_filter" || (typeof refusal === "string" && refusal.length > 0))
    return "refused";
  return finish === "length" ? "cut_off" : "end";
}

/** Thinking at the start of an answer, which some servers write into it; unclosed when it was cut off there. */
const THINKING = /^(?:\s*<(think|reasoning)>[\s\S]*?(?:<\/\1>|$))+\s*/;

/** A message's answer: its text without the thinking in front of it. */
function textOf(content: unknown): string {
  return contentOf(content).replace(THINKING, "");
}

/** A message's text: a string, or the text parts of a content array. */
function contentOf(content: unknown): string {
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
  return usageWith(usage.prompt_tokens, usage.completion_tokens, cached);
}

/** What one completion came to, streamed or not. */
interface Completion {
  message: Json;
  finish: unknown;
  usage: unknown;
  model: string | undefined;
}

function readCompletion(text: string): Completion {
  const data: unknown = JSON.parse(text);
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
  for (const chunk of streamEvents(text)) {
    if (typeof chunk.model === "string") model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice =
      Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : null;
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    content += contentOf(delta.content);
    if (typeof delta.refusal === "string") refusal += delta.refusal;
  }
  return {
    message: { role: "assistant", content, ...(refusal ? { refusal } : {}) },
    finish,
    usage,
    model,
  };
}

/** One server: how to send to it, and how its models generate. */
function serverOf(
  context: ModelContext,
  dialect: Dialect,
  authorize: Authorize,
  http: HttpOptions,
) {
  const { model, config } = context;
  const vendor = VENDORS[context.vendor.name];
  const url = `${context.vendor.baseUrl}/chat/completions`;
  const post = poster(url, vendor.label, authorize, http);
  const reasons = dialect.reasons?.(model) || namedAsReasoning(model, config);

  /** The token cap and the effort, as this model takes them. */
  function generation(maxTokens: number, effort: ModelEffort | undefined): Json {
    if (!reasons) return { max_tokens: maxTokens };
    const asked = effort ?? (maxTokens < REASONING_MIN_TOKENS ? "low" : undefined);
    return {
      [dialect.reasoningCap ?? "max_completion_tokens"]: reasoningCap(maxTokens, config),
      ...(asked ? { reasoning_effort: asked === "xhigh" ? "high" : asked } : {}),
    };
  }

  return {
    id: dialect.modelId?.(model) ?? model,
    provider: vendor.provider,
    key: `${url}|${model}`,
    reasons,
    generation,
    async send(body: Json, limits: { timeoutMs?: number; maxRetries?: number }) {
      const text = await post(body, limits);
      return body.stream === true ? readStream(text) : readCompletion(text);
    },
  };
}

type Server = ReturnType<typeof serverOf>;

/* - Text ------------------------------------------------------------------- */

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

/** The object in an answer, out of a code fence or words around it; null when there is none. */
function objectIn(text: string): Json | null {
  try {
    const answer: unknown = extractModelJsonObject(text);
    return isRecord(answer) ? answer : null;
  } catch {
    return null;
  }
}

/** Whether an answer has what the schema requires: enough to see the schema was not ignored. */
function fits(answer: Json | null, schema: Json): boolean {
  const required = Array.isArray(schema.required) ? schema.required : [];
  return answer !== null && required.every((key) => typeof key === "string" && key in answer);
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  const cached = (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cached > 0 ? { cachedTokens: cached } : {}),
  };
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

function textModel(context: ModelContext, server: Server): TextModel {
  const { model } = context;

  async function ask(request: TextRequest, mode: JsonMode | null): Promise<TextReply> {
    const body: Json = {
      model: server.id,
      messages: textMessages(request, mode),
      ...server.generation(request.maxTokens, request.effort),
      ...(request.schema && mode ? responseFormat(request.schema, mode) : {}),
      ...(request.longOutput
        ? {
            stream: true,
            stream_options: { include_usage: true },
          }
        : {}),
    };
    const done = await server.send(body, request);
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

  /**
   * With a schema: from what this server last took, one step down each time it refuses the format
   * or answers without it. An answer left behind is paid for, so its tokens count.
   */
  async function withSchema(request: TextRequest, schema: Json): Promise<TextReply> {
    let index = JSON_LADDER.indexOf(jsonModes.get(server.key) ?? "json_schema");
    let spent: ModelUsage | undefined;
    for (;;) {
      const mode = JSON_LADDER[index];
      try {
        const reply = await ask(request, mode);
        const usage = spent ? addUsage(spent, reply.usage) : reply.usage;
        const answer = reply.stop === "end" ? objectIn(reply.text) : null;
        if (mode !== "prompt" && reply.stop === "end" && !fits(answer, schema)) {
          spent = usage;
          index += 1;
          continue;
        }
        if (reply.stop === "end") jsonModes.set(server.key, mode);
        // A feature that asked for JSON gets JSON, whatever the model put around it.
        const text = answer && !isJson(reply.text) ? JSON.stringify(answer) : reply.text;
        return { ...reply, text, usage };
      } catch (error) {
        const refusedFormat =
          error instanceof ModelHttpError && (error.status === 400 || error.status === 422);
        if (!refusedFormat || mode === "prompt") throw error;
        index += 1;
      }
    }
  }

  return {
    provider: server.provider,
    model,
    complete(request) {
      return trackModelCall(
        {
          provider: server.provider,
          model,
          feature: context.feature,
          payer: context.payer,
          content: textContent(request),
        },
        () => (request.schema ? withSchema(request, request.schema) : ask(request, null)),
        (reply) => reply.usage,
      );
    },
  };
}

/* - Chat with tools -------------------------------------------------------- */

/** The marker on a `raw` turn this adapter wrote, so it reads back only its own. */
const RAW_KEY = "chatCompletions";

function chatMessages(request: ChatRequest, names: ToolNames): Json[] {
  const known = new Set<string>();
  const out: Json[] = [];
  const user = (text: string) => {
    const last = out.at(-1);
    // Many chat templates need the roles to alternate, so two asks in a row are one turn.
    if (last?.role === "user") last.content = `${last.content}\n\n${text}`;
    else out.push({ role: "user", content: text });
  };
  if (request.system) out.push({ role: "system", content: request.system });
  for (const message of request.messages) {
    if (message.role === "user") user(message.text);
    else if (message.role === "assistant") {
      for (const call of message.calls) known.add(call.id);
      out.push(assistantMessage(message, names));
    } else if (known.has(message.callId)) {
      out.push({
        role: "tool",
        tool_call_id: message.callId,
        content: resultText(message),
      });
    } else user(orphanResult(message));
  }
  return out;
}

function assistantMessage(
  message: Extract<ChatMessage, { role: "assistant" }>,
  names: ToolNames,
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
  names: ToolNames,
): { calls: ChatCall[]; toolCalls: Json[] | undefined } {
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)
    return { calls: [], toolCalls: undefined };
  const seen = new Set<string>();
  const calls: ChatCall[] = [];
  const toolCalls: Json[] = [];
  for (const [index, entry] of message.tool_calls.entries()) {
    if (!isRecord(entry)) continue;
    const fn = isRecord(entry.function) ? entry.function : {};
    const given = typeof entry.id === "string" ? entry.id : "";
    const id = given && !seen.has(given) ? given : `call_${index + 1}`;
    seen.add(id);
    const name = names.original(typeof fn.name === "string" ? fn.name : "");
    calls.push({ id, name, args: readArgs(fn.arguments) });
    toolCalls.push(id === entry.id ? entry : { ...entry, id });
  }
  return { calls, toolCalls };
}

function chatModel(context: ModelContext, server: Server): ChatModel {
  const { model } = context;

  async function next(request: ChatRequest): Promise<ChatReply> {
    const names = toolNames(request.tools);
    const messages = chatMessages(request, names);
    const body: Json = {
      model: server.id,
      messages,
      ...server.generation(request.maxTokens, request.effort),
      ...(server.reasons ? {} : { temperature: 0 }),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: names.safe(tool.name),
                description: tool.description,
                parameters: toolParameters(tool),
              },
            })),
            tool_choice: "auto",
          }
        : {}),
    };
    const done = await server.send(body, request);
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
    provider: server.provider,
    model,
    next(request) {
      return trackModelCall(
        {
          provider: server.provider,
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

export interface ChatCompletionsOptions extends HttpOptions {
  dialect?: Dialect;
  /** How a request is signed; a bearer key by default. */
  authorize?: (context: ModelContext) => Authorize;
}

/** The adapter. Without a base URL there is no server to ask, so no model. */
export function chatCompletions(options: ChatCompletionsOptions = {}): ModelProviderAdapter {
  const dialect = options.dialect ?? {};
  const server = (context: ModelContext) =>
    context.vendor.baseUrl
      ? serverOf(
          context,
          dialect,
          options.authorize?.(context) ?? bearer(context.vendor.apiKey),
          options,
        )
      : null;
  return {
    text(context) {
      const at = server(context);
      return at && textModel(context, at);
    },
    chat(context) {
      const at = server(context);
      return at && chatModel(context, at);
    },
  };
}
