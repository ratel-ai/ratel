import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentOnlyTrace,
  claudeAgentSdkTrace,
  LANGGRAPH_TRACE,
  langGraphTrace,
} from "./agent-span-fixtures";
import { indexSpans } from "./attr-resolve";
import { deriveSpanDimensions } from "./dimensions";
import { modelCallTraceIds } from "./group";
import { type OtelSpanRow, toOtelSpanRows } from "./span-rows";
import type { DecodedSpan } from "./types";

function span(overrides: Partial<DecodedSpan> = {}): DecodedSpan {
  return {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    parentSpanId: null,
    name: "agent turn",
    kind: 1,
    startUnixMs: 1_750_000_000_125,
    endUnixMs: 1_750_000_000_250,
    attributes: {},
    events: [],
    statusCode: 1,
    resourceAttributes: {},
    scopeName: "agent",
    ...overrides,
  };
}

test("maps span identity, hierarchy, timing, and status", () => {
  const [row] = toOtelSpanRows("project-1", [span({ parentSpanId: "fedcba9876543210" })]);

  assert.equal(row.id, "3bf6a2fe-1035-85e0-b7a3-ab48ec891552");
  assert.equal(row.projectId, "project-1");
  assert.equal(row.traceId, "0123456789abcdef0123456789abcdef");
  assert.equal(row.spanId, "0123456789abcdef");
  assert.equal(row.parentSpanId, "fedcba9876543210");
  assert.equal(row.name, "agent turn");
  assert.equal(row.kind, 1);
  assert.equal(row.startedAt.toISOString(), "2025-06-15T15:06:40.125Z");
  assert.equal(row.endedAt.toISOString(), "2025-06-15T15:06:40.250Z");
  assert.equal(row.durationMs, 125);
  assert.equal(row.statusCode, 1);
  assert.equal(row.scopeName, "agent");
});

test("normalizes an all-zero parent span id to a root", () => {
  const rows = toOtelSpanRows("project-1", [span({ parentSpanId: "0000000000000000" })]);

  assert.deepEqual(
    rows.map((row) => row.parentSpanId),
    [null],
  );
});

test("classifies LLM calls, tools, Ratel searches, and other spans", () => {
  const rows = toOtelSpanRows("project-1", [
    span({
      spanId: "0000000000000001",
      attributes: { "gen_ai.operation.name": "chat" },
    }),
    span({
      spanId: "0000000000000002",
      name: "execute_tool",
    }),
    span({
      spanId: "0000000000000003",
      name: "ratel.search",
    }),
    span({
      spanId: "0000000000000004",
    }),
  ]);

  assert.deepEqual(
    rows.map((row) => row.spanClass),
    ["llm_call", "tool", "ratel_search", "other"],
  );
});

test("promotes service and GenAI fields and computes model cost", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5-mini",
        "gen_ai.response.model": "gpt-5.5",
        "gen_ai.usage.input_tokens": 1_000,
        "gen_ai.usage.output_tokens": 200,
        "gen_ai.usage.cache_read.input_tokens": 400,
        "gen_ai.usage.reasoning.output_tokens": 32,
      },
      resourceAttributes: { "service.name": "support-agent" },
    }),
  ]);

  assert.equal(row.serviceName, "support-agent");
  assert.equal(row.operationName, "chat");
  assert.equal(row.providerName, "openai");
  assert.equal(row.model, "gpt-5.5");
  assert.equal(row.inputTokens, 1_000);
  assert.equal(row.outputTokens, 200);
  assert.equal(row.cachedTokens, 400);
  assert.equal(row.reasoningTokens, 32);
  // No price book: current gpt-5.5 at $5 in, $0.50 cached, $30 out: 600 * 5 + 400 * 0.5 + 200 * 30, per 1M.
  assert.equal(row.costUsd, "0.0092");
});

