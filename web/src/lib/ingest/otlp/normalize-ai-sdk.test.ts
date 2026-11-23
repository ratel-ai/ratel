import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeJson } from "./decode";
import { groupSpans } from "./group";
import { normalizeAiSdkSpans } from "./normalize-ai-sdk";
import { toRow } from "./reconstruct";
import type { AttrMap, DecodedSpan } from "./types";

/**
 * The Vercel AI SDK `ai.*` → `gen_ai.*` normalizer: the unit contract (additive,
 * never overwriting, idempotent, wrapper spans untouched) plus one end-to-end
 * pass proving an AI-SDK-shaped export lands the same five-bucket split that
 * `pipeline.test.ts` asserts for a native `gen_ai.*` body.
 */

/** Minimal DecodedSpan builder (mirrors group.test.ts). */
function span(name: string, attributes: AttrMap = {}, p: Partial<DecodedSpan> = {}): DecodedSpan {
  return {
    traceId: "trace-1",
    spanId: "span-1",
    parentSpanId: null,
    name,
    kind: 3,
    startUnixMs: 1_000,
    endUnixMs: 1_100,
    attributes,
    events: [],
    statusCode: 0,
    resourceAttributes: {},
    scopeName: null,
    ...p,
  };
}

/* --- scope -------------------------------------------------------------------- */

