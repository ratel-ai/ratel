import assert from "node:assert/strict";
import { test } from "node:test";
import { categorize } from "@/lib/ingest/categorize";
import { otlpDedupeHash, toCloudEvent, toRow } from "./reconstruct";
import type { AttrMap, DecodedEvent, DecodedSpan, GroupedCall } from "./types";

/**
 * Reconstruction parity: an OTLP call reconstructed into a CloudEvent must produce
 * the same categorizer output as the equivalent hand-built event — full 5-way
 * split when content is captured, exact totals with a user_input-dominant split
 * when it isn't. Plus per-field mapping units and the dedup contract.
 */

const START = Date.parse("2026-07-06T10:00:00Z");
const END = START + 450;

function span(p: Partial<DecodedSpan> & { attributes: AttrMap }): DecodedSpan {
  return {
    traceId: "trace-1",
    spanId: "anchor-span",
    parentSpanId: null,
    name: "chat",
    kind: 3,
    startUnixMs: START,
    endUnixMs: END,
    events: [],
    statusCode: 0,
    resourceAttributes: {},
    scopeName: null,
    ...p,
  };
}

function details(attributes: AttrMap): DecodedEvent {
  return { name: "gen_ai.client.inference.operation.details", timeUnixMs: START, attributes };
}

function toolSpan(name: string, spanId: string): DecodedSpan {
  return span({
    spanId,
    name: "execute_tool",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name },
  });
}

const baseUsage: AttrMap = {
  "gen_ai.provider.name": "openai",
  "gen_ai.request.model": "gpt-5.5",
  "gen_ai.usage.input_tokens": 1000,
  "gen_ai.usage.output_tokens": 200,
  "gen_ai.usage.cache_read.input_tokens": 400,
};

/* --- header / usage / params mapping ----------------------------------------- */

test("maps provider/model/ts/latency/usage/finish from gen_ai attrs", () => {
  const call: GroupedCall = {
    anchor: span({
      attributes: {
        ...baseUsage,
        "gen_ai.response.model": "gpt-5.5-2026-07",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.request.stream": true,
        "gen_ai.request.temperature": 0.7,
        "gen_ai.request.max_tokens": 512,
        "gen_ai.usage.reasoning.output_tokens": 32,
      },
    }),
    detailsEvent: null,
    toolSpans: [],
  };
  const e = toCloudEvent(call);
  assert.equal(e.provider, "openai");
  assert.equal(e.model, "gpt-5.5-2026-07"); // response model preferred over request
  assert.equal(e.ts, new Date(START).toISOString());
  assert.equal(e.latency_ms, 450);
  assert.equal(e.stream, true);
  assert.equal(e.finish_reason, "stop");
  assert.deepEqual(e.usage, {
    input_tokens: 1000,
    output_tokens: 200,
    cached_tokens: 400,
    reasoning_tokens: 32,
  });
  assert.deepEqual(e.params, { temperature: 0.7, max_tokens: 512 });
});

test("finish_reasons array→scalar with alias mapping; unknown dropped", () => {
  const mk = (reasons: string[]): GroupedCall => ({
    anchor: span({ attributes: { ...baseUsage, "gen_ai.response.finish_reasons": reasons } }),
    detailsEvent: null,
    toolSpans: [],
  });
  assert.equal(toCloudEvent(mk(["tool_calls", "stop"])).finish_reason, "tool_call");
  assert.equal(toCloudEvent(mk(["max_tokens"])).finish_reason, "length");
  assert.equal(toCloudEvent(mk(["end_turn"])).finish_reason, "stop");
  assert.equal(toCloudEvent(mk(["wat"])).finish_reason, undefined);
});

