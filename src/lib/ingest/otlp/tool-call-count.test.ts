import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSpans, modelCallTraceIds } from "@/lib/ingest/otlp/group";
import { type PersistSpansDeps, persistDecodedSpans } from "@/lib/ingest/otlp/ingest-spans";
import { normalizeAiSdkSpans } from "@/lib/ingest/otlp/normalize-ai-sdk";
import type { EventWithMetric } from "@/lib/ingest/otlp/queries";
import { toRow } from "@/lib/ingest/otlp/reconstruct";
import type { AttrMap, AttrValue, DecodedSpan } from "@/lib/ingest/otlp/types";
import {
  aiSdkHistoryTrace,
  aiSdkToolSpanTrace,
  laterTurnTrace,
  TOOL_COUNT_SHAPES,
} from "@/lib/ledger/turns/tool-count-fixtures";

/**
 * Tool calls count once per call the model made, not once per model call
 * that re-sends it. In a multi-step turn every later model call carries the
 * earlier assistant tool calls in its input history; counting those inflates
 * the Tools catalog (`event_metrics.tools_by_name.calls`).
 *
 * The turn below: the user asks, call 1 calls `search`, call 2 calls `fetch`,
 * call 3 answers. Truth is search = 1, fetch = 1.
 */

const TRACE = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
const ROOT = "4000000000000001";
const START = Date.parse("2026-10-20T10:00:00Z");
const PROJECT = "11111111-1111-4111-8111-111111111111";

type Message = { role: string; parts: Record<string, AttrValue>[] };

const user: Message = {
  role: "user",
  parts: [{ type: "text", content: "Find the refund policy" }],
};
const callSearch: Message = {
  role: "assistant",
  parts: [
    { type: "tool_call", id: "call_search", name: "search", arguments: { q: "refund policy" } },
  ],
};
const searchResult: Message = {
  role: "tool",
  parts: [{ type: "tool_call_response", id: "call_search", response: "https://acme.test/refunds" }],
};
const callFetch: Message = {
  role: "assistant",
  parts: [
    {
      type: "tool_call",
      id: "call_fetch",
      name: "fetch",
      arguments: { url: "https://acme.test/refunds" },
    },
  ],
};
const fetchResult: Message = {
  role: "tool",
  parts: [{ type: "tool_call_response", id: "call_fetch", response: "Refunds within 30 days." }],
};
const answer: Message = {
  role: "assistant",
  parts: [{ type: "text", content: "Refunds within 30 days." }],
};

/** The three model calls of the turn: input history grows, output is new. */
const STEPS: { input: Message[]; output: Message[] }[] = [
  { input: [user], output: [callSearch] },
  { input: [user, callSearch, searchResult], output: [callFetch] },
  { input: [user, callSearch, searchResult, callFetch, fetchResult], output: [answer] },
];

function span(spanId: string, name: string, attributes: AttrMap, offsetMs = 0): DecodedSpan {
  return {
    traceId: TRACE,
    spanId,
    parentSpanId: spanId === ROOT ? null : ROOT,
    name,
    kind: 1,
    startUnixMs: START + offsetMs,
    endUnixMs: START + offsetMs + 100,
    attributes,
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "refund-agent" },
    scopeName: null,
  };
}

const chatAttrs: AttrMap = {
  "gen_ai.operation.name": "chat",
  "gen_ai.provider.name": "openai",
  "gen_ai.request.model": "gpt-5.5",
  "gen_ai.usage.input_tokens": 500,
  "gen_ai.usage.output_tokens": 50,
};

/** Semconv content on the opt-in inference-details event. */
function detailsEventTrace(): DecodedSpan[] {
  return [
    span(ROOT, "invoke_agent refund-agent", { "gen_ai.operation.name": "invoke_agent" }),
    ...STEPS.map((step, i) => ({
      ...span(`400000000000001${i}`, "chat gpt-5.5", chatAttrs, (i + 1) * 1_000),
      events: [
        {
          name: "gen_ai.client.inference.operation.details",
          timeUnixMs: START,
          attributes: {
            "gen_ai.input.messages": step.input,
            "gen_ai.output.messages": step.output,
          },
        },
      ],
    })),
  ];
}

