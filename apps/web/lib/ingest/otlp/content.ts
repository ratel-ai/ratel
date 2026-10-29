import type { CloudMessage, CloudToolDef, ContentBlock } from "@/lib/ingest/cloud-schema";
import type { AttrValue } from "./types";

/**
 * Map the opt-in `gen_ai.client.inference.operation.details` event content —
 * `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`
 * — into the `CloudEvent` `system` + `messages` shape the categorizer consumes.
 * Also maps the `gen_ai.tool.definitions` catalog into `CloudEvent.tools`.
 *
 * v1.42.0 message parts: text | reasoning | tool_call | tool_call_response |
 * blob | uri | file. Reads are defensive (content is customer-shaped and only
 * present when capture is enabled); anything unrecognized is skipped rather than
 * throwing.
 */

/** An OTLP message part after `anyValueToJs` (loosely typed — customer-shaped). */
type Part = Record<string, AttrValue>;
type RawMessage = Record<string, AttrValue>;

function asString(v: AttrValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}

/** A tool_call `arguments` / tool `parameters` value → a plain JSON object. */
function asObject(v: AttrValue | undefined): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return {};
}

/** Normalize a message's parts, tolerating `parts[]`, a `content` array, or a bare string. */
function partsOf(msg: RawMessage): Part[] {
  if (Array.isArray(msg.parts)) return msg.parts as Part[];
  if (Array.isArray(msg.content)) return msg.content as Part[];
  if (typeof msg.content === "string") return [{ type: "text", content: msg.content }];
  return [];
}

/** The text carried by a text/reasoning part (either `content` or `text`). */
function partText(p: Part): string | null {
  return asString(p.content) ?? asString(p.text);
}

/** Concatenate the text of a `system_instructions` parts array (or bare string). */
export function systemFromInstructions(v: AttrValue | undefined): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (!Array.isArray(v)) return undefined;
  const text = v
    .map((p) => (p && typeof p === "object" ? partText(p as Part) : asString(p as AttrValue)))
    .filter((s): s is string => !!s)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

export interface MappedContent {
  messages: CloudMessage[];
  /** Extra system text found inside a `system` role message (rare; folded in). */
  system?: string;
  /** Tool names that appeared as assistant `tool_call` parts (drives tools_used). */
  calledNames: Set<string>;
}

/** Map one OTLP message into zero or more CloudMessages (+ any tool responses). */
function mapMessage(raw: RawMessage): {
  messages: CloudMessage[];
  system?: string;
  called: string[];
} {
  const role = asString(raw.role) ?? "user";
  const parts = partsOf(raw);
  const blocks: ContentBlock[] = [];
  const toolMessages: CloudMessage[] = [];
  const called: string[] = [];
  const systemText: string[] = [];

  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const type = asString(p.type) ?? "text";
    switch (type) {
      case "text":
      case "reasoning": {
        const text = partText(p);
        if (text != null) {
          if (role === "system") systemText.push(text);
          else blocks.push({ type: "text", text });
        }
        break;
      }
      case "tool_call": {
        const name = asString(p.name) ?? "";
        if (name) {
          called.push(name);
          // tool_call blocks are only valid on assistant messages.
          if (role === "assistant") {
            blocks.push({
              type: "tool_call",
              id: asString(p.id) ?? "",
              name,
              arguments: asObject(p.arguments),
            });
          }
        }
        break;
      }
      case "tool_call_response": {
        const responseText =
          asString(p.response) ?? (p.response != null ? JSON.stringify(p.response) : "");
        toolMessages.push({
          role: "tool",
          tool_call_id: asString(p.id) ?? "",
          content: responseText,
        });
        break;
      }
      case "blob":
      case "uri":
      case "file":
      case "image": {
        const block = mapMediaPart(p, type);
        if (block) blocks.push(block);
        break;
      }
      default:
        break; // server_tool_call / generic / unknown → skip
    }
  }

  const messages: CloudMessage[] = [];
  if (role === "system") {
    return { messages: [], system: systemText.join("\n") || undefined, called };
  }
  if (role === "tool") {
    // A tool-role message with bare text (not a tool_call_response part).
    const text = blocks
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) {
      messages.push({
        role: "tool",
        tool_call_id: asString(raw.tool_call_id) ?? asString(raw.id) ?? "",
        content: text,
      });
    }
  } else if (blocks.length > 0) {
    messages.push({ role: role === "assistant" ? "assistant" : "user", content: blocks });
  }
  messages.push(...toolMessages);
  return { messages, called };
}

/** blob/uri/file/image part → an image or file content block (source XOR url). */
function mapMediaPart(p: Part, type: string): ContentBlock | null {
  const mediaType = asString(p.mime_type) ?? asString(p.media_type) ?? "application/octet-stream";
  const source = asString(p.content) ?? asString(p.data);
  const url = asString(p.uri) ?? asString(p.url);
  const modality = asString(p.modality);
  const isImage = type === "image" || modality === "image" || mediaType.startsWith("image/");
  const kind = isImage ? "image" : "file";
  if (url) return { type: kind, url, media_type: mediaType };
  if (source) return { type: kind, source, media_type: mediaType };
  return null;
}

/** Map input + output message arrays into CloudMessages, preserving order. */
export function mapMessages(
  input: AttrValue | undefined,
  output: AttrValue | undefined,
): MappedContent {
  const messages: CloudMessage[] = [];
  const calledNames = new Set<string>();
  const systemParts: string[] = [];

  for (const arr of [input, output]) {
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const mapped = mapMessage(raw as RawMessage);
      messages.push(...mapped.messages);
      mapped.called.forEach((n) => calledNames.add(n));
      if (mapped.system) systemParts.push(mapped.system);
    }
  }

  return {
    messages,
    system: systemParts.length > 0 ? systemParts.join("\n") : undefined,
    calledNames,
  };
}

/** Map `gen_ai.tool.definitions` (the offered catalog) into CloudToolDefs. */
export function mapToolDefinitions(v: AttrValue | undefined): CloudToolDef[] {
  if (!Array.isArray(v)) return [];
  const out: CloudToolDef[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const def = raw as Part;
    // Definitions may nest the schema under `function` (OpenAI-style) or inline.
    const fn = (def.function && typeof def.function === "object" ? def.function : def) as Part;
    const name = asString(fn.name);
    if (!name) continue;
    const description = asString(fn.description) ?? undefined;
    out.push({
      name,
      ...(description ? { description } : {}),
      parameters: asObject(fn.parameters),
    });
  }
  return out;
}
