import { attrNumber, attrString } from "../anyvalue";
import { ancestorsOf, indexSpans } from "../attr-resolve";
import { GEN_AI } from "../constants";
import { isAnchor, isModelCall } from "../group";
import type { AttrValue, DecodedSpan } from "../types";
import { mapLegacyContent } from "./legacy-content";
import { mapMastraInput } from "./mastra-content";
import { providerFromGenAiSystem, providerFromOpenInference } from "./provider-names";

/**
 * Copy deprecated `gen_ai.*` keys and vendor
 * usage keys (OpenLLMetry, OpenInference, logfire, AI SDK 4) onto the canonical
 * semconv keys that `reconstruct.ts` and `span-rows.ts` read. Additive: the
 * alias stays, and a canonical key the span already has is never overwritten.
 * Idempotent.
 *
 * A canonical usage key or request model makes a span an anchor (one events
 * row, `group.ts`). So the OpenInference keys, which can turn a span with no
 * `gen_ai.*` key into an anchor, land only on the innermost model span with no
 * model call around it: a `generation` around a `ChatCompletion` stays a plain
 * span. Cache-only vendor keys land only on spans that are already anchors, so
 * an AI SDK `ai.generateText` wrapper with summed usage stays a plain span.
 * Nesting is read within one export, like `deriveModelCalls`.
 *
 * Older content forms (OpenLLMetry indexed keys, per-message span events)
 * become the v1.41 messages: see `legacy-content.ts`. Mastra's input, sent on
 * the spans around its model call, lands on the call: see `mastra-content.ts`.
 *
 * Then Anthropic-raw input: semconv counts cache reads and writes inside
 * `input_tokens`, but Anthropic's API (and instrumentations that copy it)
 * reports them apart. Input below the cache counts can only be that form, so
 * the cache counts are added back. Input at or above them is left as sent.
 */

interface Alias {
  canonical: string;
  /** Checked in order: the first one present wins. */
  aliases: readonly string[];
  /** Turns the alias value into the canonical value. Default: as sent. */
  mapValue?: (value: string) => string;
  kind: "number" | "string";
}

/** Deprecated `gen_ai.*` and OpenLLMetry keys: on every span. */
const GEN_AI_ALIASES: readonly Alias[] = [
  { canonical: GEN_AI.usageInputTokens, aliases: ["gen_ai.usage.prompt_tokens"], kind: "number" },
  {
    canonical: GEN_AI.usageOutputTokens,
    aliases: ["gen_ai.usage.completion_tokens"],
    kind: "number",
  },
  {
    canonical: GEN_AI.usageCacheRead,
    aliases: ["gen_ai.usage.cache_read_input_tokens"],
    kind: "number",
  },
  {
    canonical: GEN_AI.usageCacheCreation,
    aliases: ["gen_ai.usage.cache_creation_input_tokens", "gen_ai.usage.cache_write.input_tokens"],
    kind: "number",
  },
  { canonical: GEN_AI.usageReasoning, aliases: ["gen_ai.usage.reasoning_tokens"], kind: "number" },
  { canonical: GEN_AI.requestSeed, aliases: ["gen_ai.openai.request.seed"], kind: "number" },
  {
    canonical: GEN_AI.providerName,
    aliases: ["gen_ai.system"],
    mapValue: providerFromGenAiSystem,
    kind: "string",
  },
];

/** OpenInference keys: on the innermost model span only (see above). */
const OPENINFERENCE_ALIASES: readonly Alias[] = [
  { canonical: GEN_AI.usageInputTokens, aliases: ["llm.token_count.prompt"], kind: "number" },
  { canonical: GEN_AI.usageOutputTokens, aliases: ["llm.token_count.completion"], kind: "number" },
  {
    canonical: GEN_AI.usageCacheRead,
    aliases: ["llm.token_count.prompt_details.cache_read"],
    kind: "number",
  },
  {
    canonical: GEN_AI.usageCacheCreation,
    aliases: ["llm.token_count.prompt_details.cache_write"],
    kind: "number",
  },
  {
    canonical: GEN_AI.usageReasoning,
    aliases: ["llm.token_count.completion_details.reasoning"],
    kind: "number",
  },
  {
    canonical: GEN_AI.providerName,
    aliases: ["llm.provider", "llm.system"],
    mapValue: providerFromOpenInference,
    kind: "string",
  },
  { canonical: GEN_AI.requestModel, aliases: ["llm.model_name"], kind: "string" },
];

/** logfire / pydantic-ai and AI SDK 4 / early 5 cache keys: on anchors only. */
const ANCHOR_CACHE_ALIASES: readonly Alias[] = [
  {
    canonical: GEN_AI.usageCacheRead,
    aliases: ["gen_ai.usage.details.cache_read_tokens", "ai.usage.cachedInputTokens"],
    kind: "number",
  },
  {
    canonical: GEN_AI.usageCacheCreation,
    aliases: ["gen_ai.usage.details.cache_write_tokens"],
    kind: "number",
  },
];