test("prices cache writes and long-context Haiku 5.5 calls", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude-haiku-5-5",
        "gen_ai.usage.input_tokens": 120_000,
        "gen_ai.usage.output_tokens": 1_000,
        "gen_ai.usage.cache_read.input_tokens": 90_000,
        "gen_ai.usage.cache_creation.input_tokens": 20_000,
      },
    }),
  ]);

  // Over 100k: 10k uncached * $0.50 + 90k read * $0.05 + 20k write * $0.625 + 1k out * $2.50.
  assert.equal(row.costUsd, "0.0245");
});

test("leaves cost absent when a priced model reports no usage", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({
      attributes: {
        "gen_ai.request.model": "gpt-5.5",
      },
    }),
  ]);

  assert.equal(row.costUsd, null);
});

test("leaves cost absent when a priced model reports only cached usage", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({
      attributes: {
        "gen_ai.request.model": "gpt-5.5",
        "gen_ai.usage.cache_read.input_tokens": 400,
      },
    }),
  ]);

  assert.equal(row.cachedTokens, 400);
  assert.equal(row.costUsd, null);
});

test("promotes Ratel search fields", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({
      name: "ratel.search",
      attributes: {
        "ratel.origin": "sdk",
        "ratel.search.target": "skill",
        "ratel.search.query": "find a calendar skill",
        "ratel.search.top_k": 8.9,
        "ratel.search.hit_count": 3,
      },
    }),
  ]);

  assert.equal(row.searchOrigin, "sdk");
  assert.equal(row.searchTarget, "skill");
  assert.equal(row.searchQuery, "find a calendar skill");
  assert.equal(row.searchTopK, 8);
  assert.equal(row.searchHitCount, 3);
});

test("promotes runtime event correlation and defaults source to service.name", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({
      attributes: { "ratel.event.id": "evt-linked" },
      resourceAttributes: { "service.name": "worker-a" },
    }),
  ]);

  assert.equal(row.eventId, "evt-linked");
  assert.equal(row.sourceId, "worker-a");
});

test("promotes experiment identity and preserves namespaced attributes", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({
      attributes: {
        "ratel.experiment.id": "search-ranking-v2",
        "ratel.experiment.arm": "candidate",
        "ratel.experiment.role": "shadow",
        "ratel.experiment.iteration": 4,
        unrelated: true,
      },
    }),
  ]);

  assert.equal(row.experimentName, "search-ranking-v2");
  assert.equal(row.experimentArm, "candidate");
  assert.equal(row.experimentRole, "shadow");
  assert.deepEqual(row.experimentAttrs, {
    "ratel.experiment.id": "search-ranking-v2",
    "ratel.experiment.arm": "candidate",
    "ratel.experiment.role": "shadow",
    "ratel.experiment.iteration": 4,
  });
});

test("strips content-bearing fields from retained attributes", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.system_instructions": "secret system prompt",
        "gen_ai.input.messages": [{ role: "user", content: "secret input" }],
        "gen_ai.output.messages": [{ role: "assistant", content: "secret output" }],
        "gen_ai.tool.definitions": [{ name: "private_tool" }],
        "gen_ai.tool.call.arguments": { account_id: "private" },
        "gen_ai.tool.call.result": "private tool output",
        "gen_ai.retrieval.query.text": "private retrieval query",
        "gen_ai.retrieval.documents": [{ content: "private document" }],
        "gen_ai.prompt": "legacy private prompt",
        "gen_ai.prompt.name": "support-prompt",
        "gen_ai.prompt.0.content": "indexed legacy private prompt",
        "gen_ai.completion": "legacy private completion",
        "gen_ai.completion.0.content": "indexed legacy private completion",
        "ratel.search.query": "private query",
      },
    }),
  ]);

  assert.deepEqual(row.attributes, {
    "gen_ai.operation.name": "chat",
    "gen_ai.prompt.name": "support-prompt",
  });
  assert.equal(row.attrsTruncated, false);
  assert.equal(row.searchQuery, "private query");
});

