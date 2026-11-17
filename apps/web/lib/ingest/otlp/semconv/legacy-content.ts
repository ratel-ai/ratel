import { GEN_AI, GEN_AI_INFERENCE_DETAILS } from "../constants";
import type { AttrMap, AttrValue, DecodedEvent, DecodedSpan } from "../types";

/**
 * Older content forms onto the v1.41
 * `gen_ai.system_instructions` / `gen_ai.input.messages` /
 * `gen_ai.output.messages` (JSON strings of `{ role, parts }`) that
 * `reconstruct.ts` reads.
 *
 * - OpenLLMetry indexed keys: `gen_ai.prompt.N.{role,content,tool_call_id,tool_calls.M.*}`
 *   and `gen_ai.completion.N.{role,content,finish_reason,tool_calls.M.*}`.
 * - Per-message span events: `gen_ai.system.message`, `gen_ai.user.message`,
 *   `gen_ai.assistant.message`, `gen_ai.tool.message` and `gen_ai.choice`, in
 *   event order.
 *
 * Additive: a key the span or its details event already has always wins (an
 * existing `gen_ai.input.messages` also blocks the system instructions), and
 * the indexed keys win over the events. Idempotent. Bad shapes are skipped.
 */

type Json = Record<string, unknown>;

interface Message {
  role: string;
  parts: Json[];
  finish_reason?: string;
}

interface Converted {
  system: Json[];
  input: Message[];
  output: Message[];
}

const INDEXED_KEY = /^gen_ai\.(prompt|completion)\.(\d+)\.(.+)$/;
const TOOL_CALL_FIELD = /^tool_calls\.(\d+)\.(id|name|arguments)$/;

const MESSAGE_EVENTS: Readonly<Record<string, string>> = {
  "gen_ai.system.message": "system",
  "gen_ai.user.message": "user",
  "gen_ai.assistant.message": "assistant",
  "gen_ai.tool.message": "tool",
};
const CHOICE_EVENT = "gen_ai.choice";

/** Mutates `span`: sets the canonical content keys it lacks from the older forms. */
export function mapLegacyContent(span: DecodedSpan): void {
  const attrs = span.attributes;
  const details = span.events.find((e) => e.name === GEN_AI_INFERENCE_DETAILS)?.attributes ?? {};
  const has = (key: string) => present(attrs[key]) || present(details[key]);
  // System instructions come with the input: input messages already sent may
  // hold the system message, and adding it again would count it twice.
  const missing = [
    ...(has(GEN_AI.inputMessages)
      ? []
      : [GEN_AI.systemInstructions, GEN_AI.inputMessages].filter((k) => !has(k))),
    ...(has(GEN_AI.outputMessages) ? [] : [GEN_AI.outputMessages]),
  ];
  if (missing.length === 0) return;
  const converted = merge(fromIndexedKeys(attrs), fromEvents(span.events));
  const values: Record<string, Json[] | Message[]> = {
    [GEN_AI.systemInstructions]: converted.system,
    [GEN_AI.inputMessages]: converted.input,
    [GEN_AI.outputMessages]: converted.output,
  };
  for (const key of missing) if (values[key].length > 0) attrs[key] = JSON.stringify(values[key]);
}

/** OpenLLMetry's indexed keys, one message per index. */
function fromIndexedKeys(attrs: AttrMap): Converted {
  const sides: Record<"prompt" | "completion", Map<number, Map<string, AttrValue>>> = {
    prompt: new Map(),
    completion: new Map(),
  };
  for (const [key, value] of Object.entries(attrs)) {
    const match = INDEXED_KEY.exec(key);
    if (!match) continue;
    const side = sides[match[1] as "prompt" | "completion"];
    const index = Number(match[2]);
    const fields = side.get(index) ?? new Map<string, AttrValue>();
    fields.set(match[3], value);
    side.set(index, fields);
  }
  const out: Converted = { system: [], input: [], output: [] };
  for (const [name, side] of Object.entries(sides)) {
    for (const index of [...side.keys()].sort((a, b) => a - b)) {
      const fields = side.get(index)!;
      const role = str(fields.get("role")) ?? (name === "prompt" ? "user" : "assistant");
      const message = toMessage(
        role,
        fields.get("content"),
        indexedToolCalls(fields),
        str(fields.get("tool_call_id")),
      );
      if (name === "completion") {
        const finish = str(fields.get("finish_reason"));
        if (message && finish) message.finish_reason = finish;
        if (message) out.output.push(message);
      } else {
        place(out, message);
      }
    }
  }
  return out;
}

