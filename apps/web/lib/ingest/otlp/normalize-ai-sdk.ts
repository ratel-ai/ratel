import { EXECUTE_TOOL, GEN_AI } from "./constants";
import type { AttrMap, AttrValue, DecodedSpan } from "./types";

/**
 * Translate the Vercel AI SDK's legacy `ai.*` telemetry into the OTel GenAI
 * semantic conventions this mapper reads (`gen_ai.*`, semconv v1.42.0).
 *
 * The AI SDK's `experimental_telemetry` emits header/usage under `gen_ai.*` but
 * keeps every *content* attribute — prompt messages, tool catalog, tool call
 * args/results — under its own `ai.*` namespace, which nothing downstream here
 * understands. Untranslated, such a span still ingests with a correct token
 * TOTAL, but the categorizer finds no content to segment and folds the whole
 * input budget into `user_input` (`categorize.ts`: `if (estTotal === 0 && budget
 * > 0) est.user_input = budget`). Every AI SDK host used to hand-roll this
 * re-key before export; doing it once here lets those clients drop their copy
 * independently, at their own pace.
 *
 * Contract (all four are load-bearing — see `normalize-ai-sdk.test.ts`):
 * 1. Strictly additive. Only `gen_ai.*` keys are added; no `ai.*` key is ever
 *    removed or rewritten.
 * 2. An existing `gen_ai.*` key always wins — a client that already translated,
 *    or a native `@ai-sdk/otel` emitter, is left untouched. That makes this a
 *    no-op for all current traffic.
 * 3. Idempotent (falls out of 2).
 * 4. `gen_ai.output.messages` is deliberately NOT synthesized: the categorizer
 *    merges input and output into one message list and charges everything but
 *    the last user message to `history`, so forwarding the completion would
 *    inflate history's share of an INPUT-token budget. Tool attribution
 *    survives without it — the assistant's tool calls reappear in the next
 *    step's input messages, and `ai.toolCall` spans carry them. Revisit if the
 *    categorizer ever splits input from output budgets.
 *
 * SCOPE — only the AI SDK's leaf text/object spans are translated:
 * - `ai.toolCall` → an `execute_tool` span.
 * - `ai.*.doGenerate` / `ai.*.doStream` — i.e. `ai.generateText.doGenerate`,
 *   `ai.streamText.doStream`, `ai.generateObject.doGenerate`,
 *   `ai.streamObject.doStream` → an LLM anchor.
 *
 * Everything else is left alone, deliberately:
 * - The framework's WRAPPER spans (`ai.streamText`, `ai.generateText`, …)
 *   duplicate the entire prompt and the usage numbers, so translating them
 *   would hand `groupSpans` a second anchor for the same call (`isAnchor`
 *   counts any span with a request model or a `gen_ai.usage.*` key) and
 *   double-count its tokens and tool spans.
 * - `ai.embed.doEmbed` / `ai.embedMany.doEmbed` / `ai.rerank.doRerank` are not
 *   chat completions. Stamping `chat` on them would ingest phantom completions:
 *   anchors with no messages and no tools. Semconv has a distinct `embeddings`
 *   operation (and `LLM_OPERATIONS` accepts it), so supporting them is a
 *   deliberate feature decision, not a side effect of this translation.
 * - The `ai.` name prefix is required so a foreign instrumentation's `doStream`
 *   span can't be swept in, and a name-matching span carrying no `ai.*` payload
 *   at all is left as-is rather than promoted into an empty anchor.
 */

/** Legacy AI SDK attribute keys this reads. */
const AI = {
  promptMessages: "ai.prompt.messages",
  promptTools: "ai.prompt.tools",
  modelProvider: "ai.model.provider",
  cacheReadTokens: "ai.usage.inputTokenDetails.cacheReadTokens",
  toolName: "ai.toolCall.name",
  toolCallId: "ai.toolCall.id",
  toolCallArgs: "ai.toolCall.args",
  toolCallResult: "ai.toolCall.result",
} as const;

/** The AI SDK's tool-invocation span. */
const TOOL_CALL_SPAN = "ai.toolCall";