test("blank provider/model default to 'unknown'", () => {
  const e = toCloudEvent({
    anchor: span({
      attributes: { "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 1 },
    }),
    detailsEvent: null,
    toolSpans: [],
  });
  assert.equal(e.provider, "unknown");
  assert.equal(e.model, "unknown");
});

/* --- content-present parity -------------------------------------------------- */

test("content-present: categorize output matches an equivalent hand-built event", () => {
  const inputMessages = [
    { role: "user", parts: [{ type: "text", content: "first question ".repeat(20) }] },
    { role: "assistant", parts: [{ type: "text", content: "an earlier answer ".repeat(20) }] },
    { role: "user", parts: [{ type: "text", content: "the current question" }] },
  ];
  const outputMessages = [
    {
      role: "assistant",
      parts: [{ type: "tool_call", id: "c1", name: "search_docs", arguments: { q: "x" } }],
    },
  ];
  const systemInstructions = [
    { type: "text", content: "<skills>a big skill block ".repeat(30) + "</skills>" },
  ];
  const toolDefinitions = [
    { name: "search_docs", description: "search the docs", parameters: { type: "object" } },
    { name: "send_email", description: "send an email", parameters: { type: "object" } }, // unused
  ];

  const call: GroupedCall = {
    anchor: span({
      attributes: { ...baseUsage, "gen_ai.tool.definitions": toolDefinitions },
    }),
    detailsEvent: details({
      "gen_ai.system_instructions": systemInstructions,
      "gen_ai.input.messages": inputMessages,
      "gen_ai.output.messages": outputMessages,
    }),
    toolSpans: [],
  };

  const reconstructed = categorize(toCloudEvent(call));

  // The equivalent event a client would have posted to the old endpoint.
  const handBuilt = categorize({
    provider: "openai",
    model: "gpt-5.5",
    ts: new Date(START).toISOString(),
    latency_ms: 450,
    system: "<skills>a big skill block ".repeat(30) + "</skills>",
    tools: [
      { name: "search_docs", description: "search the docs", parameters: { type: "object" } },
      { name: "send_email", description: "send an email", parameters: { type: "object" } },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "first question ".repeat(20) }] },
      { role: "assistant", content: [{ type: "text", text: "an earlier answer ".repeat(20) }] },
      { role: "user", content: [{ type: "text", text: "the current question" }] },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "search_docs", arguments: { q: "x" } }],
      },
    ],
    usage: { input_tokens: 1000, output_tokens: 200, cached_tokens: 400 },
  });

  assert.deepEqual(reconstructed.tokensByCategory, handBuilt.tokensByCategory);
  assert.deepEqual(reconstructed.splits, handBuilt.splits);
  assert.deepEqual(reconstructed.toolsByName, handBuilt.toolsByName);
  assert.equal(reconstructed.toolsTotalCount, handBuilt.toolsTotalCount);
  assert.equal(reconstructed.toolsUsedCount, handBuilt.toolsUsedCount);
});

test("content-present: full split reconciles to input_tokens with real used/unused", () => {
  const m = categorize(
    toCloudEvent({
      anchor: span({
        attributes: {
          ...baseUsage,
          "gen_ai.tool.definitions": [
            { name: "search_docs", parameters: {} },
            { name: "send_email", parameters: {} },
          ],
        },
      }),
      detailsEvent: details({
        "gen_ai.input.messages": [
          { role: "user", parts: [{ type: "text", content: "hello there" }] },
        ],
        "gen_ai.output.messages": [
          {
            role: "assistant",
            parts: [{ type: "tool_call", id: "1", name: "search_docs", arguments: {} }],
          },
        ],
      }),
      toolSpans: [],
    }),
  );
  const sum = Object.values(m.tokensByCategory).reduce((a, b) => a + b, 0);
  assert.equal(sum, 1000);
  assert.equal(m.toolsTotalCount, 2);
  assert.equal(m.toolsUsedCount, 1);
  assert.ok(m.splits.tools_unused > 0, "send_email is offered but never called");
});

/* --- content-absent degradation --------------------------------------------- */

test("content-absent: all input tokens fold to user_input, tools_unused=0", () => {
  const m = categorize(
    toCloudEvent({
      anchor: span({ attributes: baseUsage }),
      detailsEvent: null,
      toolSpans: [],
    }),
  );
  assert.equal(m.tokensByCategory.user_input, 1000);
  assert.equal(m.tokensByCategory.skills, 0);
  assert.equal(m.tokensByCategory.tools, 0);
  assert.equal(m.splits.tools_unused, 0);
});

