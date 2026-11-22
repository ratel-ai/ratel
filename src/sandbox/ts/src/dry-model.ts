// The stand-in model of `ratel sandbox verify --dry` (AI SDK sandboxes only). It makes
// no network call. Its first step calls each tool it was given once, with
// arguments built from the tool's JSON Schema, and a skill loader once per skill that
// a recall result in the prompt surfaced; after its tool results it answers with a
// short text. Specification v3: ai@6 and ai@7 accept it. The AI SDK
// stamps `gen_ai.request.model` from its modelId, so the model check works.

/** The text the stand-in answers with after the tool results. */
export const DRY_REPLY = "Dry run: no model was called.";

interface DryCallOptions {
  readonly prompt?: readonly { readonly role?: string; readonly content?: unknown }[];
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
  const prompt = JSON.stringify(options.prompt ?? []);
  // Answered: a result of the stand-in's own calls. A recall pair's tool result is not one.
  const answered = /\\?"toolCallId\\?":\s*\\?"dry_/.test(prompt);
  if (tools.length === 0 || answered) return [{ type: "text", text: dryReply(options) }];
  const skills = surfacedSkills(prompt);
  const calls = tools.flatMap((t) => {
    // A skill loader (Ratel's get_skill_content) loads each skill a recall surfaced.
    if (takesSkillId(t.inputSchema) && skills.length > 0)
      return skills.map((skillId) => ({ name: t.name, input: { skillId } }));
    return [{ name: t.name, input: exampleOf(t.inputSchema) ?? {} }];
  });
  return calls.map((call, i) => ({
    type: "tool-call",
    toolCallId: `dry_${i + 1}`,
    toolName: call.name,
    input: JSON.stringify(call.input),
  }));
}

/** The skill ids a capability search result in the prompt names, in order. */
function surfacedSkills(prompt: string): string[] {
  const ids = [...prompt.matchAll(/\\?"skillId\\?":\s*\\?"([^"\\]+)/g)].map((m) => m[1] as string);
  return [...new Set(ids)];
}

function takesSkillId(schema: unknown): boolean {
  const properties = (schema as { properties?: Record<string, unknown> } | null)?.properties;
  return typeof properties === "object" && properties !== null && "skillId" in properties;
}

/** DRY_REPLY, then the start of the system prompt the stand-in got: a dry run shows what the code sent. */
export function dryReply(options: DryCallOptions): string {
  const system = (options.prompt ?? []).find((m) => m.role === "system")?.content;
  if (typeof system !== "string" || system === "") return DRY_REPLY;
  const start = system.length > SYSTEM_ECHO ? `${system.slice(0, SYSTEM_ECHO)}...` : system;
  return `${DRY_REPLY} System prompt: ${JSON.stringify(start)}`;
}

const SYSTEM_ECHO = 60;

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