test("translates the text/object model spans and ai.toolCall, nothing else", () => {
  const inScope = [
    "ai.streamText.doStream",
    "ai.generateText.doGenerate",
    "ai.streamObject.doStream",
    "ai.generateObject.doGenerate",
  ].map((name) =>
    span(name, {
      "ai.model.provider": "anthropic",
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
    }),
  );
  const toolCall = span("ai.toolCall", { "ai.toolCall.name": "list_offers" });
  normalizeAiSdkSpans([...inScope, toolCall]);

  for (const s of inScope) {
    assert.equal(s.attributes["gen_ai.operation.name"], "chat", s.name);
    assert.equal(s.attributes["gen_ai.provider.name"], "anthropic", s.name);
    assert.deepEqual(JSON.parse(String(s.attributes["gen_ai.input.messages"])), [
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
  }
  assert.equal(toolCall.attributes["gen_ai.operation.name"], "execute_tool");
});

test("wrapper spans stay untranslated, so a call never gets a second anchor", () => {
  const wrappers = ["ai.streamText", "ai.generateText", "ai.streamObject", "ai.generateObject"].map(
    (name) =>
      span(name, {
        "ai.model.provider": "anthropic",
        "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
      }),
  );
  normalizeAiSdkSpans(wrappers);

  for (const s of wrappers) {
    assert.equal(s.attributes["gen_ai.operation.name"], undefined, s.name);
    assert.equal(s.attributes["gen_ai.input.messages"], undefined, s.name);
  }
});

test("embedding and rerank spans are out of scope — never stamped as chat", () => {
  // `chat` on an embedding would ingest a phantom completion: an anchor with no
  // messages and no tools. Semconv's `embeddings` operation is a separate,
  // deliberate feature, not a side effect of this translation.
  const spans = ["ai.embed.doEmbed", "ai.embedMany.doEmbed", "ai.rerank.doRerank"].map((name) =>
    span(name, { "ai.model.provider": "openai", "ai.value": "hello" }),
  );
  normalizeAiSdkSpans(spans);

  for (const s of spans) {
    assert.equal(s.attributes["gen_ai.operation.name"], undefined, s.name);
    assert.equal(s.attributes["gen_ai.provider.name"], undefined, s.name);
  }
});

test("a foreign span whose name merely contains doStream is not swept in", () => {
  const spans = [
    span("myframework.doStream", { "http.method": "GET" }),
    span("GET /api/chat", { "http.method": "GET" }),
    span("langchain.llm.doGenerate", { "llm.provider": "openai" }),
  ];
  normalizeAiSdkSpans(spans);

  for (const s of spans) assert.equal(s.attributes["gen_ai.operation.name"], undefined, s.name);
});

test("a name-matching span with no ai.* payload is not promoted into an empty anchor", () => {
  const model = span("ai.streamText.doStream", { "server.address": "api.anthropic.com" });
  const tool = span("ai.toolCall", { "server.address": "api.anthropic.com" });
  normalizeAiSdkSpans([model, tool]);

  assert.equal(model.attributes["gen_ai.operation.name"], undefined);
  assert.equal(tool.attributes["gen_ai.operation.name"], undefined);
});

/* --- tool spans --------------------------------------------------------------- */

test("ai.toolCall → execute_tool, without which the grouper discards the span", () => {
  const s = span("ai.toolCall", {
    "ai.toolCall.name": "list_offers",
    "ai.toolCall.id": "call_1",
    "ai.toolCall.args": '{"limit":10}',
    "ai.toolCall.result": '{"offers":[]}',
  });
  normalizeAiSdkSpans([s]);

  assert.equal(s.attributes["gen_ai.operation.name"], "execute_tool");
  assert.equal(s.attributes["gen_ai.tool.name"], "list_offers");
  assert.equal(s.attributes["gen_ai.tool.call.id"], "call_1");
  assert.equal(s.attributes["gen_ai.tool.call.arguments"], '{"limit":10}');
  assert.equal(s.attributes["gen_ai.tool.call.result"], '{"offers":[]}');
  // Strictly additive: every legacy key survives untouched.
  assert.equal(s.attributes["ai.toolCall.name"], "list_offers");
  assert.equal(s.attributes["ai.toolCall.args"], '{"limit":10}');
});

/* --- model spans -------------------------------------------------------------- */

test("model span gets the primary anchor path, provider, and the cache split", () => {
  const s = span("ai.streamText.doStream", {
    "ai.model.provider": "gateway",
    "ai.usage.inputTokenDetails.cacheReadTokens": 512,
  });
  normalizeAiSdkSpans([s]);

  assert.equal(s.attributes["gen_ai.operation.name"], "chat");
  assert.equal(s.attributes["gen_ai.provider.name"], "gateway");
  assert.equal(s.attributes["gen_ai.usage.cache_read.input_tokens"], 512);
});

test("splits system out of the prompt and keeps the rest as input messages", () => {
  const s = span("ai.streamText.doStream", {
    "ai.prompt.messages": JSON.stringify([
      { role: "system", content: "You are the CEO." },
      { role: "user", content: [{ type: "text", text: "what offers?" }] },
    ]),
  });
  normalizeAiSdkSpans([s]);

  assert.deepEqual(JSON.parse(String(s.attributes["gen_ai.system_instructions"])), [
    { type: "text", content: "You are the CEO." },
  ]);
  assert.deepEqual(JSON.parse(String(s.attributes["gen_ai.input.messages"])), [
    { role: "user", parts: [{ type: "text", content: "what offers?" }] },
  ]);
});

test("renames tool-call / tool-result parts to the semconv spelling", () => {
  const s = span("ai.streamText.doStream", {
    "ai.prompt.messages": JSON.stringify([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "list_offers", input: { limit: 5 } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "list_offers",
            output: { offers: [] },
          },
        ],
      },
    ]),
  });
  normalizeAiSdkSpans([s]);

  assert.deepEqual(JSON.parse(String(s.attributes["gen_ai.input.messages"])), [
    {
      role: "assistant",
      parts: [{ type: "tool_call", id: "c1", name: "list_offers", arguments: { limit: 5 } }],
    },
    { role: "tool", parts: [{ type: "tool_call_response", id: "c1", response: { offers: [] } }] },
  ]);
});

test("skips image/file parts rather than mis-shaping them", () => {
  const s = span("ai.streamText.doStream", {
    "ai.prompt.messages": JSON.stringify([
      {
        role: "user",
        content: [
          { type: "image", image: "data:image/png;base64,AAAA" },
          { type: "text", text: "describe it" },
        ],
      },
    ]),
  });
  normalizeAiSdkSpans([s]);

  assert.deepEqual(JSON.parse(String(s.attributes["gen_ai.input.messages"])), [
    { role: "user", parts: [{ type: "text", content: "describe it" }] },
  ]);
});

