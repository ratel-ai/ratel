import type {
  ChatCall,
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
  bearer,
  chatContent,
  estimateTokens,
  type HttpOptions,
  isRecord,
  type Json,
  orphanResult,
  poster,
  REASONING_MIN_TOKENS,
  readArgs,
  reasoningCap,
  resultText,
  streamEvents,
  type ToolNames,
  textContent,
  toolNames,
  toolParameters,
  usageWith,
} from "./http";

/**
 * A vendor's Responses API (`POST {base}/responses`): OpenAI (ADR-0009), whose chat completions
 * refuse tools on some of its current models.
 *
 * Nothing is kept at the vendor: every request says `store: false`, and a conversation's earlier
 * turns go back as the items the vendor wrote, its encrypted reasoning included.
 */

export interface ResponsesOptions extends HttpOptions {
  /** Which of its models reason, and so take an effort and spend tokens thinking. */
  reasons: (model: string) => boolean;
}

/** The marker on a `raw` turn this adapter wrote, so it reads back only its own. */
const RAW_KEY = "responses";

interface Answer {
  output: Json[];
  text: string;
  stop: ModelStop;
  usage: unknown;
  model: string | undefined;
}

function readAnswer(body: Json): Answer {
  // A failed response is an HTTP success whose body says what went wrong.
  if (body.status === "failed") {
    const error = isRecord(body.error) ? body.error : {};
    throw new Error(`the model failed: ${String(error.code ?? error.message ?? "unknown")}`);
  }
  const output = Array.isArray(body.output) ? body.output.filter(isRecord) : [];
  const parts = output
    .filter((item) => item.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content.filter(isRecord) : []));
  const reason = isRecord(body.incomplete_details) ? body.incomplete_details.reason : undefined;
  const refused = reason === "content_filter" || parts.some((part) => part.type === "refusal");
  return {
    output,
    text: parts.map((part) => (typeof part.text === "string" ? part.text : "")).join(""),
    stop: refused ? "refused" : body.status === "incomplete" ? "cut_off" : "end",
    usage: body.usage,
    model: typeof body.model === "string" ? body.model : undefined,
  };
}

/** The whole response, which a stream repeats in its last event. */
function readStream(text: string): Json {
  let last: Json | undefined;
  for (const event of streamEvents(text)) if (isRecord(event.response)) last = event.response;
  if (!last || last.status === "in_progress") throw new Error("the answer's stream was cut short");
  return last;
}

function usageOf(usage: unknown, estimate: () => ModelUsage): ModelUsage {
  if (!isRecord(usage) || typeof usage.input_tokens !== "number") return estimate();
  const details = usage.input_tokens_details;
  return usageWith(
    usage.input_tokens,
    usage.output_tokens,
    isRecord(details) ? details.cached_tokens : undefined,
  );
}

function serverOf(context: ModelContext, options: ResponsesOptions) {
  const { model } = context;
  const vendor = VENDORS[context.vendor.name];
  const post = poster(
    `${context.vendor.baseUrl}/responses`,
    vendor.label,
    bearer(context.vendor.apiKey),
    options,
  );
  const reasons = options.reasons(model);
  return {
    provider: vendor.provider,
    reasons,
    /** The token cap and the effort, as this model takes them. */
    generation(maxTokens: number, effort: ModelEffort | undefined): Json {
      if (!reasons) return { max_output_tokens: maxTokens };
      const asked = effort ?? (maxTokens < REASONING_MIN_TOKENS ? "low" : undefined);
      return {
        max_output_tokens: reasoningCap(maxTokens, context.config),
        ...(asked ? { reasoning: { effort: asked } } : {}),
      };
    },
    async send(body: Json, limits: { timeoutMs?: number; maxRetries?: number }): Promise<Answer> {
      const text = await post({ ...body, store: false }, limits);
      if (body.stream === true) return readAnswer(readStream(text));
      const data: unknown = JSON.parse(text);
      return readAnswer(isRecord(data) ? data : {});
    },
  };
}

type Server = ReturnType<typeof serverOf>;

/* - Text ------------------------------------------------------------------- */