test("retains only namespaced and explicitly safe attributes", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({
      attributes: {
        "gen_ai.operation.name": "chat",
        "ratel.origin": "sdk",
        "ai.prompt.messages": "private Vercel input",
        "ai.response.text": "private Vercel output",
        "input.value": "private OpenInference input",
        "llm.input_messages.0.message.content": "private message",
        "traceloop.entity.input": "private Traceloop input",
        "error.type": "rate_limit",
        "server.address": "api.example.test",
        "mcp.server.name": "beluga_board",
        "mcp.session.id": "private session",
      },
    }),
  ]);

  assert.deepEqual(row.attributes, {
    "gen_ai.operation.name": "chat",
    "ratel.origin": "sdk",
    "error.type": "rate_limit",
    "server.address": "api.example.test",
    "mcp.server.name": "beluga_board",
  });
  assert.equal(row.attrsTruncated, false);
});

test("bounds persisted scalar and experiment metadata by UTF-8 bytes", () => {
  const oversizedMetadata = "😀".repeat(300);
  const oversizedContent = "x".repeat(20_000);
  const [row] = toOtelSpanRows("project-1", [
    span({
      name: oversizedMetadata,
      scopeName: oversizedMetadata,
      resourceAttributes: { "service.name": oversizedMetadata },
      attributes: {
        "gen_ai.operation.name": oversizedMetadata,
        "gen_ai.provider.name": oversizedMetadata,
        "gen_ai.response.model": oversizedMetadata,
        "ratel.search.query": oversizedContent,
        "ratel.experiment.id": oversizedMetadata,
        "ratel.experiment.arm": oversizedMetadata,
        "ratel.experiment.payload": oversizedContent,
      },
    }),
  ]);

  for (const value of [
    row.name,
    row.scopeName,
    row.serviceName,
    row.operationName,
    row.providerName,
    row.model,
    row.experimentName,
    row.experimentArm,
  ]) {
    assert.ok(value != null);
    assert.ok(Buffer.byteLength(value, "utf8") <= 1_024);
  }
  assert.ok(row.searchQuery != null);
  assert.ok(Buffer.byteLength(row.searchQuery, "utf8") <= 4 * 1_024);
  assert.ok(Buffer.byteLength(JSON.stringify(row.experimentAttrs), "utf8") <= 16 * 1_024);
  assert.equal(row.attrsTruncated, true);
});

test("caps retained attributes to 16 KiB by UTF-8 bytes", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({
      attributes: {
        "gen_ai.keep": "small",
        "ratel.oversized": "😀".repeat(5_000),
        "gen_ai.keep_after_oversized": 42,
      },
    }),
  ]);

  assert.ok(Buffer.byteLength(JSON.stringify(row.attributes), "utf8") <= 16 * 1024);
  assert.deepEqual(row.attributes, {
    "gen_ai.keep": "small",
    "gen_ai.keep_after_oversized": 42,
  });
  assert.equal(row.attrsTruncated, true);
});

test("drops spans with invalid OTel ids without dropping valid neighbors", () => {
  const rows = toOtelSpanRows("project-1", [
    span({ spanId: "", name: "missing span id" }),
    span({ traceId: "", name: "missing trace id" }),
    span({ spanId: "short", name: "short span id" }),
    span({
      traceId: "00000000000000000000000000000000",
      name: "all-zero trace id",
    }),
    span({ parentSpanId: "invalid-parent", name: "invalid parent id" }),
    span({ spanId: "fedcba9876543210", name: "kept" }),
  ]);

  assert.deepEqual(
    rows.map((row) => row.spanId),
    ["fedcba9876543210"],
  );
});

test("drops spans with invalid timestamps without dropping valid neighbors", () => {
  const rows = toOtelSpanRows("project-1", [
    span({
      spanId: "0000000000000001",
      startUnixMs: Number.NaN,
    }),
    span({
      spanId: "0000000000000002",
      endUnixMs: 8_640_000_000_000_001,
    }),
    span({
      spanId: "0000000000000003",
    }),
  ]);

  assert.deepEqual(
    rows.map((row) => row.spanId),
    ["0000000000000003"],
  );
});