/** AI SDK 4 `ai.response.providerMetadata` (a JSON string): provider → its cache fields. */
const PROVIDER_METADATA_KEY = "ai.response.providerMetadata";
const PROVIDER_METADATA_CACHE: readonly {
  canonical: string;
  paths: readonly (readonly [string, string])[];
}[] = [
  {
    canonical: GEN_AI.usageCacheRead,
    paths: [
      ["anthropic", "cacheReadInputTokens"],
      ["openai", "cachedPromptTokens"],
    ],
  },
  { canonical: GEN_AI.usageCacheCreation, paths: [["anthropic", "cacheCreationInputTokens"]] },
];

const OPENINFERENCE_MODEL_KEYS = [
  "llm.model_name",
  "llm.token_count.prompt",
  "llm.token_count.completion",
] as const;

/** Mutates and returns `spans`, like `normalizeAiSdkSpans`. */
export function normalizeSemconvAliases(spans: DecodedSpan[]): DecodedSpan[] {
  // Read before any alias lands, so this pass never feeds its own decisions.
  const byId = indexSpans(spans);
  const anchors = new Set(spans.filter(isAnchor));
  const openInference = innermostOpenInferenceModels(spans, byId);
  for (const span of spans) {
    const attrs = span.attributes;
    applyAliases(attrs, GEN_AI_ALIASES);
    if (openInference.has(span)) applyAliases(attrs, OPENINFERENCE_ALIASES);
    if (anchors.has(span) || openInference.has(span)) {
      applyAliases(attrs, ANCHOR_CACHE_ALIASES);
      applyProviderMetadataCache(attrs);
    }
    includeCacheInInput(attrs);
    mapLegacyContent(span);
    if (isAnchor(span)) mapMastraInput(span, byId);
  }
  return spans;
}

/**
 * OpenInference model spans that may carry canonical usage: one already an
 * anchor (adding keys changes no count), else one with no model call or other
 * OpenInference model span inside it, and no model call around it.
 */
function innermostOpenInferenceModels(
  spans: readonly DecodedSpan[],
  byId: ReadonlyMap<string, DecodedSpan>,
): Set<DecodedSpan> {
  const models = spans.filter(isOpenInferenceModel);
  const modelCalls = spans.filter(isModelCall);
  const wrapping = new Set<string>();
  for (const inner of [...models, ...modelCalls]) {
    for (const ancestor of ancestorsOf(inner, byId)) wrapping.add(ancestor.spanId);
  }
  const callIds = new Set(modelCalls.map((s) => s.spanId));
  return new Set(
    models.filter(
      (span) =>
        isAnchor(span) ||
        (!wrapping.has(span.spanId) && !ancestorsOf(span, byId).some((a) => callIds.has(a.spanId))),
    ),
  );
}

function isOpenInferenceModel(span: DecodedSpan): boolean {
  return OPENINFERENCE_MODEL_KEYS.some(
    (key) => span.attributes[key] !== undefined && span.attributes[key] !== null,
  );
}

function applyAliases(attrs: Record<string, AttrValue>, table: readonly Alias[]): void {
  for (const { canonical, aliases, mapValue, kind } of table) {
    if (attrs[canonical] !== undefined && attrs[canonical] !== null) continue;
    const value = firstValue(attrs, aliases, kind);
    if (value === undefined) continue;
    attrs[canonical] = typeof value === "string" && mapValue ? mapValue(value) : value;
  }
}

function applyProviderMetadataCache(attrs: Record<string, AttrValue>): void {
  const raw = attrString(attrs, PROVIDER_METADATA_KEY);
  if (!raw) return;
  let metadata: unknown;
  try {
    metadata = JSON.parse(raw);
  } catch {
    return; // Not JSON: nothing to read, the key stays as sent.
  }
  if (!isRecord(metadata)) return;
  for (const { canonical, paths } of PROVIDER_METADATA_CACHE) {
    if (attrs[canonical] !== undefined && attrs[canonical] !== null) continue;
    for (const [provider, field] of paths) {
      const fields = metadata[provider];
      const value = isRecord(fields) ? fields[field] : undefined;
      if (typeof value === "number" && Number.isFinite(value)) {
        attrs[canonical] = value;
        break;
      }
    }
  }
}

function includeCacheInInput(attrs: Record<string, AttrValue>): void {
  const input = attrNumber(attrs, GEN_AI.usageInputTokens);
  if (input === undefined) return;
  const cache =
    Math.max(0, attrNumber(attrs, GEN_AI.usageCacheRead) ?? 0) +
    Math.max(0, attrNumber(attrs, GEN_AI.usageCacheCreation) ?? 0);
  if (input < cache) attrs[GEN_AI.usageInputTokens] = input + cache;
}

function firstValue(
  attrs: Record<string, AttrValue>,
  keys: readonly string[],
  kind: Alias["kind"],
): AttrValue | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (kind === "number" && isNumeric(value)) return value;
    if (kind === "string" && typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** A number, or a numeric string (some exporters stringify ints): `attrNumber` reads both. */
function isNumeric(value: AttrValue | undefined): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
