import type {
  ChatModel,
  ChatReply,
  ChatRequest,
  TextModel,
  TextReply,
  TextRequest,
} from "@/lib/contracts/models";
import { FAKE_MODEL } from "./config";

/**
 * The fake provider (`MODEL_PROVIDER=fake`, local environments only): models that answer the
 * same thing every time, with no network. For the adapters' conformance tests and for a new
 * feature's tests. It is not the eval gate's stand-ins or the match-quality mock, which replay
 * recorded material and keep their own flags (ADR-0033 §13).
 */

/** About four characters a token: enough for a test to see usage move. */
function tokens(...parts: unknown[]): number {
  let chars = 0;
  for (const part of parts) {
    if (part === undefined || part === null) continue;
    chars += typeof part === "string" ? part.length : JSON.stringify(part).length;
  }
  return Math.ceil(chars / 4);
}

/** The smallest value that fits a JSON schema: required properties only, empty where it can be. */
export function minimalInstance(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return null;
  const node = schema as Record<string, unknown>;
  if ("const" in node) return node.const;
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case "object": {
      const properties = (node.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(node.required) ? (node.required as string[]) : [];
      const out: Record<string, unknown> = {};
      for (const key of required) out[key] = minimalInstance(properties[key]);
      return out;
    }
    case "array":
      return [];
    case "string":
      return "";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

export interface FakeTextOptions {
  model?: string;
  /** What to answer instead of the default. */
  reply?: (request: TextRequest) => string;
}

/** A text model that answers a JSON object fitting the schema, or a fixed sentence without one. */
export function fakeTextModel(options: FakeTextOptions = {}): TextModel {
  const model = options.model ?? FAKE_MODEL;
  return {
    provider: "fake",
    model,
    async complete(request): Promise<TextReply> {
      const text = options.reply
        ? options.reply(request)
        : request.schema
          ? JSON.stringify(minimalInstance(request.schema))
          : "Fake reply.";
      return {
        text,
        usage: {
          inputTokens: tokens(request.system, request.user),
          outputTokens: tokens(text),
        },
        model,
        stop: "end",
      };
    },
  };
}

/**
 * A chat model that calls the first tool once, with no arguments, and answers with the tool's
 * result when it comes back. Without tools it answers at once.
 */
export function fakeChatModel(options: { model?: string } = {}): ChatModel {
  const model = options.model ?? FAKE_MODEL;
  return {
    provider: "fake",
    model,
    async next(request: ChatRequest): Promise<ChatReply> {
      const last = request.messages.at(-1);
      const usage = (text: string) => ({
        inputTokens: tokens(request.system, request.messages),
        outputTokens: tokens(text),
      });
      if (last?.role === "tool") {
        const text = `Fake answer: ${last.content}`;
        return { text, calls: [], raw: [{ fake: text }], usage: usage(text), model, stop: "end" };
      }
      const tool = request.tools[0];
      if (!tool) {
        const text = "Fake reply.";
        return { text, calls: [], raw: [{ fake: text }], usage: usage(text), model, stop: "end" };
      }
      const calls = [{ id: "call_1", name: tool.name, args: {} }];
      return { text: "", calls, raw: [{ fake: calls }], usage: usage(""), model, stop: "end" };
    },
  };
}