test("re-keys the tool catalog's inputSchema to the parameters the mapper reads", () => {
  const s = span("ai.streamText.doStream", {
    "ai.prompt.tools": [
      JSON.stringify({
        type: "function",
        name: "list_offers",
        description: "List offers.",
        inputSchema: { type: "object", properties: {} },
      }),
      JSON.stringify({ type: "function", name: "schema_less_ok" }),
    ],
  });
  normalizeAiSdkSpans([s]);

  assert.deepEqual(JSON.parse(String(s.attributes["gen_ai.tool.definitions"])), [
    {
      name: "list_offers",
      description: "List offers.",
      parameters: { type: "object", properties: {} },
    },
    { name: "schema_less_ok", parameters: {} },
  ]);
});

test("accepts ai.prompt.tools as one JSON string or as native objects", () => {
  const asOneString = span("ai.streamText.doStream", {
    "ai.prompt.tools": JSON.stringify([{ name: "a", inputSchema: { type: "object" } }]),
  });
  const asNative = span("ai.generateText.doGenerate", {
    "ai.prompt.tools": [{ name: "a", inputSchema: { type: "object" } }],
  });
  normalizeAiSdkSpans([asOneString, asNative]);

  const expected = [{ name: "a", parameters: { type: "object" } }];
  assert.deepEqual(JSON.parse(String(asOneString.attributes["gen_ai.tool.definitions"])), expected);
  assert.deepEqual(JSON.parse(String(asNative.attributes["gen_ai.tool.definitions"])), expected);
});

test("accepts ai.prompt.messages already decoded to a native array", () => {
  const s = span("ai.streamText.doStream", {
    "ai.prompt.messages": [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
  normalizeAiSdkSpans([s]);

  assert.deepEqual(JSON.parse(String(s.attributes["gen_ai.input.messages"])), [
    { role: "user", parts: [{ type: "text", content: "hi" }] },
  ]);
});

test("never synthesizes gen_ai.output.messages", () => {
  // Deliberate: the categorizer charges everything but the last user message to
  // `history`, so a forwarded completion would inflate history's share.
  const s = span("ai.streamText.doStream", {
    "ai.response.text": "Here are your offers.",
    "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
  });
  normalizeAiSdkSpans([s]);

  assert.equal(s.attributes["gen_ai.output.messages"], undefined);
});

test("survives malformed or absent legacy attributes", () => {
  const contentless = span("ai.streamText.doStream", { "ai.model.provider": "anthropic" });
  const broken = span("ai.generateText.doGenerate", {
    "ai.prompt.messages": "{not json",
    "ai.prompt.tools": ["{not json"],
  });
  assert.doesNotThrow(() => normalizeAiSdkSpans([contentless, broken]));

  assert.equal(contentless.attributes["gen_ai.operation.name"], "chat");
  assert.equal(contentless.attributes["gen_ai.input.messages"], undefined);
  assert.equal(broken.attributes["gen_ai.input.messages"], undefined);
  assert.equal(broken.attributes["gen_ai.tool.definitions"], undefined);
  // Still classed as a model call, so its totals land.
  assert.equal(broken.attributes["gen_ai.operation.name"], "chat");
});

/* --- never overwrite / idempotency -------------------------------------------- */

test("an existing gen_ai.* key always wins", () => {
  const model = span("ai.streamText.doStream", {
    "gen_ai.operation.name": "embeddings",
    "gen_ai.provider.name": "openai",
    "gen_ai.input.messages": '[{"role":"user","parts":[{"type":"text","content":"kept"}]}]',
    "ai.model.provider": "gateway",
    "ai.prompt.messages": JSON.stringify([{ role: "user", content: "overwritten?" }]),
  });
  const tool = span("ai.toolCall", {
    "gen_ai.tool.name": "already_translated",
    "ai.toolCall.name": "list_offers",
  });
  normalizeAiSdkSpans([model, tool]);

  assert.equal(model.attributes["gen_ai.operation.name"], "embeddings");
  assert.equal(model.attributes["gen_ai.provider.name"], "openai");
  assert.deepEqual(JSON.parse(String(model.attributes["gen_ai.input.messages"])), [
    { role: "user", parts: [{ type: "text", content: "kept" }] },
  ]);
  assert.equal(tool.attributes["gen_ai.tool.name"], "already_translated");
  assert.equal(tool.attributes["gen_ai.tool.call.id"], undefined);
});

test("running twice equals running once", () => {
  const spans = [
    span("ai.streamText.doStream", {
      "ai.model.provider": "anthropic",
      "ai.prompt.messages": JSON.stringify([
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ]),
      "ai.prompt.tools": [JSON.stringify({ name: "a", inputSchema: { type: "object" } })],
      "ai.usage.inputTokenDetails.cacheReadTokens": 7,
    }),
    span("ai.toolCall", { "ai.toolCall.name": "a", "ai.toolCall.id": "c1" }),
  ];
  normalizeAiSdkSpans(spans);
  const once = spans.map((s) => JSON.stringify(s.attributes));
  normalizeAiSdkSpans(spans);

  assert.deepEqual(
    spans.map((s) => JSON.stringify(s.attributes)),
    once,
  );
});

test("a mixed batch: the already-translated client is left alone, the raw one is fixed", () => {
  const translated = span(
    "ai.streamText.doStream",
    {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.input.messages": '[{"role":"user","parts":[{"type":"text","content":"client"}]}]',
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "client" }]),
    },
    { spanId: "span-a", traceId: "trace-a" },
  );
  const raw = span(
    "ai.streamText.doStream",
    {
      "ai.model.provider": "openai",
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "raw" }]),
    },
    { spanId: "span-b", traceId: "trace-b" },
  );
  const before = JSON.stringify(translated.attributes);
  normalizeAiSdkSpans([translated, raw]);

  assert.equal(JSON.stringify(translated.attributes), before);
  assert.equal(raw.attributes["gen_ai.operation.name"], "chat");
  assert.equal(raw.attributes["gen_ai.provider.name"], "openai");
  assert.deepEqual(JSON.parse(String(raw.attributes["gen_ai.input.messages"])), [
    { role: "user", parts: [{ type: "text", content: "raw" }] },
  ]);
});

