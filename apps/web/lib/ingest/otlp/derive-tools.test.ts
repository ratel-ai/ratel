import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveToolInvocations,
  isEmptyResult,
  resultFailureOf,
  toolErrorType,
} from "./derive-tools";
import type { AttrMap, DecodedSpan } from "./types";

const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);
const TRACE = "a".repeat(32);

function span(over: Partial<DecodedSpan> & { attributes?: AttrMap }): DecodedSpan {
  return {
    traceId: TRACE,
    spanId: "1".repeat(16),
    parentSpanId: null,
    name: "execute_tool find_task",
    kind: 1,
    startUnixMs: T0,
    endUnixMs: T0 + 250,
    attributes: {},
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "pm-agent" },
    scopeName: null,
    ...over,
  };
}

test("a gen_ai execute_tool span becomes one invoke_end on the otlp lane", () => {
  const [row] = deriveToolInvocations([
    span({
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "find_task",
        "gen_ai.tool.call.id": "call_1",
        "gen_ai.conversation.id": "conv-9",
        "user.id": "u-ada",
      },
    }),
  ]);
  assert.equal(row.type, "invoke_end");
  assert.equal(row.ingestSource, "otlp");
  assert.equal(row.toolId, "find_task");
  assert.equal(row.invocationId, "call_1");
  assert.equal(row.sessionId, "conv-9");
  assert.equal(row.endUserId, "u-ada");
  assert.equal(row.tookMs, 250);
  assert.equal(row.traceId, TRACE);
  assert.equal(row.sourceId, "pm-agent");
  assert.equal(row.clientEventId, `otlp:tool:${TRACE}:${"1".repeat(16)}`);
  assert.equal(row.payload.dialect, "genai");
  assert.equal(row.payload.has_session, true);
});

test("each dialect's tool span is recognised and named", () => {
  const cases: Array<[string, Partial<DecodedSpan>]> = [
    [
      "openinference",
      {
        name: "find_task",
        attributes: { "openinference.span.kind": "TOOL", "tool.name": "find_task" },
      },
    ],
    [
      "traceloop",
      {
        name: "find_task.tool",
        attributes: { "traceloop.span.kind": "tool", "traceloop.entity.name": "find_task" },
      },
    ],
    [
      "langsmith",
      {
        name: "find_task",
        attributes: { "langsmith.span.kind": "tool", "gen_ai.tool.name": "find_task" },
      },
    ],
    [
      "vercel",
      {
        name: "ai.toolCall",
        attributes: { "ai.toolCall.name": "find_task", "ai.toolCall.id": "c1" },
      },
    ],
    [
      "mcp",
      { name: "tools/call find_task", kind: 3, attributes: { "mcp.method.name": "tools/call" } },
    ],
    ["genai", { name: "execute_tool find_task", attributes: {} }],
  ];
  for (const [dialect, over] of cases) {
    const rows = deriveToolInvocations([span(over)]);
    assert.equal(rows.length, 1, dialect);
    assert.equal(rows[0].toolId, "find_task", dialect);
    assert.equal(rows[0].payload.dialect, dialect, dialect);
  }
});

test("spans that are not tool calls derive nothing", () => {
  const rows = deriveToolInvocations([
    span({
      name: "chat claude",
      attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "m" },
    }),
    span({ name: "invoke_agent pm", attributes: { "gen_ai.operation.name": "invoke_agent" } }),
    span({ name: "HTTP GET", attributes: {} }),
  ]);
  assert.equal(rows.length, 0);
});

test("session and user resolve from an ancestor, then the resource, then fall back to the trace", () => {
  const root = span({
    spanId: "2".repeat(16),
    name: "invoke_agent pm",
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "session.id": "s-root",
      "gen_ai.agent.name": "pm-agent",
    },
  });
  const tool = span({
    parentSpanId: root.spanId,
    attributes: { "gen_ai.tool.name": "find_task", "gen_ai.operation.name": "execute_tool" },
  });
  const [fromAncestor] = deriveToolInvocations([tool, root]);
  assert.equal(fromAncestor.sessionId, "s-root");
  assert.equal(fromAncestor.payload.agent, "pm-agent");

  const [fromResource] = deriveToolInvocations([
    span({
      attributes: { "gen_ai.operation.name": "execute_tool" },
      resourceAttributes: { "session.id": "s-res" },
    }),
  ]);
  assert.equal(fromResource.sessionId, "s-res");

  const [fallback] = deriveToolInvocations([
    span({ attributes: { "gen_ai.operation.name": "execute_tool" } }),
  ]);
  assert.equal(fallback.sessionId, TRACE);
  assert.equal(fallback.payload.has_session, false);
  assert.equal(
    fallback.invocationId,
    "1".repeat(16),
    "the span id stands in for a missing call id",
  );
});

