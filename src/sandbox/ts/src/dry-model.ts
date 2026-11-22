// The stand-in model of `ratel sandbox verify --dry` (AI SDK sandboxes only). It makes
// no network call. Its first step calls each tool it was given once, with
// arguments built from the tool's JSON Schema; after a tool result it answers
// with a short text. Specification v3: ai@6 and ai@7 accept it. The AI SDK
// stamps `gen_ai.request.model` from its modelId, so the model check works.

/** The text the stand-in answers with after the tool results. */
export const DRY_REPLY = "Dry run: no model was called.";

interface DryCallOptions {
  readonly prompt?: readonly { readonly role?: string }[];
  readonly tools?: readonly {
    readonly type?: string;
    readonly name: string;
    readonly inputSchema?: unknown;
  }[];
}

type Content =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string };

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** A model that answers from its script, for the AI SDK. */
export class DryModel {
  readonly specificationVersion = "v3";
  readonly provider = "ratel-dry";
  readonly supportedUrls = {};

  constructor(readonly modelId: string) {}

  async doGenerate(options: DryCallOptions) {
    const content = scriptedContent(options);
    return { content, finishReason: finishOf(content), usage: USAGE, warnings: [] };
  }

  async doStream(options: DryCallOptions): Promise<{ stream: ReadableStream<unknown> }> {
    const content = scriptedContent(options);
    const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
    for (const item of content) {
      if (item.type === "text")
        parts.push(
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: item.text },
          { type: "text-end", id: "t1" },
        );
      else parts.push(item);
    }
    parts.push({ type: "finish", finishReason: finishOf(content), usage: USAGE });
    return {
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    };
  }
}

/** A value that fits `schema`: required properties only, the smallest length, the first enum value. */
export function exampleOf(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) return null;
  const s = schema as Record<string, unknown>;
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const list = s[key];
    if (Array.isArray(list) && list.length > 0) return exampleOf(list[0]);
  }
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  switch (type) {
    case "object": {
      const properties = (s.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(s.required) ? (s.required as string[]) : [];
      return Object.fromEntries(required.map((name) => [name, exampleOf(properties[name])]));
    }
    case "array":
      return Array.from({ length: Number(s.minItems ?? 0) }, () => exampleOf(s.items));
    case "string":
      return stringOf(s);
    case "integer":
    case "number":
      return typeof s.minimum === "number" ? s.minimum : 1;
    case "boolean":
      return false;
    default:
      return null;
  }
}

function scriptedContent(options: DryCallOptions): Content[] {
  const tools = (options.tools ?? []).filter((t) => (t.type ?? "function") === "function");
  const answered = (options.prompt ?? []).some((m) => m.role === "tool");
  if (tools.length === 0 || answered) return [{ type: "text", text: DRY_REPLY }];
  return tools.map((t, i) => ({
    type: "tool-call",
    toolCallId: `dry_${i + 1}`,
    toolName: t.name,
    input: JSON.stringify(exampleOf(t.inputSchema) ?? {}),
  }));
}

function finishOf(content: readonly Content[]): { unified: string; raw: string } {
  const reason = content.some((c) => c.type === "tool-call") ? "tool-calls" : "stop";
  return { unified: reason, raw: reason };
}

function stringOf(s: Record<string, unknown>): string {
  if (s.format === "email") return "verify@example.com";
  if (s.format === "uri" || s.format === "url") return "https://example.com";
  const min = Number(s.minLength ?? 0);
  return "verify".padEnd(Math.max(min, 6), "x");
}