test("content-absent: tools_used recovered from execute_tool spans", () => {
  const m = categorize(
    toCloudEvent({
      anchor: span({ attributes: baseUsage }),
      detailsEvent: null,
      toolSpans: [toolSpan("search_docs", "t1"), toolSpan("send_email", "t2")],
    }),
  );
  assert.equal(m.toolsUsedCount, 2, "both called tools count as used");
  assert.equal(m.toolsTotalCount, 2);
  assert.equal(m.splits.tools_unused, 0, "no offered catalog → nothing is 'unused'");
  assert.ok(m.toolsByName["search_docs"]);
  assert.equal(m.toolsByName["search_docs"].calls, 1);
});

/* --- span-attribute content fallback ------------------------------------------ */

test("content falls back to anchor span attributes when the details event is absent (Mastra-style)", () => {
  // Mastra's otel-exporter emits no span events; it puts the v1.42.0 message JSON
  // on the anchor span's attributes as JSON strings.
  const e = toCloudEvent({
    anchor: span({
      attributes: {
        ...baseUsage,
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "what changed this week" }] },
        ]),
        "gen_ai.output.messages": JSON.stringify([
          {
            role: "assistant",
            parts: [
              {
                type: "tool_call",
                id: "c1",
                name: "search_capabilities",
                arguments: { query: "recent changes" },
              },
            ],
          },
        ]),
      },
    }),
    detailsEvent: null,
    toolSpans: [],
  });
  assert.deepEqual(e.messages, [
    { role: "user", content: [{ type: "text", text: "what changed this week" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "c1",
          name: "search_capabilities",
          arguments: { query: "recent changes" },
        },
      ],
    },
  ]);
});

test("details event wins over anchor span attributes when both carry messages", () => {
  const e = toCloudEvent({
    anchor: span({
      attributes: {
        ...baseUsage,
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "from the span" }] },
        ]),
      },
    }),
    detailsEvent: details({
      "gen_ai.input.messages": [
        { role: "user", parts: [{ type: "text", content: "from the event" }] },
      ],
    }),
    toolSpans: [],
  });
  assert.deepEqual(e.messages, [
    { role: "user", content: [{ type: "text", text: "from the event" }] },
  ]);
});

test("execute_tool span arguments flow into the synthetic tool_call", () => {
  const argsSpan = span({
    spanId: "t1",
    name: "execute_tool",
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search_capabilities",
      "gen_ai.tool.call.arguments": JSON.stringify({ query: "linear issue by id", top_k: 5 }),
    },
  });
  const e = toCloudEvent({
    anchor: span({ attributes: baseUsage }),
    detailsEvent: null,
    toolSpans: [argsSpan, toolSpan("send_email", "t2")],
  });
  const synthetic = e.messages.find((m) => m.role === "assistant");
  assert.ok(synthetic && typeof synthetic.content !== "string");
  assert.deepEqual(synthetic.content, [
    {
      type: "tool_call",
      id: "",
      name: "search_capabilities",
      arguments: { query: "linear issue by id", top_k: 5 },
    },
    { type: "tool_call", id: "", name: "send_email", arguments: {} },
  ]);
});

/* --- toRow ------------------------------------------------------------------- */

test("toRow reuses costFor and carries the payload + categorizer version", () => {
  const row = toRow("proj-1", {
    anchor: span({
      attributes: {
        ...baseUsage,
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude-opus-4-8",
      },
    }),
    detailsEvent: null,
    toolSpans: [],
  });
  assert.equal(row.event.projectId, "proj-1");
  assert.equal(row.event.provider, "anthropic");
  assert.equal(row.event.model, "claude-opus-4-8");
  assert.equal(row.event.inputTokens, 1000);
  assert.equal(row.event.cachedTokens, 400);
  assert.ok(row.event.costUsd != null, "claude-opus-4-8 is priced");
  assert.equal(row.metric.inputTokens, 1000);
  assert.equal(typeof row.event.categorizerVersion, "number");
  assert.equal(row.event.payload?.model, "claude-opus-4-8");
  assert.ok(row.event.occurredAt instanceof Date);
});

