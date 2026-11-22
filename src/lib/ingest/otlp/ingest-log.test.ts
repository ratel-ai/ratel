import assert from "node:assert/strict";
import { test } from "node:test";
import { traceIngestLines } from "./ingest-log";
import type { AttrMap, DecodedSpan } from "./types";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const TRACE_A = "a".repeat(32);
const TRACE_B = "b".repeat(32);

function span(
  traceId: string,
  spanId: string,
  attributes: AttrMap = {},
  extra: Partial<DecodedSpan> = {},
): DecodedSpan {
  return {
    traceId,
    spanId,
    parentSpanId: null,
    name: "span",
    kind: 1,
    startUnixMs: 1_000,
    endUnixMs: 1_500,
    attributes,
    events: [],
    statusCode: 0,
    resourceAttributes: { "telemetry.sdk.language": "python" },
    scopeName: "openinference.instrumentation.openai",
    ...extra,
  };
}

function call(
  traceId: string,
  model: string,
  costUsd: string | null,
  inputTokens = 100,
  outputTokens = 20,
) {
  return { event: { traceId, model, costUsd, inputTokens, outputTokens } };
}

test("one line per trace with its spans, calls, cost, models and tokens", () => {
  const spans = [
    span(TRACE_A, "1", { "gen_ai.conversation.id": "conv-1" }),
    span(
      TRACE_A,
      "2",
      { "gen_ai.operation.name": "execute_tool" },
      { statusCode: 2, endUnixMs: 3_000 },
    ),
    span(TRACE_A, "3"),
    span(
      TRACE_B,
      "4",
      { "mcp.method.name": "tools/call", "mcp.session.id": "mcp-1" },
      {
        resourceAttributes: { "telemetry.sdk.language": "nodejs" },
        scopeName: "@modelcontextprotocol/sdk",
      },
    ),
  ];
  const rows = [
    call(TRACE_A, "gpt-5", "0.002"),
    call(TRACE_A, "claude-sonnet-5", "0.0035"),
    call(TRACE_A, "gpt-5", null),
  ];

  const { traces } = traceIngestLines(PROJECT, spans, rows);

  assert.equal(traces.length, 2);
  const [a, b] = traces;
  assert.equal(a.spans, 3);
  assert.equal(a.model_calls, 3);
  assert.equal(a.tool_calls, 1);
  assert.equal(a.error_spans, 1);
  assert.equal(a.cost_usd, 0.0055);
  assert.equal(a.cost_bucket, "$0.001-0.01");
  assert.deepEqual(a.models, ["claude-sonnet-5", "gpt-5"]);
  assert.equal(a.input_tokens, 300);
  assert.equal(a.output_tokens, 60);
  assert.equal(a.duration_ms, 2_000);
  assert.equal(a.mcp, false);
  assert.equal(a.has_session, true);
  assert.equal(a.sdk_language, "python");
  assert.deepEqual(a.scopes, ["openinference.instrumentation.openai"]);

  assert.equal(b.spans, 1);
  assert.equal(b.model_calls, 0);
  assert.equal(b.tool_calls, 1);
  assert.equal(b.cost_usd, null);
  assert.equal(b.cost_bucket, "unpriced");
  assert.deepEqual(b.models, []);
  assert.equal(b.mcp, true);
  assert.equal(b.has_session, true);
  assert.equal(b.sdk_language, "nodejs");
});

test("the session is a hash scoped to the project, never the raw id", () => {
  const spans = [
    span(TRACE_A, "1", { "session.id": "user-chat-42" }),
    span(TRACE_B, "2", { "session.id": "user-chat-42" }),
  ];

  const { traces } = traceIngestLines(PROJECT, spans, []);
  const other = traceIngestLines("22222222-2222-4222-8222-222222222222", spans, []).traces;

  assert.match(traces[0].session_hash ?? "", /^[0-9a-f]{16}$/);
  assert.equal(traces[0].session_hash, traces[1].session_hash);
  assert.notEqual(traces[0].session_hash, other[0].session_hash);
  assert.ok(!JSON.stringify(traces).includes("user-chat-42"));
});

test("a trace with no session id has no session hash", () => {
  const { traces } = traceIngestLines(PROJECT, [span(TRACE_A, "1")], []);

  assert.equal(traces[0].has_session, false);
  assert.equal(traces[0].session_hash, undefined);
});

test("trace size in kilobytes, and its bucket", () => {
  const small = span(TRACE_A, "1");
  const big = span(TRACE_B, "2", { "gen_ai.input.messages": "x".repeat(20_000) });

  const { traces } = traceIngestLines(PROJECT, [small, big], []);

  assert.ok(traces[0].size_kb > 0 && traces[0].size_kb < 1);
  assert.equal(traces[0].size_bucket, "<1 KB");
  assert.ok(traces[1].size_kb > 19.5 && traces[1].size_kb < 21);
  assert.equal(traces[1].size_bucket, "10-100 KB");
});

test("the batch line sums the export, sessions counted once", () => {
  const spans = [
    span(TRACE_A, "1", { "session.id": "s1" }),
    span(TRACE_A, "2"),
    span(TRACE_B, "3", { "session.id": "s1", "mcp.method.name": "tools/call" }),
  ];

  const { batch } = traceIngestLines(PROJECT, spans, [call(TRACE_A, "gpt-5", "0.25")]);

  assert.deepEqual(
    { ...batch, size_kb: undefined },
    {
      traces: 2,
      sessions: 1,
      turns: 2,
      spans: 3,
      model_calls: 1,
      tool_calls: 1,
      mcp_traces: 1,
      cost_usd: 0.25,
      trace_lines_dropped: 0,
      size_kb: undefined,
    },
  );
});

test("per-trace lines are capped per export; the batch line counts the rest", () => {
  const spans = Array.from({ length: 205 }, (_, i) => span(i.toString(16).padStart(32, "0"), "1"));

  const { batch, traces } = traceIngestLines(PROJECT, spans, []);

  assert.equal(traces.length, 200);
  assert.equal(batch.traces, 205);
  assert.equal(batch.trace_lines_dropped, 5);
});