/** Semconv content as JSON strings on the span (SPAN_ONLY mode, Mastra). */
function spanAttributeTrace(): DecodedSpan[] {
  return [
    span(ROOT, "invoke_agent refund-agent", { "gen_ai.operation.name": "invoke_agent" }),
    ...STEPS.map((step, i) =>
      span(
        `400000000000002${i}`,
        "chat gpt-5.5",
        {
          ...chatAttrs,
          "gen_ai.input.messages": JSON.stringify(step.input),
          "gen_ai.output.messages": JSON.stringify(step.output),
        },
        (i + 1) * 1_000,
      ),
    ),
  ];
}

/** AI SDK message shape on a `doGenerate` span (`ai.prompt.messages` + `ai.response.*`). */
function aiSdkTrace(): DecodedSpan[] {
  const toAi = (m: Message) => ({
    role: m.role,
    content: m.parts.map((p) =>
      p.type === "tool_call"
        ? { type: "tool-call", toolCallId: p.id, toolName: p.name, input: p.arguments }
        : p.type === "tool_call_response"
          ? { type: "tool-result", toolCallId: p.id, toolName: "", output: p.response }
          : { type: "text", text: p.content },
    ),
  });
  return [
    span(ROOT, "ai.generateText", { "ai.operationId": "ai.generateText" }),
    ...STEPS.map((step, i) => {
      const toolCalls = step.output
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "tool_call")
        .map((p) => ({ toolCallId: p.id, toolName: p.name, input: JSON.stringify(p.arguments) }));
      const text = step.output.flatMap((m) => m.parts).find((p) => p.type === "text");
      return span(
        `400000000000003${i}`,
        "ai.generateText.doGenerate",
        {
          "ai.operationId": "ai.generateText.doGenerate",
          "ai.model.provider": "openai.responses",
          "gen_ai.request.model": "gpt-5.5",
          "gen_ai.usage.input_tokens": 500,
          "gen_ai.usage.output_tokens": 50,
          "ai.prompt.messages": JSON.stringify(step.input.map(toAi)),
          ...(toolCalls.length > 0 ? { "ai.response.toolCalls": JSON.stringify(toolCalls) } : {}),
          ...(text ? { "ai.response.text": text.content as string } : {}),
        },
        (i + 1) * 1_000,
      );
    }),
  ];
}

/** Ingest the trace the way `/v1/traces` does and sum `tools_by_name.calls`. */
function catalogCalls(spans: DecodedSpan[]): Record<string, number> {
  normalizeAiSdkSpans(spans);
  const calls = groupSpans(spans, { modelCallTraces: modelCallTraceIds(spans) });
  const totals: Record<string, number> = {};
  for (const call of calls) {
    const row = toRow(PROJECT, call);
    for (const [name, stat] of Object.entries(row.metric.toolsByName ?? {})) {
      totals[name] = (totals[name] ?? 0) + stat.calls;
    }
  }
  return totals;
}

const TRUTH = { search: 1, fetch: 1 };

test("multi-step turn: details-event content counts each tool call once", () => {
  assert.deepEqual(catalogCalls(detailsEventTrace()), TRUTH);
});

test("multi-step turn: span-attribute content counts each tool call once", () => {
  assert.deepEqual(catalogCalls(spanAttributeTrace()), TRUTH);
});

test("multi-step turn: AI SDK content counts each tool call once", () => {
  assert.deepEqual(catalogCalls(aiSdkTrace()), TRUTH);
});

/** `/v1/traces` persistence: the rows' `tools_by_name.calls` and the logged errors. */
async function persistedCalls(spans: DecodedSpan[]) {
  const totals: Record<string, number> = {};
  const errors: string[] = [];
  const deps = {
    insertEventsWithMetrics: async (_projectId: string, rows: EventWithMetric[]) => {
      for (const row of rows) {
        for (const [name, stat] of Object.entries(row.metric.toolsByName ?? {})) {
          totals[name] = (totals[name] ?? 0) + stat.calls;
        }
      }
      return rows.length;
    },
    insertTraceEvents: async (_projectId: string, rows: unknown[]) => ({ accepted: rows.length }),
    insertOtelSpans: async (_projectId: string, rows: unknown[]) => ({ accepted: rows.length }),
    logError: (message: string) => errors.push(message),
    captureFailure: () => {},
  } as unknown as PersistSpansDeps;
  const result = await persistDecodedSpans(
    spans,
    { projectId: PROJECT, organization: null, endpoint: "/v1/traces" },
    deps,
  );
  assert.ok(result.ok);
  return { totals, errors };
}