function textModel(context: ModelContext, server: Server): TextModel {
  const { model } = context;
  async function ask(request: TextRequest): Promise<TextReply> {
    const done = await server.send(
      {
        model,
        ...(request.system ? { instructions: request.system } : {}),
        input: [{ role: "user", content: request.user }],
        ...server.generation(request.maxTokens, request.effort),
        ...(request.schema
          ? {
              text: {
                format: {
                  type: "json_schema",
                  name: "answer",
                  schema: request.schema,
                  strict: false,
                },
              },
            }
          : {}),
        ...(request.longOutput ? { stream: true } : {}),
      },
      request,
    );
    return {
      text: done.text,
      usage: usageOf(done.usage, () => ({
        inputTokens: estimateTokens(request.system, request.user),
        outputTokens: estimateTokens(done.text),
      })),
      model: done.model ?? model,
      stop: done.stop,
    };
  }
  return {
    provider: server.provider,
    model,
    complete: (request) =>
      trackModelCall(
        {
          provider: server.provider,
          model,
          feature: context.feature,
          payer: context.payer,
          content: textContent(request),
        },
        () => ask(request),
        (reply) => reply.usage,
      ),
  };
}

/* - Chat with tools -------------------------------------------------------- */

function inputItems(request: ChatRequest, names: ToolNames): Json[] {
  const known = new Set<string>();
  const out: Json[] = [];
  for (const message of request.messages) {
    if (message.role === "user") out.push({ role: "user", content: message.text });
    else if (message.role === "assistant") {
      for (const call of message.calls) known.add(call.id);
      const own = message.raw?.[0];
      if (isRecord(own) && Array.isArray(own[RAW_KEY])) {
        out.push(...(own[RAW_KEY] as Json[]));
        continue;
      }
      if (message.text) out.push({ role: "assistant", content: message.text });
      for (const call of message.calls)
        out.push({
          type: "function_call",
          call_id: call.id,
          name: names.safe(call.name),
          arguments: JSON.stringify(call.args),
        });
    } else if (known.has(message.callId)) {
      out.push({
        type: "function_call_output",
        call_id: message.callId,
        output: resultText(message),
      });
    } else out.push({ role: "user", content: orphanResult(message) });
  }
  return out;
}

function readCalls(output: readonly Json[], names: ToolNames): ChatCall[] {
  return output
    .filter((item) => item.type === "function_call" && typeof item.call_id === "string")
    .map((item) => ({
      id: String(item.call_id),
      name: names.original(String(item.name ?? "")),
      args: readArgs(item.arguments),
    }));
}

function chatModel(context: ModelContext, server: Server): ChatModel {
  const { model } = context;
  async function next(request: ChatRequest): Promise<ChatReply> {
    const names = toolNames(request.tools);
    const input = inputItems(request, names);
    const tools = request.tools.map((tool) => ({
      type: "function",
      name: names.safe(tool.name),
      description: tool.description,
      parameters: toolParameters(tool),
      // A recorded tool's schema is the customer's: it is not rewritten to fit strict mode.
      strict: false,
    }));
    const done = await server.send(
      {
        model,
        ...(request.system ? { instructions: request.system } : {}),
        input,
        ...server.generation(request.maxTokens, request.effort),
        ...(server.reasons ? { include: ["reasoning.encrypted_content"] } : { temperature: 0 }),
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      },
      request,
    );
    const calls = readCalls(done.output, names);
    return {
      text: done.text,
      calls,
      raw: [{ [RAW_KEY]: done.output }],
      usage: usageOf(done.usage, () => ({
        inputTokens: estimateTokens(input, tools),
        outputTokens: estimateTokens(done.text, calls),
      })),
      model: done.model ?? model,
      stop: done.stop,
    };
  }
  return {
    provider: server.provider,
    model,
    next: (request) =>
      trackModelCall(
        {
          provider: server.provider,
          model,
          feature: context.feature,
          payer: context.payer,
          content: chatContent(request),
        },
        () => next(request),
        (reply) => reply.usage,
      ),
  };
}

/** The adapter. Without a base URL there is no vendor to ask, so no model. */
export function responses(options: ResponsesOptions): ModelProviderAdapter {
  return {
    text: (context) =>
      context.vendor.baseUrl ? textModel(context, serverOf(context, options)) : null,
    chat: (context) =>
      context.vendor.baseUrl ? chatModel(context, serverOf(context, options)) : null,
  };
}