test("conversation id wins over session.id", () => {
  const [row] = deriveToolInvocations([
    span({
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "session.id": "s",
        "gen_ai.conversation.id": "c",
      },
    }),
  ]);
  assert.equal(row.sessionId, "c");
});

test("errors: status, error.type, MCP tool_error, tool status and exceptions", () => {
  assert.equal(toolErrorType(span({ statusCode: 2 })), "error");
  assert.equal(
    toolErrorType(span({ attributes: { "error.type": "tool_not_found" } })),
    "tool_not_found",
  );
  assert.equal(toolErrorType(span({ attributes: { "gen_ai.tool.status": "error" } })), "error");
  assert.equal(
    toolErrorType(span({ attributes: { success: false, error_type: "timeout" } })),
    "timeout",
  );
  assert.equal(
    toolErrorType(
      span({
        events: [
          { name: "exception", timeUnixMs: T0, attributes: { "exception.type": "ValueError" } },
        ],
      }),
    ),
    "ValueError",
  );
  assert.equal(toolErrorType(span({ attributes: { "gen_ai.tool.status": "success" } })), null);

  const [row] = deriveToolInvocations([
    span({
      name: "tools/call update_status",
      attributes: { "mcp.method.name": "tools/call", "error.type": "tool_error" },
    }),
  ]);
  assert.equal(row.type, "invoke_error");
  assert.equal(row.errorMessage, "tool_error");
  assert.equal(row.payload.error_type, "tool_error");
});

test("a tool span nested in another tool span counts once", () => {
  const outer = span({
    spanId: "3".repeat(16),
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "find_task" },
  });
  const inner = span({
    spanId: "4".repeat(16),
    parentSpanId: outer.spanId,
    name: "tools/call find_task",
    attributes: { "mcp.method.name": "tools/call" },
  });
  const rows = deriveToolInvocations([inner, outer]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].spanId, outer.spanId);
});

test("content becomes an argument hash and an empty-result bit, never text", () => {
  const [row] = deriveToolInvocations([
    span({
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.call.arguments": '{"q":"secret"}',
        "gen_ai.tool.call.result": "[]",
      },
    }),
  ]);
  assert.equal(row.payload.result_empty, true);
  assert.match(String(row.payload.arg_hash), /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(row).includes("secret"));

  const [noContent] = deriveToolInvocations([
    span({ attributes: { "gen_ai.operation.name": "execute_tool" } }),
  ]);
  assert.equal("result_empty" in noContent.payload, false);
  assert.equal("arg_hash" in noContent.payload, false);
});

test("isEmptyResult", () => {
  for (const empty of [
    "[]",
    "{}",
    "null",
    "",
    "No results found.",
    '{"results":[]}',
    '{"content":[{"type":"text","text":""}]}',
  ]) {
    assert.equal(isEmptyResult(empty), true, empty);
  }
  for (const full of [
    '[{"id":1}]',
    '{"id":1}',
    "Task T-12 assigned",
    '{"results":[{"id":1}]}',
    "0",
  ]) {
    assert.equal(isEmptyResult(full), false, full);
  }
});

test("a call whose result reports a failure is an error, typed by its HTTP status and error code", () => {
  const result = JSON.stringify({
    ok: false,
    error: '/api/ads/budget failed (HTTP 403): {"ok":false,"error":"tool_not_declared"}',
  });
  const [row] = deriveToolInvocations([
    span({
      attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.call.result": result },
    }),
  ]);
  assert.equal(row.type, "invoke_error");
  assert.equal(row.payload.error_type, "result:http_403:tool_not_declared");
  assert.equal("result_empty" in row.payload, false, "an error is never also an empty result");
  assert.ok(!JSON.stringify(row).includes("/api/ads"), "the text itself is not stored");
});