/** The AI SDK namespace every one of its span names and attributes carries. */
const AI_PREFIX = "ai.";

/** Name fragments marking a text/object model call (never a wrapper span). */
const MODEL_SPAN_MARKERS = ["doGenerate", "doStream"] as const;

type JsonRecord = Record<string, unknown>;

/** An AI SDK text/object model call (`ai.streamText.doStream`, `ai.generateObject.doGenerate`, …). */
function isModelSpan(name: string): boolean {
  return name.startsWith(AI_PREFIX) && MODEL_SPAN_MARKERS.some((m) => name.includes(m));
}

/**
 * Does the span actually carry AI SDK telemetry? A span whose name matches the
 * pattern but holds no `ai.*` attribute has nothing to translate, and stamping
 * an operation name on it would only manufacture an empty anchor.
 */
function hasAiSdkAttributes(a: AttrMap): boolean {
  return Object.keys(a).some((key) => key.startsWith(AI_PREFIX));
}

/**
 * Read a structured `ai.*` attribute. The AI SDK JSON-stringifies these, but
 * `anyvalue.ts` has already flattened kvlist/array encodings to native JS by the
 * time a span reaches here — so both shapes have to be tolerated.
 */
function asJson(value: AttrValue | undefined): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Add a derived key, unless the span already carries it. Absent and explicitly
 * null are both treated as "not there": `anyValueToJs` yields null for an unset
 * `AnyValue`, which is no more readable than a missing key.
 */
function setIfAbsent(attrs: AttrMap, key: string, value: AttrValue | undefined): void {
  if (value === undefined || value === null) return;
  if (attrs[key] !== undefined && attrs[key] !== null) return;
  attrs[key] = value;
}

function partText(part: JsonRecord): string | undefined {
  const text = part.text ?? part.content;
  return typeof text === "string" ? text : undefined;
}

/**
 * One AI SDK message part → its semconv part. `text`/`reasoning` map through
 * near-unchanged (`content.ts` reads `content ?? text`); the tool parts need a
 * real rename — the AI SDK spells them `tool-call` / `tool-result` with
 * `toolCallId`/`toolName`/`input`/`output`, semconv wants `tool_call` /
 * `tool_call_response` with `id`/`name`/`arguments`/`response`.
 */
function toSemconvPart(part: unknown): JsonRecord | null {
  if (!part || typeof part !== "object" || Array.isArray(part)) return null;
  const p = part as JsonRecord;
  switch (p.type) {
    case "text":
    case "reasoning": {
      const text = partText(p);
      return text === undefined ? null : { type: p.type, content: text };
    }
    case "tool-call":
      return {
        type: "tool_call",
        id: p.toolCallId ?? p.id ?? "",
        name: p.toolName ?? p.name ?? "",
        arguments: p.input ?? p.args ?? {},
      };
    case "tool-result":
      return {
        type: "tool_call_response",
        id: p.toolCallId ?? p.id ?? "",
        response: p.output ?? p.result ?? "",
      };
    default:
      // image/file parts and anything newer: skipped rather than mis-shaped.
      return null;
  }
}

function toSemconvParts(content: unknown): JsonRecord[] {
  if (typeof content === "string") return [{ type: "text", content }];
  if (!Array.isArray(content)) return [];
  return content.map(toSemconvPart).filter((p): p is JsonRecord => p !== null);
}

/**
 * Split `ai.prompt.messages` into `gen_ai.system_instructions` +
 * `gen_ai.input.messages`. Both come back as JSON strings — the encoding
 * `attrStructured` parses and `pipeline.test.ts` already exercises end to end.
 */