/** The per-message span events, in event order. */
function fromEvents(events: readonly DecodedEvent[]): Converted {
  const out: Converted = { system: [], input: [], output: [] };
  for (const event of events) {
    const a = event.attributes;
    const role = MESSAGE_EVENTS[event.name];
    if (role) {
      place(out, toMessage(role, a.content, eventToolCalls(a.tool_calls), str(a.id)));
    } else if (event.name === CHOICE_EVENT) {
      const body = asRecord(a.message) ?? {};
      const message = toMessage(
        str(body.role) ?? "assistant",
        (body.content ?? a.content) as AttrValue,
        eventToolCalls((body.tool_calls ?? a.tool_calls) as AttrValue),
        undefined,
      );
      const finish = str(a.finish_reason);
      if (message && finish) message.finish_reason = finish;
      if (message) out.output.push(message);
    }
  }
  return out;
}

/** The indexed keys win: a side the events also carry is taken from the keys. */
function merge(keys: Converted, events: Converted): Converted {
  return {
    system: keys.system.length > 0 ? keys.system : events.system,
    input: keys.input.length > 0 ? keys.input : events.input,
    output: keys.output.length > 0 ? keys.output : events.output,
  };
}

/** A system message feeds the system instructions; the rest are input. */
function place(out: Converted, message: Message | null): void {
  if (!message) return;
  if (message.role === "system") out.system.push(...message.parts);
  else out.input.push(message);
}

function toMessage(
  role: string,
  content: AttrValue | undefined,
  toolCalls: Json[],
  toolCallId: string | undefined,
): Message | null {
  const text = contentParts(content);
  if (role === "tool") {
    const response = text
      .map((p) => p.content)
      .filter((s) => typeof s === "string")
      .join("\n");
    if (!response && toolCallId === undefined) return null;
    return { role, parts: [{ type: "tool_call_response", id: toolCallId ?? "", response }] };
  }
  const parts = [...text, ...toolCalls];
  return parts.length > 0 ? { role, parts } : null;
}

/**
 * Message content: a string, a JSON string of OpenAI content parts, or those
 * parts. A JSON array string with no readable part (a tool's list result) is
 * text as sent.
 */
function contentParts(content: AttrValue | undefined): Json[] {
  if (typeof content !== "string") return arrayParts(content);
  if (!content) return [];
  const parts = arrayParts(parseArray(content));
  return parts.length > 0 ? parts : [{ type: "text", content }];
}

function arrayParts(value: unknown): Json[] {
  if (!Array.isArray(value)) return [];
  const parts: Json[] = [];
  for (const item of value) {
    const part = asRecord(item);
    if (!part) continue;
    const text = str(part.text) ?? str(part.content);
    const image = str(asRecord(part.image_url)?.url) ?? str(part.image_url);
    if (text) parts.push({ type: "text", content: text });
    else if (image) parts.push({ type: "uri", modality: "image", uri: image });
  }
  return parts;
}

function indexedToolCalls(fields: ReadonlyMap<string, AttrValue>): Json[] {
  const calls = new Map<number, Json>();
  for (const [field, value] of fields) {
    const match = TOOL_CALL_FIELD.exec(field);
    if (!match) continue;
    const call = calls.get(Number(match[1])) ?? { type: "tool_call" };
    call[match[2]] = match[2] === "arguments" ? parseArguments(value) : value;
    calls.set(Number(match[1]), call);
  }
  return [...calls.keys()]
    .sort((a, b) => a - b)
    .map((i) => calls.get(i)!)
    .filter((c) => str(c.name));
}

/** `tool_calls` on a message event: OpenAI's `{ id, function: { name, arguments } }` list. */
function eventToolCalls(raw: AttrValue | undefined): Json[] {
  const list = typeof raw === "string" ? parseArray(raw) : raw;
  if (!Array.isArray(list)) return [];
  const calls: Json[] = [];
  for (const item of list) {
    const call = asRecord(item);
    if (!call) continue;
    const fn = asRecord(call.function) ?? call;
    const name = str(fn.name);
    if (!name) continue;
    calls.push({
      type: "tool_call",
      id: str(call.id) ?? "",
      name,
      arguments: parseArguments(fn.arguments as AttrValue),
    });
  }
  return calls;
}

function parseArguments(value: AttrValue | undefined): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseArray(value: string): unknown[] | undefined {
  if (!value.trimStart().startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Json | undefined {
  if (typeof value === "string") {
    if (!value.trimStart().startsWith("{")) return undefined;
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function present(value: AttrValue | undefined): boolean {
  return value !== undefined && value !== null && value !== "";
}