test("normalizes database-unsafe integer values", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({
      kind: Number.POSITIVE_INFINITY,
      statusCode: 2_147_483_648,
      attributes: {
        "gen_ai.usage.input_tokens": Number.NaN,
        "gen_ai.usage.output_tokens": 2_147_483_648,
        "gen_ai.usage.cache_read.input_tokens": -1,
        "gen_ai.usage.reasoning.output_tokens": 6.8,
        "ratel.search.top_k": Number.NEGATIVE_INFINITY,
        "ratel.search.hit_count": -3,
      },
    }),
  ]);

  assert.equal(row.kind, 0);
  assert.equal(row.statusCode, 0);
  assert.equal(row.inputTokens, null);
  assert.equal(row.outputTokens, null);
  assert.equal(row.cachedTokens, null);
  assert.equal(row.reasoningTokens, 6);
  assert.equal(row.searchTopK, null);
  assert.equal(row.searchHitCount, null);
});

/** Flag on: dedupe agent wrappers against the traces this batch shows model calls for. */
function dedupe(spans: DecodedSpan[], stored: string[] = []) {
  return { modelCallTraces: new Set([...modelCallTraceIds(spans), ...stored]) };
}

function sum(
  rows: OtelSpanRow[],
  key: "inputTokens" | "outputTokens" | "cachedTokens" | "costUsd",
): number {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
}

for (const [label, build, children] of [
  ["LangGraph", langGraphTrace, { input: 300, output: 50, cached: 100 }],
  ["Claude Agent SDK", claudeAgentSdkTrace, { input: 1_000, output: 200, cached: 500 }],
] as const) {
  test(`flag on: a ${label} agent root is not an llm_call and stores no tokens or cost`, () => {
    const spans = build();
    const rows = toOtelSpanRows("project-1", spans, dedupe(spans));
    const [root, ...rest] = rows;
    assert.equal(root.spanClass, "other");
    assert.deepEqual(
      [root.inputTokens, root.outputTokens, root.cachedTokens, root.reasoningTokens, root.costUsd],
      [null, null, null, null, null],
    );
    // Raw usage stays in the retained attributes.
    assert.equal(root.attributes["gen_ai.usage.input_tokens"], children.input);
    assert.equal(rows.filter((r) => r.spanClass === "llm_call").length, 2);
    assert.deepEqual(
      [sum(rows, "inputTokens"), sum(rows, "outputTokens"), sum(rows, "cachedTokens")],
      [children.input, children.output, children.cached],
    );
    assert.equal(sum(rows, "costUsd"), sum(rest, "costUsd"));
  });

  test(`flag off: a ${label} agent root is an llm_call with its summed tokens`, () => {
    const rows = toOtelSpanRows("project-1", build());
    assert.equal(rows[0].spanClass, "llm_call");
    assert.equal(rows[0].inputTokens, children.input);
    assert.ok(Number(rows[0].costUsd) > 0);
    assert.equal(sum(rows, "inputTokens"), children.input * 2);
  });
}

test("an agent span with no model call in its trace keeps class, tokens and cost", () => {
  const spans = agentOnlyTrace();
  const [root] = toOtelSpanRows("project-1", spans, dedupe(spans));
  assert.equal(root.spanClass, "llm_call");
  assert.deepEqual([root.inputTokens, root.outputTokens, root.cachedTokens], [300, 50, 100]);
  assert.ok(Number(root.costUsd) > 0);
});

test("a root alone in its batch drops its tokens when storage has the model calls", () => {
  const [root] = langGraphTrace();
  const [stored] = toOtelSpanRows("project-1", [root], dedupe([root], [LANGGRAPH_TRACE]));
  assert.equal(stored.spanClass, "other");
  assert.equal(stored.inputTokens, null);
  const [lone] = toOtelSpanRows("project-1", [root], dedupe([root]));
  assert.equal(lone.spanClass, "llm_call");
  assert.equal(lone.inputTokens, 300);
});