export function splitPromptMessages(raw: AttrValue | undefined): {
  systemInstructions?: string;
  inputMessages?: string;
} {
  const parsed = asJson(raw);
  if (!Array.isArray(parsed)) return {};
  const systemText: string[] = [];
  const input: JsonRecord[] = [];
  for (const message of parsed) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const m = message as JsonRecord;
    const role = typeof m.role === "string" ? m.role : "user";
    const parts = toSemconvParts(m.content);
    if (role === "system") {
      for (const part of parts) {
        const text = partText(part);
        if (text) systemText.push(text);
      }
      continue;
    }
    if (parts.length > 0) input.push({ role, parts });
  }
  return {
    ...(systemText.length > 0
      ? {
          systemInstructions: JSON.stringify(
            systemText.map((content) => ({ type: "text", content })),
          ),
        }
      : {}),
    ...(input.length > 0 ? { inputMessages: JSON.stringify(input) } : {}),
  };
}

/**
 * `ai.prompt.tools` → `gen_ai.tool.definitions`. The attribute is an array of
 * JSON strings (occasionally one JSON string, or already-native objects), and
 * the AI SDK spells the schema `inputSchema` where `mapToolDefinitions` reads
 * `parameters`.
 */
export function toToolDefinitions(raw: AttrValue | undefined): string | undefined {
  const list = asJson(raw);
  if (!Array.isArray(list)) return undefined;
  const defs: JsonRecord[] = [];
  for (const entry of list) {
    const tool = (typeof entry === "string" ? asJson(entry) : entry) as JsonRecord | undefined;
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const name = tool.name;
    if (typeof name !== "string" || name.length === 0) continue;
    defs.push({
      name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      parameters: tool.inputSchema ?? tool.parameters ?? {},
    });
  }
  return defs.length > 0 ? JSON.stringify(defs) : undefined;
}

/** `ai.toolCall` → the `execute_tool` shape `group.ts` / `reconstruct.ts` read. */
function normalizeToolSpan(a: AttrMap): void {
  // A tool span with no tool name isn't AI SDK telemetry we can attribute.
  const toolName = a[AI.toolName];
  if (typeof toolName !== "string" || toolName.length === 0) return;
  // Without `operation.name`, the grouper classes this span as neither an LLM
  // anchor nor a tool call and silently DISCARDS it.
  setIfAbsent(a, GEN_AI.operationName, EXECUTE_TOOL);
  setIfAbsent(a, GEN_AI.toolName, a[AI.toolName]);
  setIfAbsent(a, GEN_AI.toolCallId, a[AI.toolCallId]);
  setIfAbsent(a, GEN_AI.toolCallArguments, a[AI.toolCallArgs]);
  setIfAbsent(a, GEN_AI.toolCallResult, a[AI.toolCallResult]);
}

/** An AI SDK model call → an LLM anchor carrying its content on span attributes. */
function normalizeModelSpan(a: AttrMap): void {
  if (!hasAiSdkAttributes(a)) return;
  // `chat` puts the span on the primary anchor path rather than the
  // "has a usage attribute" fallback it would otherwise limp in on.
  setIfAbsent(a, GEN_AI.operationName, "chat");
  setIfAbsent(a, GEN_AI.providerName, a[AI.modelProvider]);
  setIfAbsent(a, GEN_AI.usageCacheRead, a[AI.cacheReadTokens]);
  const { systemInstructions, inputMessages } = splitPromptMessages(a[AI.promptMessages]);
  setIfAbsent(a, GEN_AI.systemInstructions, systemInstructions);
  setIfAbsent(a, GEN_AI.inputMessages, inputMessages);
  setIfAbsent(a, GEN_AI.toolDefinitions, toToolDefinitions(a[AI.promptTools]));
}

/**
 * Add the `gen_ai.*` attributes derived from each span's `ai.*` ones, in place.
 *
 * Runs once between decode and grouping, so all four downstream consumers
 * (`groupSpans`, `toRow`, the search derivations, `toOtelSpanRows`) see the
 * translation — they all read through the same `GEN_AI.*` / `RATEL.*` keys.
 * Mutation is safe here: the spans are freshly decoded and wholly owned by this
 * request.
 */
export function normalizeAiSdkSpans(spans: DecodedSpan[]): void {
  for (const span of spans) {
    if (span.name === TOOL_CALL_SPAN) normalizeToolSpan(span.attributes);
    else if (isModelSpan(span.name)) normalizeModelSpan(span.attributes);
  }
}
