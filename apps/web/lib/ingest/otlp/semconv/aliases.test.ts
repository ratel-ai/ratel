import assert from "node:assert/strict";
import { test } from "node:test";
import { costFor } from "@/lib/ingest/pricing";
import { groupSpans } from "../group";
import { toRow } from "../reconstruct";
import { toOtelSpanRows } from "../span-rows";
import type { AttrMap, DecodedSpan } from "../types";
import { normalizeSemconvAliases } from "./aliases";
import { GEN_AI_SYSTEM_TO_PROVIDER } from "./provider-names";

/**
 * Flag `cloud-otlp-semconv-aliases`: deprecated `gen_ai.*` keys and the
 * OpenLLMetry cache aliases land on the canonical keys every reader uses.
 */

function span(attributes: AttrMap, p: Partial<DecodedSpan> = {}): DecodedSpan {
  return {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    parentSpanId: null,
    name: "anthropic.chat",
    kind: 3,
    startUnixMs: Date.UTC(2026, 10, 1),
    endUnixMs: Date.UTC(2026, 10, 1) + 800,
    attributes,
    events: [],
    statusCode: 0,
    resourceAttributes: {},
    scopeName: null,
    ...p,
  };
}

/* --- unit contract ------------------------------------------------------------ */

test("maps every alias onto its canonical key", () => {
  const [s] = normalizeSemconvAliases([
    span({
      "gen_ai.usage.prompt_tokens": 1_200,
      "gen_ai.usage.completion_tokens": 30,
      "gen_ai.usage.cache_read_input_tokens": 900,
      "gen_ai.usage.cache_creation_input_tokens": 50,
      "gen_ai.usage.reasoning_tokens": 7,
      "gen_ai.openai.request.seed": 42,
    }),
  ]);
  assert.equal(s.attributes["gen_ai.usage.input_tokens"], 1_200);
  assert.equal(s.attributes["gen_ai.usage.output_tokens"], 30);
  assert.equal(s.attributes["gen_ai.usage.cache_read.input_tokens"], 900);
  assert.equal(s.attributes["gen_ai.usage.cache_creation.input_tokens"], 50);
  assert.equal(s.attributes["gen_ai.usage.reasoning.output_tokens"], 7);
  assert.equal(s.attributes["gen_ai.request.seed"], 42);
  // Additive: the alias stays, so the stored span keeps what was sent.
  assert.equal(s.attributes["gen_ai.usage.prompt_tokens"], 1_200);
});

test("cache_write.input_tokens feeds cache writes", () => {
  const [s] = normalizeSemconvAliases([span({ "gen_ai.usage.cache_write.input_tokens": 64 })]);
  assert.equal(s.attributes["gen_ai.usage.cache_creation.input_tokens"], 64);
});

test("a span with both forms keeps the canonical value", () => {
  const [s] = normalizeSemconvAliases([
    span({
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.prompt_tokens": 999,
      "gen_ai.usage.cache_read.input_tokens": 5,
      "gen_ai.usage.cache_read_input_tokens": 999,
      "gen_ai.provider.name": "anthropic",
      "gen_ai.system": "openai",
    }),
  ]);
  assert.equal(s.attributes["gen_ai.usage.input_tokens"], 10);
  assert.equal(s.attributes["gen_ai.usage.cache_read.input_tokens"], 5);
  assert.equal(s.attributes["gen_ai.provider.name"], "anthropic");
});

test("the first alias present wins when two aliases name one key", () => {
  const [s] = normalizeSemconvAliases([
    span({
      "gen_ai.usage.cache_creation_input_tokens": 50,
      "gen_ai.usage.cache_write.input_tokens": 64,
    }),
  ]);
  assert.equal(s.attributes["gen_ai.usage.cache_creation.input_tokens"], 50);
});