/* --- resource environment ---------------------------------------------------- */

const PROD_RESOURCE = {
  "service.name": "agent",
  "deployment.environment.name": "prod",
  "service.version": "1.4.2",
};

test("the resource environment and service version are stored", () => {
  const [row] = toOtelSpanRows("project-1", [span({ resourceAttributes: PROD_RESOURCE })]);
  assert.equal(row.attributes["deployment.environment.name"], "prod");
  assert.equal(row.attributes["service.version"], "1.4.2");
  assert.equal(row.attributes["deployment.environment"], undefined);
});

test("a span attribute of the same key wins over the resource", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({
      resourceAttributes: PROD_RESOURCE,
      attributes: { "deployment.environment.name": "canary" },
    }),
  ]);
  assert.equal(row.attributes["deployment.environment.name"], "canary");
});

test("the legacy deployment.environment is kept when .name is absent", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({ resourceAttributes: { "deployment.environment": "staging" } }),
  ]);
  assert.equal(row.attributes["deployment.environment"], "staging");
  assert.equal(row.attributes["deployment.environment.name"], undefined);
  assert.equal(row.attributes["service.version"], undefined);
});

test("a span pays the project's own price (RC-482)", () => {
  const [row] = toOtelSpanRows(
    "project-1",
    [
      span({
        attributes: {
          "gen_ai.response.model": "gpt-5.5",
          "gen_ai.usage.input_tokens": 1_000,
          "gen_ai.usage.output_tokens": 200,
          "gen_ai.usage.cache_read.input_tokens": 400,
        },
      }),
    ],
    undefined,
    { prices: { overrides: { "gpt-5.5": { input: 1, output: 1 } } } },
  );
  // The project's gpt-5.5 at $1 in (cached at input), $1 out: (1,000 + 200) / 1M.
  assert.equal(row.costUsd, "0.0012");
});

test("a span row carries its entity dimensions; with no agent and a service, the service is the agent (RC-772)", () => {
  const base = {
    traceId: "0123456789abcdef0123456789abcdef",
    kind: 1,
    startUnixMs: 1_750_000_000_000,
    endUnixMs: 1_750_000_000_100,
    events: [],
    statusCode: 0,
    scopeName: null,
  };
  const spans: DecodedSpan[] = [
    {
      ...base,
      spanId: "1111111111111111",
      parentSpanId: "0000000000000000",
      name: "invoke_agent supervisor",
      attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "supervisor" },
      resourceAttributes: { "service.name": "app" },
    },
    {
      ...base,
      spanId: "2222222222222222",
      parentSpanId: "1111111111111111",
      name: "invoke_agent researcher",
      attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "researcher" },
      resourceAttributes: { "service.name": "app" },
    },
    {
      ...base,
      spanId: "3333333333333333",
      parentSpanId: null,
      name: "work",
      attributes: {},
      resourceAttributes: { "service.name": "worker" },
    },
    {
      ...base,
      spanId: "4444444444444444",
      parentSpanId: null,
      name: "work",
      attributes: { "mcp.session.id": "sess-9" },
      resourceAttributes: { "service.name": "unknown_service:node" },
    },
  ];
  const rows = toOtelSpanRows("project-1", spans, undefined, {
    dimensions: deriveSpanDimensions(spans, indexSpans(spans)),
  });
  const columns = (r: OtelSpanRow) => [
    r.agentKey,
    r.agentSource,
    r.callerAgentKey,
    r.mcpServer,
    r.mcpServerSource,
    r.mcpRole,
  ];
  const dims = rows.map(columns);
  assert.deepEqual(
    rows.map((r) => r.mcpSessionId),
    [null, null, null, "sess-9"],
    "the span's own mcp.session.id",
  );
  // The dimensions are never derived here: without them every column is null.
  for (const row of toOtelSpanRows("project-1", spans)) {
    assert.deepEqual(
      [...columns(row), row.mcpSessionId],
      [null, null, null, null, null, null, null],
    );
  }
  assert.deepEqual(dims, [
    ["supervisor", "semconv", null, null, null, null],
    ["researcher", "semconv", "supervisor", null, null, null],
    ["worker", "heuristic", null, null, null, null],
    [null, null, null, null, null, null],
  ]);
});