test("persist: every OTLP batch counts each tool call once, with no flag read", async () => {
  const semconv = await persistedCalls(detailsEventTrace());
  assert.deepEqual(semconv.totals, TRUTH);
  assert.deepEqual(semconv.errors, []);
  assert.deepEqual((await persistedCalls(aiSdkTrace())).totals, TRUTH);
});

test("produced scope: a tool span whose name is only in the input history still counts", () => {
  // Call 2's input re-sends call 1's `search`; call 2 then runs `search` again
  // but its output was not captured. Its execute_tool span is the only record.
  const anchor = span("4000000000000041", "chat gpt-5.5", {
    ...chatAttrs,
    "gen_ai.input.messages": JSON.stringify([user, callSearch, searchResult]),
  });
  const tool = span("4000000000000042", "execute_tool search", {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "search",
    "gen_ai.tool.call.id": "call_search_2",
  });
  tool.parentSpanId = anchor.spanId;
  const [call] = groupSpans([anchor, tool]);

  const row = toRow(PROJECT, call);
  assert.equal(row.metric.toolsByName?.search.calls, 1); // the span call
  const last = row.event.payload!.messages.at(-1)!;
  assert.deepEqual(last, {
    role: "assistant",
    content: [{ type: "tool_call", id: "call_search_2", name: "search", arguments: {} }],
  });
});

/** `search` then `fetch`, with search's tool span under call 2: pydantic-ai's shape. */
function lateToolSpanTrace(): { call1: DecodedSpan; call2: DecodedSpan; lateTool: DecodedSpan } {
  const content = (step: (typeof STEPS)[number]) => ({
    ...chatAttrs,
    "gen_ai.input.messages": JSON.stringify(step.input),
    "gen_ai.output.messages": JSON.stringify(step.output),
  });
  const call1 = span("4000000000000051", "chat gpt-5.5", content(STEPS[0]), 1_000);
  const call2 = span("4000000000000052", "chat gpt-5.5", content(STEPS[1]), 2_000);
  const lateTool = span(
    "4000000000000053",
    "execute_tool search",
    {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search",
      "gen_ai.tool.call.id": "call_search",
    },
    2_500,
  );
  lateTool.parentSpanId = call2.spanId;
  return { call1, call2, lateTool };
}

test("produced scope: a tool span of an earlier call's id, under a later call, adds no call", async () => {
  const { call1, call2, lateTool } = lateToolSpanTrace();
  assert.deepEqual((await persistedCalls([call1, call2, lateTool])).totals, TRUTH);
});

test("produced scope: with no output captured, a tool span of a history id still counts", async () => {
  // No call of this emitter has output content, so no call counted `call_search`:
  // the tool span is its only record. The backfill counts this shape the same way.
  const { call1, call2, lateTool } = lateToolSpanTrace();
  for (const call of [call1, call2]) delete call.attributes["gen_ai.output.messages"];
  const row = (await persistedCalls([call1, call2, lateTool])).totals;
  assert.deepEqual(row, { search: 1 });
});

test("batch split: the producing call in an earlier batch, the tool span with the later call, adds no call", async () => {
  const { call1, call2, lateTool } = lateToolSpanTrace();
  const first = await persistedCalls([call1]);
  const second = await persistedCalls([call2, lateTool]);
  assert.deepEqual(first.totals, { search: 1 });
  assert.deepEqual(second.totals, { search: 0, fetch: 1 });
});

for (const shape of TOOL_COUNT_SHAPES) {
  test(`ingest shape: ${shape.name}`, async () => {
    const { totals } = await persistedCalls(shape.spans());
    assert.deepEqual(
      Object.fromEntries(Object.entries(totals).filter(([, n]) => n > 0)),
      shape.truth,
    );
  });
}

test("known limit: a span in an earlier batch than its producer counts twice, because the fix needs a cross-batch read", async () => {
  const { call1, lateTool } = lateToolSpanTrace();
  const owner = span(
    "4000000000000054",
    "chat gpt-5.5",
    { ...chatAttrs, "gen_ai.input.messages": JSON.stringify([user]) },
    500,
  );
  lateTool.parentSpanId = owner.spanId;
  const first = await persistedCalls([owner, lateTool]);
  const second = await persistedCalls([call1]);
  assert.equal(first.totals.search + second.totals.search, 2);
});