/* --- end to end --------------------------------------------------------------- */

const START_NS = "1751800000000000000";
const END_NS = "1751800004000000000";

const sv = (s: string) => ({ stringValue: s });
const iv = (n: number) => ({ intValue: String(n) });
const kv = (key: string, value: unknown) => ({ key, value });
const jv = (obj: unknown) => ({ stringValue: JSON.stringify(obj) });
const av = (values: unknown[]) => ({ arrayValue: { values } });

/**
 * An AI-SDK-shaped OTLP/JSON export: the wrapper `ai.streamText` span, the
 * `ai.streamText.doStream` model span, and an `ai.toolCall` child. Header and
 * usage already ride `gen_ai.*` (the SDK emits those natively); every *content*
 * attribute — prompt, tool catalog, tool args — rides `ai.*`, which is exactly
 * the half the normalizer supplies. Mirrors `pipeline.test.ts`'s fixture sizes
 * so the same five-bucket assertions apply.
 */
function aiSdkBody(): Uint8Array {
  const system = `You are a coding assistant.\n<skill name="git">${"g".repeat(2000)}</skill>\n<memory>${"m".repeat(600)}</memory>`;
  const tools = [
    {
      type: "function",
      name: "search_code",
      description: "s".repeat(400),
      inputSchema: { type: "object" },
    },
    {
      type: "function",
      name: "read_file",
      description: "r".repeat(400),
      inputSchema: { type: "object" },
    },
    {
      type: "function",
      name: "legacy_a",
      description: "x".repeat(2000),
      inputSchema: { type: "object" },
    },
    {
      type: "function",
      name: "legacy_b",
      description: "y".repeat(2000),
      inputSchema: { type: "object" },
    },
  ];
  const promptMessages = [
    { role: "system", content: system },
    { role: "user", content: [{ type: "text", text: "h".repeat(800) }] },
    { role: "assistant", content: [{ type: "text", text: "a".repeat(800) }] },
    { role: "user", content: [{ type: "text", text: "the current question" }] },
  ];

  const request = {
    resourceSpans: [
      {
        resource: { attributes: [kv("service.name", sv("agent"))] },
        scopeSpans: [
          {
            scope: { name: "ai" },
            spans: [
              {
                // Wrapper span: carries a duplicate prompt + `ai.*` usage only.
                traceId: "0".repeat(31) + "1",
                spanId: "0".repeat(15) + "1",
                name: "ai.streamText",
                kind: 1,
                startTimeUnixNano: START_NS,
                endTimeUnixNano: END_NS,
                attributes: [
                  kv("operation.name", sv("ai.streamText")),
                  kv("ai.model.provider", sv("anthropic")),
                  kv("ai.prompt.messages", jv(promptMessages)),
                  kv("ai.usage.inputTokens", iv(12000)),
                  kv("ai.usage.outputTokens", iv(600)),
                ],
              },
              {
                // Model span: `gen_ai.*` header/usage, `ai.*` content.
                traceId: "0".repeat(31) + "1",
                spanId: "0".repeat(15) + "2",
                parentSpanId: "0".repeat(15) + "1",
                name: "ai.streamText.doStream",
                kind: 3,
                startTimeUnixNano: START_NS,
                endTimeUnixNano: END_NS,
                attributes: [
                  kv("gen_ai.request.model", sv("claude-opus-4-8")),
                  kv("gen_ai.response.id", sv("resp-1")),
                  kv("gen_ai.usage.input_tokens", iv(12000)),
                  kv("gen_ai.usage.output_tokens", iv(600)),
                  kv("ai.model.provider", sv("anthropic")),
                  kv("ai.usage.inputTokenDetails.cacheReadTokens", iv(11500)),
                  kv("ai.prompt.messages", jv(promptMessages)),
                  kv("ai.prompt.tools", av(tools.map((t) => jv(t)))),
                ],
              },
              {
                // Tool span: a child of the WRAPPER, as the AI SDK nests it.
                traceId: "0".repeat(31) + "1",
                spanId: "0".repeat(15) + "3",
                parentSpanId: "0".repeat(15) + "1",
                name: "ai.toolCall",
                kind: 1,
                startTimeUnixNano: START_NS,
                endTimeUnixNano: END_NS,
                attributes: [
                  kv("ai.toolCall.name", sv("search_code")),
                  kv("ai.toolCall.id", sv("c1")),
                  kv("ai.toolCall.args", jv({ q: "x" })),
                  kv("ai.toolCall.result", jv({ hits: 3 })),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  return Buffer.from(JSON.stringify(request), "utf8");
}

test("ai.*-only content → the same full 5-way split a gen_ai.* body produces", () => {
  const spans = decodeJson(aiSdkBody());
  normalizeAiSdkSpans(spans);
  const rows = groupSpans(spans).map((c) => toRow("proj-1", c));

  // The wrapper span must NOT become a second anchor for the same call.
  assert.equal(rows.length, 1);
  const { event, metric } = rows[0];

  assert.equal(event.provider, "anthropic");
  assert.equal(event.model, "claude-opus-4-8");
  assert.equal(event.inputTokens, 12000);
  assert.equal(event.cachedTokens, 11500);
  assert.equal(event.latencyMs, 4000);
  assert.ok(event.costUsd != null);

  const t = metric.tokensByCategory;
  assert.equal(t.skills + t.tools + t.history + t.memory + t.user_input, 12000);
  assert.ok(t.skills > 0, "skill block detected in the system prompt");
  assert.ok(t.tools > 0, "offered tool catalog attributed");
  assert.ok(t.history > 0, "prior turns attributed to history");
  assert.ok(t.memory > 0, "memory block detected");
  assert.ok(t.user_input > 0, "the current turn is not the whole budget");

  // The ai.toolCall span survived grouping and drove the used/unused split.
  assert.equal(metric.toolsTotalCount, 4);
  assert.equal(metric.toolsUsedCount, 1);
  assert.equal(metric.toolsByName?.search_code?.calls, 1);
  assert.ok(metric.splits.tools_used > 0, "search_code was called");
  assert.ok(metric.splits.tools_unused > 0, "legacy tools shipped but never called");
  assert.ok(metric.splits.history_cached > 0, "cache_read spilled into history");
});

test("without normalization the same body degrades to a totals-only, tool-less event", () => {
  // The regression this closes: the model span still anchors on its `gen_ai.usage.*`
  // keys, but no content is readable and the tool span is discarded outright.
  const rows = groupSpans(decodeJson(aiSdkBody())).map((c) => toRow("proj-1", c));

  assert.equal(rows.length, 1);
  const { event, metric } = rows[0];
  assert.equal(event.provider, "unknown");
  assert.equal(event.cachedTokens, null);
  assert.equal(metric.tokensByCategory.user_input, 12000);
  assert.equal(metric.toolsTotalCount, 0);
});