const UNPRICED_CALL = {
  "gen_ai.operation.name": "chat",
  "gen_ai.request.model": "my-own-model",
  "gen_ai.usage.input_tokens": 1_000,
  "gen_ai.usage.output_tokens": 200,
};
const costOf = (attributes: DecodedSpan["attributes"]) =>
  toOtelSpanRows("project-1", [span({ attributes })], undefined, { prices: { overrides: {} } })[0]
    .costUsd;

test("a call with no book price stores the cost the emitter sent (AOBS-3)", () => {
  assert.equal(costOf({ ...UNPRICED_CALL, "ratel.usage.cost_usd": 0.0421 }), "0.0421");
  assert.equal(costOf({ ...UNPRICED_CALL, "gen_ai.usage.cost": "0.5" }), "0.5");
  assert.equal(
    costOf({ ...UNPRICED_CALL, "ratel.usage.cost_usd": 0.1, "gen_ai.usage.cost": 0.9 }),
    "0.1",
  );
});

test("a Claude alias call stores its alias price", () => {
  // opus prices as claude-opus-5-5: $4 per 1M input.
  assert.equal(
    costOf({
      "gen_ai.request.model": "opus",
      "gen_ai.usage.input_tokens": 1_000_000,
      "gen_ai.usage.output_tokens": 0,
    }),
    "4",
  );
});

test("the book price wins over the emitter's cost", () => {
  assert.equal(
    costOf({
      "gen_ai.request.model": "gpt-5.5",
      "gen_ai.usage.input_tokens": 1_000,
      "gen_ai.usage.output_tokens": 0,
      "ratel.usage.cost_usd": 99,
    }),
    "0.005",
  );
});

test("an emitter cost that is not a plausible amount is ignored", () => {
  for (const cost of [-1, Number.NaN, "abc", 1e9]) {
    assert.equal(costOf({ ...UNPRICED_CALL, "ratel.usage.cost_usd": cost }), null, String(cost));
  }
});

test("an emitter cost on a span with no token usage is not stored, so a run total on the root never counts twice", () => {
  assert.equal(
    costOf({ "gen_ai.operation.name": "invoke_agent", "ratel.usage.cost_usd": 1.5 }),
    null,
  );
});

test("a batch whose prices are unknown stores no cost, emitter cost included", () => {
  const [row] = toOtelSpanRows(
    "project-1",
    [span({ attributes: { ...UNPRICED_CALL, "ratel.usage.cost_usd": 0.0421 } })],
    undefined,
    { prices: "unknown" },
  );
  assert.equal(row.costUsd, null);
});

test("the session falls back to the MCP transport session, and the end user comes from the resource", () => {
  const rows = toOtelSpanRows("project-1", [
    span({
      attributes: { "mcp.session.id": "mcp-1" },
      resourceAttributes: { "enduser.id": "user-9" },
    }),
    span({
      spanId: "1123456789abcdef",
      attributes: { "gen_ai.conversation.id": "conv-1", "mcp.session.id": "mcp-1" },
    }),
  ]);

  assert.deepEqual(
    rows.map((row) => [row.sessionId, row.endUserId]),
    [
      ["mcp-1", "user-9"],
      ["conv-1", null],
    ],
  );
});

test("a session or end-user id longer than 256 characters is cut, as on trace_events", () => {
  const [row] = toOtelSpanRows("project-1", [
    span({ attributes: { "session.id": "s".repeat(300), "user.id": "u".repeat(300) } }),
  ]);

  assert.equal(row.sessionId, "s".repeat(256));
  assert.equal(row.endUserId, "u".repeat(256));
});