test("gen_ai.system feeds provider_name through the value map", () => {
  const expected: Record<string, string> = {
    xai: "x_ai",
    vertex_ai: "gcp.vertex_ai",
    gemini: "gcp.gemini",
    "az.ai.inference": "azure.ai.inference",
    "az.ai.openai": "azure.ai.openai",
    mistral: "mistral_ai",
  };
  assert.deepEqual(GEN_AI_SYSTEM_TO_PROVIDER, expected);
  for (const [system, provider] of Object.entries(expected)) {
    const [s] = normalizeSemconvAliases([span({ "gen_ai.system": system })]);
    assert.equal(s.attributes["gen_ai.provider.name"], provider, system);
  }
  const [unmapped] = normalizeSemconvAliases([span({ "gen_ai.system": "anthropic" })]);
  assert.equal(unmapped.attributes["gen_ai.provider.name"], "anthropic");
});

test("ignores aliases that are not numbers or strings", () => {
  const [s] = normalizeSemconvAliases([
    span({ "gen_ai.usage.prompt_tokens": null, "gen_ai.system": ["openai"] }),
  ]);
  assert.equal(s.attributes["gen_ai.usage.input_tokens"], undefined);
  assert.equal(s.attributes["gen_ai.provider.name"], undefined);
});

test("is idempotent and leaves a span without aliases unchanged", () => {
  const plain = { "gen_ai.usage.input_tokens": 3, "gen_ai.request.model": "gpt-5" };
  const [s] = normalizeSemconvAliases([span({ ...plain })]);
  assert.deepEqual(s.attributes, plain);
  const twice = normalizeSemconvAliases(
    normalizeSemconvAliases([span({ "gen_ai.usage.prompt_tokens": 4 })]),
  );
  assert.equal(twice[0].attributes["gen_ai.usage.input_tokens"], 4);
});

/* --- end to end: events and otel_spans rows --------------------------------- */

const OPENLLMETRY_ANTHROPIC: AttrMap = {
  "gen_ai.system": "anthropic",
  // Priced with a cache-write rate above the input rate, so writes move cost.
  "gen_ai.request.model": "claude-sonnet-5",
  "gen_ai.response.model": "claude-sonnet-5",
  "gen_ai.usage.prompt_tokens": 1_000,
  "gen_ai.usage.completion_tokens": 200,
  "gen_ai.usage.cache_read_input_tokens": 900,
  "gen_ai.usage.cache_creation_input_tokens": 50,
  "gen_ai.usage.reasoning_tokens": 12,
};

test("an OpenLLMetry span yields cached_tokens in events and otel_spans rows", () => {
  const spans = normalizeSemconvAliases([span({ ...OPENLLMETRY_ANTHROPIC })]);
  const [call] = groupSpans(spans);
  const row = toRow("p1", call);
  assert.equal(row.event.cachedTokens, 900);
  assert.equal(row.event.inputTokens, 1_000);
  assert.equal(row.event.outputTokens, 200);
  assert.equal(row.event.reasoningTokens, 12);
  assert.equal(row.event.provider, "anthropic");

  const [spanRow] = toOtelSpanRows("p1", spans);
  assert.equal(spanRow.cachedTokens, 900);
  assert.equal(spanRow.reasoningTokens, 12);
});

test("cache writes feed cost", () => {
  const withWrites = normalizeSemconvAliases([span({ ...OPENLLMETRY_ANTHROPIC })]);
  const withoutWrites = normalizeSemconvAliases([
    span({ ...OPENLLMETRY_ANTHROPIC, "gen_ai.usage.cache_creation_input_tokens": 0 }),
  ]);
  const cost = (spans: DecodedSpan[]) => Number(toRow("p1", groupSpans(spans)[0]).event.costUsd);
  assert.equal(
    cost(withWrites),
    costFor("claude-sonnet-5", {
      input_tokens: 1_000,
      output_tokens: 200,
      cached_tokens: 900,
      cache_write_tokens: 50,
    }),
  );
  assert.ok(cost(withWrites) > cost(withoutWrites));
});