test("toRow keeps the anchor's trace and span id, so a captured reply joins its turn", () => {
  const row = toRow("proj-1", {
    anchor: span({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      attributes: { ...baseUsage, "gen_ai.response.id": "resp_123" },
    }),
    detailsEvent: null,
    toolSpans: [],
  });
  assert.equal(row.event.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(row.event.spanId, "00f067aa0ba902b7");
  assert.equal(
    row.event.dedupeHash,
    otlpDedupeHash({
      anchor: span({ attributes: { ...baseUsage, "gen_ai.response.id": "resp_123" } }),
      detailsEvent: null,
      toolSpans: [],
    }),
    "the dedupe key is unchanged: still the response id",
  );
});

test("toRow stores a missing trace or span id as null, never an empty string", () => {
  const row = toRow("proj-1", {
    anchor: span({ traceId: "", spanId: "", attributes: baseUsage }),
    detailsEvent: null,
    toolSpans: [],
  });
  assert.equal(row.event.traceId, null);
  assert.equal(row.event.spanId, null);
});

test("toRow prices cache writes", () => {
  const row = toRow("proj-1", {
    anchor: span({
      attributes: {
        "gen_ai.request.model": "claude-haiku-5-5",
        "gen_ai.usage.input_tokens": 50_000,
        "gen_ai.usage.output_tokens": 0,
        "gen_ai.usage.cache_creation.input_tokens": 40_000,
      },
    }),
    detailsEvent: null,
    toolSpans: [],
  });
  // 40k written at $0.125 + 10k uncached at $0.10.
  assert.equal(row.event.costUsd, "0.006");
});

test("toRow buckets a broken clock by receipt time (occurredAt=null)", () => {
  const row = toRow("proj-1", {
    anchor: span({ startUnixMs: 0, endUnixMs: 5, attributes: baseUsage }), // 1970 → implausible
    detailsEvent: null,
    toolSpans: [],
  });
  assert.equal(row.event.occurredAt, null);
  assert.ok(row.metric.eventTime instanceof Date);
});

test("toRow drops cost for an unknown model", () => {
  const row = toRow("proj-1", {
    anchor: span({ attributes: { ...baseUsage, "gen_ai.request.model": "some-unlisted-model" } }),
    detailsEvent: null,
    toolSpans: [],
  });
  assert.equal(row.event.costUsd, null);
});

/* --- dedup ------------------------------------------------------------------- */

test("dedup prefers response.id, then span id, then trace+start", () => {
  const withResp = otlpDedupeHash({
    anchor: span({ attributes: { ...baseUsage, "gen_ai.response.id": "resp_123" } }),
    detailsEvent: null,
    toolSpans: [],
  });
  const withSpan = otlpDedupeHash({
    anchor: span({ spanId: "span-xyz", attributes: baseUsage }),
    detailsEvent: null,
    toolSpans: [],
  });
  // Same response id → same hash regardless of span id (idempotent across retries).
  const withRespAgain = otlpDedupeHash({
    anchor: span({
      spanId: "different-span",
      attributes: { ...baseUsage, "gen_ai.response.id": "resp_123" },
    }),
    detailsEvent: null,
    toolSpans: [],
  });
  assert.equal(withResp, withRespAgain);
  assert.notEqual(withResp, withSpan);
});

test("dedup falls back to trace+start when no response id or span id", () => {
  const h = otlpDedupeHash({
    anchor: span({ spanId: "", traceId: "tr-9", startUnixMs: START, attributes: baseUsage }),
    detailsEvent: null,
    toolSpans: [],
  });
  assert.equal(typeof h, "string");
  assert.equal(h.length, 64);
});