const positive = (totals: Record<string, number>) =>
  Object.fromEntries(Object.entries(totals).filter(([, n]) => n > 0));

const NO_OUTPUT_SHAPES: {
  name: string;
  spans: () => DecodedSpan[];
  truth: Record<string, number>;
}[] = [
  { name: "no output and no tool span", spans: () => aiSdkHistoryTrace(), truth: TRUTH },
  {
    name: "no output and tool spans no call owns",
    spans: () => aiSdkToolSpanTrace(),
    truth: TRUTH,
  },
  {
    name: "a later turn, with ids: the first call's history is an earlier trace's",
    spans: () => laterTurnTrace(true),
    truth: { fetch: 1 },
  },
  { name: "a later turn, with no ids", spans: () => laterTurnTrace(false), truth: { fetch: 1 } },
];

for (const shape of NO_OUTPUT_SHAPES) {
  test(`AI SDK with no output, in one batch: ${shape.name}: ingest gives the true count`, async () => {
    assert.deepEqual(positive((await persistedCalls(shape.spans())).totals), shape.truth);
  });
}

test("an owned tool span of a history id counts once, not again as a recovered call", async () => {
  const { call1, call2, lateTool } = lateToolSpanTrace();
  const call3 = span(
    "4000000000000055",
    "chat gpt-5.5",
    { ...chatAttrs, "gen_ai.input.messages": JSON.stringify(STEPS[2].input) },
    3_000,
  );
  for (const call of [call1, call2]) delete call.attributes["gen_ai.output.messages"];
  assert.deepEqual(positive((await persistedCalls([call1, call2, lateTool, call3])).totals), TRUTH);
});

test("a history id of a call with output in another batch stays presumed counted: no double count", async () => {
  // Out of order: call 2 (it produced `fetch`) is in another batch. The call just before
  // the one that first shows `fetch` has output, so `fetch` is not this emitter's blind spot.
  const content = (step: (typeof STEPS)[number]) => ({
    ...chatAttrs,
    "gen_ai.input.messages": JSON.stringify(step.input),
    "gen_ai.output.messages": JSON.stringify(step.output),
  });
  const call1 = span("4000000000000061", "chat gpt-5.5", content(STEPS[0]), 1_000);
  const call2 = span("4000000000000062", "chat gpt-5.5", content(STEPS[1]), 2_000);
  const call3 = span("4000000000000063", "chat gpt-5.5", content(STEPS[2]), 3_000);
  const first = await persistedCalls([call1, call3]);
  const second = await persistedCalls([call2]);
  assert.deepEqual(positive(first.totals), { search: 1 });
  assert.deepEqual(positive(second.totals), { fetch: 1 });
});

test("known limit: with no output, a batch's first call shows history from an earlier batch, so ingest does not count those calls until the backfill runs", async () => {
  const [root, step1, step2, step3] = aiSdkHistoryTrace();
  const batch1 = await persistedCalls([{ ...root }, step1]);
  const batch2 = await persistedCalls([{ ...root }, step2]);
  const batch3 = await persistedCalls([{ ...root }, step3]);
  assert.deepEqual(
    [batch1, batch2, batch3].map((b) => positive(b.totals)),
    [{}, {}, {}],
  );
});

test("AI SDK: response tool calls map to output messages", () => {
  const attrs = (): AttrMap => ({
    "ai.operationId": "ai.generateText.doGenerate",
    "ai.response.toolCalls": JSON.stringify([
      { toolCallType: "function", toolCallId: "c1", toolName: "search", args: '{"q":"a"}' },
      { toolCallId: "c2", toolName: "fetch", input: { url: "u" } },
    ]),
  });
  const on = [span("4000000000000052", "ai.generateText.doGenerate", attrs())];
  normalizeAiSdkSpans(on);
  assert.deepEqual(JSON.parse(on[0].attributes["gen_ai.output.messages"] as string), [
    {
      role: "assistant",
      parts: [
        { type: "tool_call", id: "c1", name: "search", arguments: '{"q":"a"}' },
        { type: "tool_call", id: "c2", name: "fetch", arguments: { url: "u" } },
      ],
    },
  ]);
});