test("without the normalizer the same span has no cached tokens (flag off)", () => {
  const spans = [span({ ...OPENLLMETRY_ANTHROPIC })];
  const [call] = groupSpans(spans);
  assert.equal(toRow("p1", call).event.cachedTokens, null);
  assert.equal(toOtelSpanRows("p1", spans)[0].cachedTokens, null);
});

/* --- Anthropic-raw input tokens ------------------------------------------------ */

test("input below the cache counts is Anthropic-raw: cache reads and writes are added back", () => {
  const [s] = normalizeSemconvAliases([
    span({
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.cache_read.input_tokens": 900,
      "gen_ai.usage.cache_creation.input_tokens": 50,
    }),
  ]);
  assert.equal(s.attributes["gen_ai.usage.input_tokens"], 1_050);
});

test("input that already counts the cache is unchanged", () => {
  const [s] = normalizeSemconvAliases([
    span({ "gen_ai.usage.input_tokens": 1_000, "gen_ai.usage.cache_read.input_tokens": 900 }),
  ]);
  assert.equal(s.attributes["gen_ai.usage.input_tokens"], 1_000);
});

test("the Anthropic-raw fix reads aliases and runs once", () => {
  const spans = normalizeSemconvAliases([
    span({ "gen_ai.usage.prompt_tokens": 100, "gen_ai.usage.cache_read_input_tokens": 900 }),
  ]);
  normalizeSemconvAliases(spans);
  assert.equal(spans[0].attributes["gen_ai.usage.input_tokens"], 1_000);
});

test("Anthropic-raw input lands corrected in events and otel_spans rows", () => {
  const spans = normalizeSemconvAliases([
    span({
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-5",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.usage.cache_read.input_tokens": 900,
      "gen_ai.usage.cache_creation.input_tokens": 50,
    }),
  ]);
  assert.equal(toRow("p1", groupSpans(spans)[0]).event.inputTokens, 1_050);
  assert.equal(toOtelSpanRows("p1", spans)[0].inputTokens, 1_050);
});

/* --- vendor usage keys (RC-381) ------------------------------------------------ */

const OI_TRACE = "1af7651916cd43dd8448eb211c80319c";

function oi(spanId: string, parentSpanId: string | null, attributes: AttrMap = {}): DecodedSpan {
  return span(
    {
      "openinference.span.kind": "LLM",
      "llm.model_name": "gpt-4o-mini",
      "llm.token_count.prompt": 110,
      "llm.token_count.completion": 20,
      ...attributes,
    },
    { traceId: OI_TRACE, spanId, parentSpanId, name: "ChatCompletion" },
  );
}

test("OpenInference keys map to usage, provider and request model", () => {
  const [s] = normalizeSemconvAliases([
    oi("a1", null, {
      "llm.token_count.prompt": 1_200,
      "llm.token_count.prompt_details.cache_read": 900,
      "llm.token_count.prompt_details.cache_write": 50,
      "llm.token_count.completion_details.reasoning": 7,
      "llm.provider": "mistralai",
      "llm.system": "openai",
    }),
  ]);
  assert.equal(s.attributes["gen_ai.usage.input_tokens"], 1_200);
  assert.equal(s.attributes["gen_ai.usage.output_tokens"], 20);
  assert.equal(s.attributes["gen_ai.usage.cache_read.input_tokens"], 900);
  assert.equal(s.attributes["gen_ai.usage.cache_creation.input_tokens"], 50);
  assert.equal(s.attributes["gen_ai.usage.reasoning.output_tokens"], 7);
  assert.equal(s.attributes["gen_ai.provider.name"], "mistral_ai");
  assert.equal(s.attributes["gen_ai.request.model"], "gpt-4o-mini");
  const [system] = normalizeSemconvAliases([oi("a2", null, { "llm.system": "openai" })]);
  assert.equal(system.attributes["gen_ai.provider.name"], "openai");
});