test("resultFailureOf reads the failure shapes tools return, and nothing else", () => {
  const failed: [unknown, string][] = [
    ['{"ok":false,"error":"insufficient_credits"}', "result:insufficient_credits"],
    ['{"success":false,"statusCode":429}', "result:http_429"],
    ['{"isError":true,"content":[{"type":"text","text":"boom"}]}', "result"],
    ['{"status":"failed"}', "result"],
    ['{"error":{"code":"rate_limited","message":"slow down"}}', "result:rate_limited"],
    // Cut short by an import's trim: still opens as a failure.
    [
      '{"ok":false,"error":"/x failed (HTTP 500): {\\"ok\\":false,\\"error\\":\\"missing_provenance\\"',
      "result:http_500:missing_provenance",
    ],
    [{ ok: false }, "result"],
  ];
  for (const [value, type] of failed) assert.equal(resultFailureOf(value), type, String(value));
  for (const fine of [
    '{"ok":true,"verdict":"fail","score":0}',
    '{"results":[],"error":null}',
    '{"ok":true,"error":"ignored"}',
    "The deploy failed with an error",
    "[]",
    null,
  ]) {
    assert.equal(resultFailureOf(fine), null, String(fine));
  }
});

test("spans without ids or a name are skipped", () => {
  assert.equal(
    deriveToolInvocations([
      span({ spanId: "", attributes: { "gen_ai.operation.name": "execute_tool" } }),
    ]).length,
    0,
  );
  assert.equal(
    deriveToolInvocations([
      span({ name: "tool", attributes: { "openinference.span.kind": "TOOL" } }),
    ]).length,
    0,
  );
});

test("an MCP call seen by client and server keys on the client's sending span on both sides", () => {
  const outer = span({
    spanId: "a".repeat(16),
    name: "tools/call find_task",
    kind: 3,
    attributes: {
      "mcp.method.name": "tools/call",
      "gen_ai.tool.name": "find_task",
      "gen_ai.conversation.id": "conv-1",
    },
  });
  const send = span({
    spanId: "b".repeat(16),
    parentSpanId: "a".repeat(16),
    name: "MCP send tools/call find_task",
    kind: 3,
    attributes: { "mcp.method.name": "tools/call" },
  });
  const server = span({
    spanId: "c".repeat(16),
    parentSpanId: "b".repeat(16),
    name: "tools/call find_task",
    kind: 2,
    attributes: {
      "mcp.method.name": "tools/call",
      "gen_ai.tool.name": "find_task",
      "mcp.session.id": "mcp-1",
    },
  });
  const [client] = deriveToolInvocations([outer, send]);
  const [serverRow] = deriveToolInvocations([server]);
  assert.equal(client.clientEventId, `otlp:tool:${TRACE}:${"b".repeat(16)}`);
  assert.equal(serverRow.clientEventId, client.clientEventId, "the store keeps one of the two");
  assert.equal(client.sessionId, "conv-1", "a conversation id wins over the MCP session");
  assert.equal(serverRow.sessionId, "mcp-1", "the MCP session when nothing else is there");
});

test("the official MCP SDK's client span names the tool only in its span name", () => {
  const [row] = deriveToolInvocations([
    span({
      name: "MCP send tools/call get_task",
      kind: 3,
      parentSpanId: "f".repeat(16),
      attributes: { "mcp.method.name": "tools/call" },
    }),
  ]);
  assert.equal(row.toolId, "get_task");
});

test("a tool call that is its trace's root span is marked root_tool", () => {
  const [root] = deriveToolInvocations([
    span({
      name: "tools/call find_task",
      kind: 2,
      attributes: { "mcp.method.name": "tools/call", "mcp.session.id": "mcp-1" },
    }),
  ]);
  const [child] = deriveToolInvocations([
    span({
      parentSpanId: "f".repeat(16),
      attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "find_task" },
    }),
  ]);
  assert.equal(root.payload.root_tool, true);
  assert.equal(root.sessionId, "mcp-1");
  assert.equal(root.payload.has_session, true);
  assert.equal("root_tool" in child.payload, false);
});

test("session and user from the AI SDK 7 runtime context and OpenLLMetry association properties", () => {
  const parent = span({
    spanId: "a".repeat(16),
    name: "invoke_agent pm-agent",
    attributes: {
      "ai.settings.context.sessionId": "sess-ai",
      "ai.settings.context.userId": "user-ai",
    },
  });
  const tool = span({
    parentSpanId: "a".repeat(16),
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "find_task" },
  });
  const [aiSdk] = deriveToolInvocations([parent, tool]);
  assert.deepEqual([aiSdk.sessionId, aiSdk.endUserId], ["sess-ai", "user-ai"]);
  const [traceloop] = deriveToolInvocations([
    span({
      name: "find_task.tool",
      attributes: {
        "traceloop.span.kind": "tool",
        "traceloop.entity.name": "find_task",
        "traceloop.association.properties.session_id": "sess-tl",
        "traceloop.association.properties.user_id": "user-tl",
      },
    }),
  ]);
  assert.deepEqual([traceloop.sessionId, traceloop.endUserId], ["sess-tl", "user-tl"]);
});
