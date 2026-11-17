import assert from "node:assert/strict";
import { test } from "node:test";
import type { OtelSpan } from "@/lib/ingest/otlp/schema";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type {
  ListProjectEventsOptions,
  ProjectEventSummary,
} from "@/lib/synthesis/traces/events-queries";
import { buildPayloadContent } from "@/lib/synthesis/traces/payload-content";
import type {
  ListSpansOptions,
  SpanSummary,
  TraceLifecycleEvent,
} from "@/lib/synthesis/traces/queries";
import type { TurnDetail } from "@/lib/views/traces/turn-detail";
import { type RunsOperationDeps, runsOperations } from "./runs";

/**
 * The runs and traces drill-downs, through dispatch with fake reads. What these
 * pin is the part an agent cannot see from the schema: that a run reads like
 * the console's run panel, that payloads arrive previewed and say so, that a
 * cursor is only good for the query it came from, and that a missing run is
 * `not_found` rather than an empty success.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const TRACE = "0af7651916cd43dd8448eb211c80319c";
const OTHER_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const T0 = Date.parse("2026-11-04T10:00:00.000Z");

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

function span(overrides: Partial<OtelSpan> & { spanId: string; at?: number }): OtelSpan {
  const { at = 0, ...rest } = overrides;
  const startedAt = new Date(T0 + at);
  const durationMs = rest.durationMs ?? 10;
  return {
    id: `00000000-0000-4000-8000-${String(rest.spanId).padStart(12, "0").slice(-12)}`,
    projectId: PROJECT,
    receivedAt: startedAt,
    traceId: TRACE,
    eventId: null,
    sourceId: null,
    parentSpanId: "root",
    name: "step",
    kind: 1,
    spanClass: "other",
    startedAt,
    endedAt: new Date(startedAt.getTime() + durationMs),
    durationMs,
    statusCode: 1,
    serviceName: "support-agent",
    scopeName: null,
    operationName: null,
    providerName: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    costUsd: null,
    searchOrigin: null,
    searchTarget: null,
    searchQuery: null,
    searchTopK: null,
    searchHitCount: null,
    experimentName: null,
    experimentArm: null,
    experimentRole: null,
    experimentAttrs: {},
    attributes: {},
    attrsTruncated: false,
    ...rest,
  } as OtelSpan;
}

const root = span({
  spanId: "root",
  parentSpanId: null,
  name: "invoke_agent support-agent",
  durationMs: 900,
});
const modelCall = span({
  spanId: "llm1",
  at: 5,
  spanClass: "llm_call",
  name: "chat gpt-5",
  model: "gpt-5",
  inputTokens: 1200,
  outputTokens: 300,
  costUsd: "0.012000",
  durationMs: 400,
  attributes: {
    "gen_ai.input.messages": JSON.stringify([
      { role: "user", parts: [{ type: "text", content: "Where is order 1234?" }] },
    ]),
    "gen_ai.output.messages": JSON.stringify([
      {
        role: "assistant",
        parts: [{ type: "text", content: "It shipped yesterday." }],
        finish_reason: "stop",
      },
    ]),
  },
});
const failedTool = span({
  spanId: "tool1",
  at: 410,
  spanClass: "tool",
  name: "execute_tool lookup_order",
  statusCode: 2,
  durationMs: 50,
  attributes: {
    "error.type": "timeout",
    "gen_ai.tool.call.arguments": JSON.stringify({ orderId: "1234" }),
    "gen_ai.tool.call.result": "x".repeat(3_000),
  },
});

function fakeDeps(overrides: Partial<RunsOperationDeps> = {}): RunsOperationDeps {
  return {
    getTraceSpansWithTruncation: async (_project, traceId) => ({
      spans: traceId === TRACE ? [root, modelCall, failedTool] : [],
      truncated: false,
    }),
    listTraceLifecycleEvents: async () => [],
    listSpans: async () => ({ items: [], hasMore: false, nextCursor: null }),
    listProjectEvents: async () => ({ items: [], hasMore: false, nextCursor: null }),
    getTraceAggregates: async () => ({
      count: 0,
      errorCount: 0,
      errorRate: 0,
      p50DurationMs: null,
      p95DurationMs: null,
      p99DurationMs: null,
      costUsd: 0,
      totalTokens: 0,
      volume: [],
    }),
    loadTurnDetail: async () => null,
    agentHealthEnabled: async () => true,
    loadPayloadContent: async () => null,
    contentOptIn: async () => true,
    ...overrides,
  };
}

function run(
  id: string,
  params: Record<string, unknown>,
  overrides: Partial<RunsOperationDeps> = {},
) {
  return dispatchOperation(id, params, {
    registry: buildRegistry(runsOperations(fakeDeps(overrides))),
    auth,
  });
}

/** A success, with `data` read as the shape the test expects. */
function ok<Data>(result: Awaited<ReturnType<typeof run>>): DispatchSuccess & { data: Data } {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`);
  return result as DispatchSuccess & { data: Data };
}

type Text = Record<string, string>;
interface SummaryData {
  traceId: string;
  status: string;
  ask: string | null;
  answer: string | null;
  steps: { spanId: string; label: string; title: string; failed: boolean; errorType?: string }[];
  totals: { tokens: number; costUsd: number };
  hiddenStepCount: number;
}
interface SpanData {
  label: string;
  toolName: string;
  errorType: string;
  status: string;
  toolArguments: string;
  toolResult: string;
  attributeCount: number;
  attributes: Text;
}
interface ConversationData {
  messageCount: number;
  contentCaptured: boolean;
  messages: { role: string; text: string; chars: number }[];
}
interface PageData<Row> {
  nextCursor: string | null;
  spans: Row[];
  logs: Row[];
}

function errorOf(result: Awaited<ReturnType<typeof run>>): string | undefined {
  return result.ok ? undefined : result.error;
}

test("get_run_summary reads a run as the panel does: ask, answer, steps in order, the failure, totals", async () => {
  const result = ok<SummaryData>(await run("get_run_summary", { traceId: TRACE.toUpperCase() }));

  assert.equal(result.data.traceId, TRACE, "a pasted uppercase id resolves to the stored one");
  assert.equal(result.data.status, "failed");
  assert.equal(result.data.ask, "Where is order 1234?");
  assert.equal(result.data.answer, "It shipped yesterday.");
  assert.deepEqual(
    result.data.steps.map((step) => [
      step.spanId,
      step.label,
      step.title,
      step.failed,
      step.errorType ?? null,
    ]),
    [
      ["llm1", "Model call", "gpt-5", false, null],
      ["tool1", "Tool call", "lookup_order", true, "timeout"],
    ],
  );
  assert.equal(result.data.totals.tokens, 1500);
  assert.equal(result.data.totals.costUsd, 0.012);
  assert.equal(result.truncated, undefined);
});

test("get_run_summary caps the steps and says how many it hid", async () => {
  const tools = Array.from({ length: 4 }, (_, index) =>
    span({ spanId: `t${index}`, at: index + 1, spanClass: "tool", name: `tool.t${index}` }),
  );
  const result = ok<SummaryData>(
    await run(
      "get_run_summary",
      { traceId: TRACE, maxSteps: 2 },
      { getTraceSpansWithTruncation: async () => ({ spans: [root, ...tools], truncated: false }) },
    ),
  );

  assert.equal(result.data.steps.length, 2);
  assert.equal(result.data.hiddenStepCount, 2);
  assert.equal(result.truncated, true);
});

test("a run that is not there, or an id that cannot be one, is not_found", async () => {
  let loads = 0;
  const counting = {
    getTraceSpansWithTruncation: async () => {
      loads += 1;
      return { spans: [], truncated: false };
    },
  };

  assert.equal(
    errorOf(await run("get_run_summary", { traceId: OTHER_TRACE }, counting)),
    "not_found",
  );
  assert.equal(
    errorOf(await run("get_run_summary", { traceId: "not-a-trace" }, counting)),
    "not_found",
  );
  assert.equal(loads, 1, "a malformed id is refused before any read, as the summary route does");
});

test("get_span surfaces the inspector's facts and previews the tool payloads", async () => {
  const result = ok<SpanData>(await run("get_span", { traceId: TRACE, spanId: "tool1" }));

  assert.equal(result.data.label, "Tool call");
  assert.equal(result.data.toolName, "lookup_order");
  assert.equal(result.data.errorType, "timeout");
  assert.equal(result.data.status, "Error");
  assert.equal(result.data.toolArguments, '{"orderId":"1234"}');
  assert.ok(result.data.toolResult.length < 1_100, "a 3,000-character result is cut");
  assert.ok(
    !("gen_ai.tool.call.result" in result.data.attributes),
    "payloads are not listed twice",
  );
  assert.equal(result.truncated, true);
});

test("get_span caps the attribute list and attributePrefix reads a subset", async () => {
  const attributes = Object.fromEntries(
    Array.from({ length: 80 }, (_, index) => [
      `custom.k${String(index).padStart(2, "0")}`,
      "v".repeat(900),
    ]),
  );
  const wide = span({
    spanId: "wide",
    attributes: { ...attributes, "gen_ai.request.model": "gpt-5" },
  });
  const deps = {
    getTraceSpansWithTruncation: async () => ({ spans: [root, wide], truncated: false }),
  };

  const all = ok<SpanData>(await run("get_span", { traceId: TRACE, spanId: "wide" }, deps));
  assert.equal(Object.keys(all.data.attributes).length, 60);
  assert.equal(all.data.attributeCount, 81);
  assert.ok(Object.values(all.data.attributes).every((value) => value.length <= 501));
  assert.equal(all.truncated, true);
  assert.match(all.hint ?? "", /attributePrefix/);

  const subset = ok<SpanData>(
    await run("get_span", { traceId: TRACE, spanId: "wide", attributePrefix: "gen_ai." }, deps),
  );
  assert.deepEqual(subset.data.attributes, { "gen_ai.request.model": "gpt-5" });

  assert.equal(errorOf(await run("get_span", { traceId: TRACE, spanId: "nope" })), "not_found");
});

test("get_trace_conversation lists each message once, cut to maxChars, and pages with offset", async () => {
  const long = "a ".repeat(600);
  const history = [
    { role: "user", parts: [{ type: "text", content: "first" }] },
    { role: "assistant", parts: [{ type: "text", content: long }] },
    { role: "user", parts: [{ type: "text", content: "second" }] },
  ];
  const calls = [0, 1].map((index) =>
    span({
      spanId: `llm${index}`,
      at: index * 10 + 1,
      spanClass: "llm_call",
      name: "chat",
      // Each call carries the whole history so far: the tab keeps each message once.
      attributes: {
        "gen_ai.input.messages": JSON.stringify(history.slice(0, index === 0 ? 1 : 3)),
      },
    }),
  );
  const deps = {
    getTraceSpansWithTruncation: async () => ({ spans: [root, ...calls], truncated: false }),
  };

  const first = ok<ConversationData>(
    await run("get_trace_conversation", { traceId: TRACE, limit: 2, maxChars: 200 }, deps),
  );
  assert.equal(first.data.messageCount, 3);
  assert.deepEqual(
    first.data.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.ok(first.data.messages[1].text.length <= 201);
  assert.equal(first.data.messages[1].chars, long.trim().length);
  assert.equal(first.truncated, true);
  assert.match(first.hint ?? "", /offset 2/);

  const second = ok<ConversationData>(
    await run("get_trace_conversation", { traceId: TRACE, offset: 2 }, deps),
  );
  assert.deepEqual(
    second.data.messages.map((message) => message.text),
    ["second"],
  );
});

test("get_trace_conversation without captured content says so instead of returning silence", async () => {
  const bare = [root, span({ spanId: "llm1", spanClass: "llm_call", name: "chat" })];
  const result = ok<ConversationData>(
    await run(
      "get_trace_conversation",
      { traceId: TRACE },
      {
        getTraceSpansWithTruncation: async () => ({ spans: bare, truncated: false }),
      },
    ),
  );

  assert.equal(result.data.contentCaptured, false);
  assert.deepEqual(result.data.messages, []);
  assert.match(result.hint ?? "", /get_run_summary/);
});

test("spans without content read the trace's payload content: the same messages, tool calls and ask as the page", async () => {
  const bare = [root, span({ spanId: "llm1", spanClass: "llm_call", name: "chat" })];
  const asked: string[] = [];
  const payload = buildPayloadContent([
    {
      eventId: "e1",
      spanId: "llm1",
      occurredAt: new Date(T0),
      latencyMs: 400,
      payload: {
        provider: "openai",
        model: "gpt-5",
        ts: new Date(T0).toISOString(),
        messages: [
          { role: "user", content: "Where is order 1234?" },
          {
            role: "assistant",
            content: [
              { type: "tool_call", id: "c1", name: "lookup_order", arguments: { orderId: "1234" } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: '{"status":"shipped"}' },
          { role: "assistant", content: "It shipped yesterday." },
        ],
        input_message_count: 3,
      },
    },
  ]);
  const overrides: Partial<RunsOperationDeps> = {
    getTraceSpansWithTruncation: async () => ({ spans: bare, truncated: false }),
    loadPayloadContent: async (_project, traceId) => {
      asked.push(traceId);
      return payload;
    },
  };

  const conversation = ok<
    ConversationData & { toolCalls: { name: string; arguments: string; result: string }[] }
  >(await run("get_trace_conversation", { traceId: TRACE }, overrides));
  assert.equal(conversation.data.contentCaptured, true);
  assert.deepEqual(
    conversation.data.messages.map(({ role, text }) => [role, text]),
    [
      ["user", "Where is order 1234?"],
      ["tool", '{"status":"shipped"}'],
      ["assistant", "It shipped yesterday."],
    ],
  );
  assert.equal(conversation.data.toolCalls[0].name, "lookup_order");
  assert.match(conversation.data.toolCalls[0].arguments, /1234/);
  assert.match(conversation.data.toolCalls[0].result, /shipped/);

  const summary = ok<SummaryData>(await run("get_run_summary", { traceId: TRACE }, overrides));
  assert.equal(summary.data.ask, "Where is order 1234?");
  assert.equal(summary.data.answer, "It shipped yesterday.");
  assert.deepEqual(asked, [TRACE, TRACE]);
});

const SPAN_ROW: SpanSummary = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  traceId: TRACE,
  spanId: "llm1",
  parentSpanId: "root",
  name: "chat gpt-5",
  kind: 3,
  spanClass: "llm_call",
  startedAt: new Date(T0),
  durationMs: 400,
  statusCode: 1,
  serviceName: "support-agent",
  operationName: "chat",
  model: "gpt-5",
  toolName: null,
  inputTokens: 1200,
  outputTokens: 300,
  totalTokens: 1500,
  costUsd: 0.012,
  experimentName: null,
};

test("list_spans hands out a cursor that only works for the query it came from", async () => {
  const seen: ListSpansOptions[] = [];
  const listSpans = async (_project: string, options: ListSpansOptions) => {
    seen.push(options);
    return {
      items: [SPAN_ROW],
      hasMore: true,
      nextCursor: { startedAt: SPAN_ROW.startedAt, id: SPAN_ROW.id },
    };
  };
  const filters = { model: "gpt", status: ["error"], scope: "root", limit: 1 };

  const first = ok<PageData<{ step: string }>>(await run("list_spans", filters, { listSpans }));
  assert.equal(first.data.spans[0].step, "model");
  assert.ok(typeof first.data.nextCursor === "string");
  assert.deepEqual(seen[0].statuses, [2], "status names map to the page's facet codes");
  assert.equal(seen[0].scope, "root");

  const second = ok<PageData<unknown>>(
    await run("list_spans", { ...filters, cursor: first.data.nextCursor }, { listSpans }),
  );
  assert.equal(seen[1].cursor?.id, SPAN_ROW.id);
  assert.equal(
    seen[1].since?.toISOString(),
    first.window?.since,
    "the next page reruns the same window",
  );
  assert.deepEqual(second.window, first.window);

  const changed = await run(
    "list_spans",
    { ...filters, model: "claude", cursor: first.data.nextCursor },
    { listSpans },
  );
  assert.equal(
    errorOf(changed),
    "invalid_params",
    "a cursor from other filters would skip or repeat rows",
  );
  assert.equal(
    errorOf(await run("list_spans", { cursor: "garbage" }, { listSpans })),
    "invalid_params",
  );
});

test("list_logs previews bodies and attributes and pages with a cursor", async () => {
  const log: ProjectEventSummary = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    occurredAt: new Date(T0),
    eventName: "ratel.experiment.results",
    traceId: TRACE,
    spanId: "llm1",
    serviceName: "support-agent",
    experimentName: "ranking-v2",
    experimentArm: "candidate",
    experimentRole: "shadow",
    body: "b".repeat(2_000),
    experimentAttrs: { "ratel.experiment.result_count": 5 },
    attributes: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, index])),
    attrsTruncated: false,
  };
  const seen: ListProjectEventsOptions[] = [];
  const listProjectEvents = async (_project: string, options: ListProjectEventsOptions) => {
    seen.push(options);
    return { items: [log], hasMore: true, nextCursor: { occurredAt: log.occurredAt, id: log.id } };
  };

  const first = ok<PageData<{ label: string; body: string; attributes: Text }>>(
    await run(
      "list_logs",
      { eventName: "experiment", tracelessOnly: false },
      { listProjectEvents },
    ),
  );
  const row = first.data.logs[0];
  assert.equal(row.label, "Results");
  assert.ok(row.body.length <= 501);
  assert.equal(Object.keys(row.attributes).length, 20);
  assert.equal(first.truncated, true);
  assert.equal(seen[0].eventName, "experiment");

  ok(
    await run(
      "list_logs",
      { eventName: "experiment", cursor: first.data.nextCursor },
      { listProjectEvents },
    ),
  );
  assert.equal(seen[1].cursor?.id, log.id);
});

function lifecycle(eventName: string, index: number): TraceLifecycleEvent {
  return {
    id: `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, "0")}`,
    eventName,
    occurredAt: new Date(T0 + index),
    spanId: null,
    experimentName: "ranking-v2",
    experimentArm: index % 2 === 0 ? "baseline" : "candidate",
    experimentRole: index % 2 === 0 ? "served" : "shadow",
    experimentSelectionId: null,
    experimentAttrs: { "ratel.experiment.agreement.top1": true, "ratel.experiment.id": "hidden" },
  };
}

test("compare_traces puts two runs side by side with the difference and record counts", async () => {
  const slow = [{ ...root, traceId: OTHER_TRACE, durationMs: 3_000 }];
  const result = ok<{
    a: { spanCount: number };
    difference: { durationMs: number; errorCount: number };
    lifecycle: { byType: { label: string; a: number; b: number }[] };
  }>(
    await run(
      "compare_traces",
      { traceIdA: TRACE, traceIdB: OTHER_TRACE },
      {
        getTraceSpansWithTruncation: async (_project, traceId) => ({
          spans: traceId === TRACE ? [root, modelCall, failedTool] : slow,
          truncated: false,
        }),
        listTraceLifecycleEvents: async (_project, traceId) =>
          traceId === TRACE
            ? [
                lifecycle("ratel.experiment.results", 0),
                lifecycle("ratel.experiment.comparison", 1),
              ]
            : [],
      },
    ),
  );

  assert.equal(result.data.a.spanCount, 3);
  assert.equal(result.data.difference.durationMs, 2_100);
  assert.equal(result.data.difference.errorCount, -1);
  assert.deepEqual(
    result.data.lifecycle.byType.map((row) => [row.label, row.a, row.b]),
    [
      ["Comparison", 1, 0],
      ["Results", 1, 0],
    ],
  );

  assert.equal(
    errorOf(await run("compare_traces", { traceIdA: TRACE, traceIdB: TRACE })),
    "invalid_params",
  );
  assert.equal(
    errorOf(await run("compare_traces", { traceIdA: TRACE, traceIdB: "1".repeat(32) })),
    "not_found",
  );
});

test("get_trace_ranking lists records in plain words, capped, without the identity keys", async () => {
  const events = Array.from({ length: 5 }, (_, index) =>
    lifecycle("ratel.experiment.results", index),
  );
  const result = ok<{
    count: number;
    total: number;
    records: { label: string; attributes: { label: string; value: string }[] }[];
  }>(
    await run(
      "get_trace_ranking",
      { traceId: TRACE, limit: 3 },
      { listTraceLifecycleEvents: async () => events },
    ),
  );

  assert.equal(result.data.count, 3);
  assert.equal(result.data.total, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.data.records[0].label, "Results");
  assert.deepEqual(
    result.data.records[0].attributes.map((attribute) => [attribute.label, attribute.value]),
    [["Same first pick", "Yes"]],
  );
});

const TURN: TurnDetail = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  sessionId: "session-1",
  turnSource: "declared" as TurnDetail["turnSource"],
  lane: "runtime",
  status: "closed",
  startedAt: new Date(T0).toISOString(),
  endedAt: new Date(T0 + 1_000).toISOString(),
  previousTurnId: null,
  nextTurnId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  calls: Array.from({ length: 3 }, (_, index) => ({
    ordinal: index,
    kind: index === 0 ? ("search" as const) : ("invoke" as const),
    eventType: index === 0 ? "search" : "gateway_invoke",
    eventId: `event-${index}`,
    occurredAt: new Date(T0 + index).toISOString(),
    gapMs: index === 0 ? null : 5,
    query: index === 0 ? { state: "captured" as const, text: "find order" } : null,
    hitCount: index === 0 ? 2 : null,
    hits: index === 0 ? [{ rank: 1, id: "lookup_order", score: 0.9 }] : [],
    targetType: index === 0 ? null : ("tool" as const),
    targetId: index === 0 ? null : "lookup_order",
    outcome: index === 0 ? null : ("error" as const),
    tookMs: 12,
    offeredRank: index === 0 ? null : 1,
    errorMessage: index === 0 ? null : "e".repeat(1_000),
    traceId: index === 0 ? null : TRACE,
    spanId: null,
  })),
};

test("get_turn reads a turn call by call, capped, behind the turn page's gate", async () => {
  const result = ok<{
    callCount: number;
    calls: { query?: string | null; errorMessage?: string }[];
  }>(await run("get_turn", { turnId: TURN.id, limit: 2 }, { loadTurnDetail: async () => TURN }));

  assert.equal(result.data.callCount, 3);
  assert.equal(result.data.calls.length, 2);
  assert.equal(result.data.calls[0].query, "find order");
  assert.ok((result.data.calls[1].errorMessage ?? "").length <= 501);
  assert.equal(result.truncated, true);

  assert.equal(errorOf(await run("get_turn", { turnId: TURN.id })), "not_found");
  assert.equal(
    errorOf(
      await run(
        "get_turn",
        { turnId: TURN.id },
        {
          loadTurnDetail: async () => TURN,
          agentHealthEnabled: async () => false,
        },
      ),
    ),
    "not_found",
    "without Agent health the page does not exist, so neither does the turn",
  );
});

test("get_run_stats applies the run filters and falls back to daily volume on a long window", async () => {
  let options: Parameters<RunsOperationDeps["getTraceAggregates"]>[1] | undefined;
  const result = ok<{ bucket: string; p50DurationMs: number; costUsd: number }>(
    await run(
      "get_run_stats",
      {
        rootName: "support",
        errorOnly: true,
        minCostUsd: 0.5,
        bucket: "hour",
        since: "2026-10-01T00:00:00.000Z",
        until: "2026-10-20T00:00:00.000Z",
      },
      {
        getTraceAggregates: async (_project, received) => {
          options = received;
          return {
            count: 40,
            errorCount: 4,
            errorRate: 0.1,
            p50DurationMs: 812.345,
            p95DurationMs: 2000,
            p99DurationMs: 4000,
            costUsd: 1.23456789,
            totalTokens: 90_000,
            volume: [{ day: "2026-10-01", count: 40, errorCount: 4 }],
          };
        },
      },
    ),
  );

  assert.equal(options?.rootName, "support");
  assert.equal(options?.errorOnly, true);
  assert.equal(options?.minCostUsd, 0.5);
  assert.equal(options?.volumeBucket, "day");
  assert.equal(result.data.bucket, "day");
  assert.equal(result.data.p50DurationMs, 812.3);
  assert.equal(result.data.costUsd, 1.234568);
  assert.match(result.hint ?? "", /Hourly/);
});

/**
 * Captured text (asks, answers, messages, search words, tool payloads) goes to
 * a signed-in member, and to an API key only with the project's content opt-in.
 * Withheld, the rest of the result stays and says why the text is missing.
 */
const OAUTH: McpAuthContext = {
  kind: "oauth",
  externalUserId: "user_abc",
  userId: "u-1",
  memberships: [
    {
      organizationId: "org-1",
      role: "member",
      organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
    },
  ],
};

const CONTENT_CASES = [
  { name: "an API key with the content opt-in off", caller: auth, optIn: false, sees: false },
  { name: "an API key with the content opt-in on", caller: auth, optIn: true, sees: true },
  { name: "a signed-in member, whatever the opt-in", caller: OAUTH, optIn: false, sees: true },
] as const;

const searchStep = span({
  spanId: "search1",
  at: 2,
  spanClass: "ratel_search",
  name: "ratel.search",
  searchQuery: "refund my order 1234",
  searchTarget: "tools",
  searchHitCount: 3,
  experimentAttrs: {
    "ratel.experiment.query": "refund my order 1234",
    "ratel.experiment.arm": "ratel",
  },
});

function runAs(
  caller: McpAuthContext,
  id: string,
  params: Record<string, unknown>,
  overrides: Partial<RunsOperationDeps> = {},
) {
  return dispatchOperation(
    id,
    { projectId: PROJECT, ...params },
    { registry: buildRegistry(runsOperations(fakeDeps(overrides))), auth: caller },
  );
}

for (const { name, caller, optIn, sees } of CONTENT_CASES) {
  test(`runs: captured text for ${name} is ${sees ? "returned" : "withheld"}`, async () => {
    const asked: string[] = [];
    const deps: Partial<RunsOperationDeps> = {
      contentOptIn: async (projectId) => (asked.push(projectId), optIn),
      getTraceSpansWithTruncation: async () => ({
        spans: [root, searchStep, modelCall, failedTool],
        truncated: false,
      }),
      loadTurnDetail: async () => ({
        ...TURN,
        linked: {
          modelCalls: 1,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: null,
          modelMs: 5,
          asked: "Where is order 1234?",
          searched: "find order",
        },
      }),
    };
    const summary = ok<
      SummaryData & { title: string; contentWithheld?: true; steps: { title: string }[] }
    >(await runAs(caller, "get_run_summary", { traceId: TRACE }, deps));
    const tool = ok<SpanData & { attributes: Text | null; contentWithheld?: true }>(
      await runAs(caller, "get_span", { traceId: TRACE, spanId: "tool1" }, deps),
    );
    const search = ok<{ title: string; searchQuery?: string; experimentAttributes: Text }>(
      await runAs(caller, "get_span", { traceId: TRACE, spanId: "search1" }, deps),
    );
    const conversation = ok<
      ConversationData & {
        toolCalls: { name: string; arguments: string | null }[];
        contentWithheld?: true;
      }
    >(await runAs(caller, "get_trace_conversation", { traceId: TRACE }, deps));
    const turn = ok<{
      linked: { asked: string | null; modelCalls: number };
      calls: { query?: string | null }[];
      contentWithheld?: true;
    }>(await runAs(caller, "get_turn", { turnId: TURN.id }, deps));

    if (sees) {
      assert.equal(summary.data.ask, "Where is order 1234?");
      assert.equal(summary.data.answer, "It shipped yesterday.");
      assert.equal(tool.data.toolArguments, '{"orderId":"1234"}');
      assert.equal(tool.data.attributes?.["error.type"], "timeout");
      assert.equal(search.data.searchQuery, "refund my order 1234");
      assert.equal(
        search.data.experimentAttributes["ratel.experiment.query"],
        "refund my order 1234",
      );
      assert.deepEqual(
        conversation.data.messages.map((message) => message.text),
        ["Where is order 1234?", "It shipped yesterday."],
      );
      assert.equal(conversation.data.toolCalls[0]!.arguments, '{"orderId":"1234"}');
      assert.equal(turn.data.linked.asked, "Where is order 1234?");
      assert.equal(turn.data.calls[0]!.query, "find order");
      for (const result of [summary, tool, conversation, turn])
        assert.equal((result.data as { contentWithheld?: true }).contentWithheld, undefined);
    } else {
      assert.equal(summary.data.ask, null);
      assert.equal(summary.data.answer, null);
      assert.equal(
        summary.data.title,
        "support-agent",
        "the run is named by its root, not its ask",
      );
      assert.equal(
        summary.data.steps.find((step) => step.title.includes("refund")),
        undefined,
        "a search step reads as its target",
      );
      assert.equal(summary.data.totals.tokens, 1500, "the rest of the run stays");
      assert.equal(tool.data.toolArguments, undefined);
      assert.equal(tool.data.toolResult, undefined);
      assert.equal(tool.data.attributes, null);
      assert.equal(tool.data.errorType, "timeout", "the error type is a fact, not text");
      assert.equal(tool.data.attributeCount, 3);
      assert.equal(search.data.searchQuery, undefined);
      assert.equal(search.data.title, "Searched tools");
      assert.deepEqual(search.data.experimentAttributes, { "ratel.experiment.arm": "ratel" });
      assert.equal(conversation.data.messageCount, 2);
      assert.deepEqual(conversation.data.messages, []);
      assert.deepEqual(
        conversation.data.toolCalls.map((call) => [call.name, call.arguments]),
        [["execute_tool lookup_order", null]],
      );
      assert.equal(turn.data.linked.asked, null);
      assert.equal(turn.data.linked.modelCalls, 1);
      assert.equal(turn.data.calls[0]!.query, null);
      for (const result of [summary, tool, conversation, turn]) {
        assert.equal((result.data as { contentWithheld?: true }).contentWithheld, true);
        assert.match(result.hint ?? "", /signed-in members/);
      }
    }
    assert.equal(
      asked.length > 0,
      caller.kind === "api-key",
      "only an API key needs the project's opt-in",
    );
  });
}