test("an OpenInference span around another model span stays a plain span", () => {
  const spans = normalizeSemconvAliases([oi("outer", null), oi("inner", "outer")]);
  assert.equal(groupSpans(spans).length, 1);
  assert.equal(groupSpans(spans)[0].anchor.spanId, "inner");
  assert.equal(spans[0].attributes["gen_ai.usage.input_tokens"], undefined);
  assert.equal(spans[0].attributes["gen_ai.request.model"], undefined);
  // Idempotent: a second pass sees the inner anchor and still skips the wrapper.
  assert.equal(groupSpans(normalizeSemconvAliases(spans)).length, 1);
});

test("an OpenInference span around a gen_ai model call stays a plain span", () => {
  const inner = span(
    { "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 110 },
    { traceId: OI_TRACE, spanId: "c1", parentSpanId: "outer" },
  );
  const spans = normalizeSemconvAliases([oi("outer", null), inner]);
  assert.deepEqual(
    groupSpans(spans).map((c) => c.anchor.spanId),
    ["c1"],
  );
});

test("an OpenInference span inside a gen_ai model call stays a plain span", () => {
  const outer = span(
    { "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 110 },
    { traceId: OI_TRACE, spanId: "c1" },
  );
  const spans = normalizeSemconvAliases([outer, oi("inner", "c1")]);
  assert.deepEqual(
    groupSpans(spans).map((c) => c.anchor.spanId),
    ["c1"],
  );
});

test("logfire cache details map onto the cache keys", () => {
  const [s] = normalizeSemconvAliases([
    span({
      "gen_ai.usage.input_tokens": 1_000,
      "gen_ai.usage.details.cache_read_tokens": 800,
      "gen_ai.usage.details.cache_write_tokens": 40,
    }),
  ]);
  assert.equal(s.attributes["gen_ai.usage.cache_read.input_tokens"], 800);
  assert.equal(s.attributes["gen_ai.usage.cache_creation.input_tokens"], 40);
});

test("AI SDK 4 cache keys map on a model call", () => {
  const call = { "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 1_000 };
  const [cached] = normalizeSemconvAliases([span({ ...call, "ai.usage.cachedInputTokens": 600 })]);
  assert.equal(cached.attributes["gen_ai.usage.cache_read.input_tokens"], 600);
  const anthropic = JSON.stringify({
    anthropic: { cacheReadInputTokens: 700, cacheCreationInputTokens: 30 },
  });
  const [a] = normalizeSemconvAliases([
    span({ ...call, "ai.response.providerMetadata": anthropic }),
  ]);
  assert.equal(a.attributes["gen_ai.usage.cache_read.input_tokens"], 700);
  assert.equal(a.attributes["gen_ai.usage.cache_creation.input_tokens"], 30);
  const openai = JSON.stringify({ openai: { cachedPromptTokens: 512 } });
  const [o] = normalizeSemconvAliases([span({ ...call, "ai.response.providerMetadata": openai })]);
  assert.equal(o.attributes["gen_ai.usage.cache_read.input_tokens"], 512);
  const [bad] = normalizeSemconvAliases([
    span({ ...call, "ai.response.providerMetadata": "{not json" }),
  ]);
  assert.equal(bad.attributes["gen_ai.usage.cache_read.input_tokens"], undefined);
});

test("AI SDK cache keys on a wrapper that is not an anchor do not make it one", () => {
  const meta = JSON.stringify({ anthropic: { cacheReadInputTokens: 700 } });
  const spans = normalizeSemconvAliases([
    span(
      {
        "ai.usage.promptTokens": 1_000,
        "ai.usage.cachedInputTokens": 600,
        "ai.response.providerMetadata": meta,
      },
      { name: "ai.generateText" },
    ),
  ]);
  assert.equal(groupSpans(spans).length, 0);
  assert.equal(spans[0].attributes["gen_ai.usage.cache_read.input_tokens"], undefined);
});
