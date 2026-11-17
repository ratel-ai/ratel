import assert from "node:assert/strict";
import { test } from "node:test";
import { type PersistSpansDeps, persistDecodedSpans } from "./ingest-spans";
import { toCloudEvent, toRows } from "./reconstruct";
import type { AttrMap, AttrValue, DecodedEvent, DecodedSpan, GroupedCall } from "./types";

/**
 * RC-280: with `cloud-session-replay` on, a call's payload keeps its own reply
 * (`output`) and its request settings (`settings`), so the session chat shows
 * the last reply of a turn and the inspector shows the settings. Off, the
 * payload is exactly as before. A call without content never gets either.
 */

const START = Date.parse("2026-07-06T10:00:00Z");

function span(attributes: AttrMap, spanId = "anchor"): DecodedSpan {
  return {
    traceId: "trace-1",
    spanId,
    parentSpanId: null,
    name: "chat",
    kind: 3,
    startUnixMs: START,
    endUnixMs: START + 300,
    events: [],
    statusCode: 0,
    resourceAttributes: {},
    scopeName: null,
    attributes,
  };
}

function details(attributes: AttrMap): DecodedEvent {
  return { name: "gen_ai.client.inference.operation.details", timeUnixMs: START, attributes };
}

const usage: AttrMap = {
  "gen_ai.provider.name": "anthropic",
  "gen_ai.request.model": "claude-opus-5-5",
  "gen_ai.usage.input_tokens": 900,
  "gen_ai.usage.output_tokens": 40,
};

const settingsAttrs: AttrMap = {
  "gen_ai.request.temperature": 0.2,
  "gen_ai.request.top_p": 0.9,
  "gen_ai.request.top_k": 40,
  "gen_ai.request.max_tokens": 1024,
  "gen_ai.request.stop_sequences": ["END"],
  "gen_ai.request.seed": 7,
  "gen_ai.request.frequency_penalty": 0.1,
  "gen_ai.request.presence_penalty": 0.3,
  "gen_ai.request.choice.count": 1,
};

const input: AttrValue = [
  { role: "user", parts: [{ type: "text", content: "Book me a flight to Lisbon" }] },
];
const output: AttrValue = [
  {
    role: "assistant",
    parts: [
      { type: "text", content: "Searching flights." },
      { type: "tool_call", id: "c1", name: "search_flights", arguments: { to: "LIS" } },
    ],
  },
];

const expectedOutput = [
  {
    role: "assistant",
    content: [
      { type: "text", text: "Searching flights." },
      { type: "tool_call", id: "c1", name: "search_flights", arguments: { to: "LIS" } },
    ],
  },
];

const expectedSettings = {
  temperature: 0.2,
  top_p: 0.9,
  top_k: 40,
  max_tokens: 1024,
  stop: ["END"],
  seed: 7,
  frequency_penalty: 0.1,
  presence_penalty: 0.3,
  choice_count: 1,
};

/** Content on the span itself (SPAN_ONLY emitters, Mastra). */
function spanCall(extra: AttrMap = {}): GroupedCall {
  return {
    anchor: span({
      ...usage,
      ...settingsAttrs,
      "gen_ai.input.messages": input,
      "gen_ai.output.messages": output,
      ...extra,
    }),
    detailsEvent: null,
    toolSpans: [],
  };
}

/** Content on the SDK's inference-details event, settings on the span. */
function sdkEventCall(): GroupedCall {
  return {
    anchor: span({ ...usage, ...settingsAttrs }),
    detailsEvent: details({ "gen_ai.input.messages": input, "gen_ai.output.messages": output }),
    toolSpans: [],
  };
}

const ON = { captureReply: true };

test("an OTLP span with output and settings stores both", () => {
  const e = toCloudEvent(spanCall(), ON);
  assert.deepEqual(e.output, expectedOutput);
  assert.deepEqual(e.settings, expectedSettings);
});

test("an SDK details event with output stores it, with the span's settings", () => {
  const e = toCloudEvent(sdkEventCall(), ON);
  assert.deepEqual(e.output, expectedOutput);
  assert.deepEqual(e.settings, expectedSettings);
});

test("the settings may ride the details event", () => {
  const call: GroupedCall = {
    anchor: span(usage),
    detailsEvent: details({ "gen_ai.input.messages": input, "gen_ai.request.temperature": 0.5 }),
    toolSpans: [],
  };
  assert.deepEqual(toCloudEvent(call, ON).settings, { temperature: 0.5 });
});

test("without output and settings the payload is unchanged", () => {
  const call: GroupedCall = {
    anchor: span({ ...usage, "gen_ai.input.messages": input }),
    detailsEvent: null,
    toolSpans: [],
  };
  assert.deepEqual(toCloudEvent(call, ON), toCloudEvent(call));
  assert.equal("output" in toCloudEvent(call, ON), false);
  assert.equal("settings" in toCloudEvent(call, ON), false);
});

test("output excludes the tool calls ingest synthesizes from tool spans", () => {
  const call: GroupedCall = {
    anchor: span({ ...usage, "gen_ai.input.messages": input, "gen_ai.output.messages": output }),
    detailsEvent: null,
    toolSpans: [
      span(
        {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "other_tool",
          "gen_ai.tool.call.id": "c9",
        },
        "tool-1",
      ),
    ],
  };
  const e = toCloudEvent(call, ON);
  assert.deepEqual(e.output, expectedOutput);
  assert.equal(e.messages.length, 3); // input + output + the synthetic call
});

test("flag off: the stored payload is byte-for-byte as today", () => {
  const calls = [spanCall(), sdkEventCall()];
  const before = toRows("p1", calls).map((r) => JSON.stringify(r.event.payload));
  const off = toRows("p1", calls, { captureReply: false }).map((r) =>
    JSON.stringify(r.event.payload),
  );
  assert.deepEqual(off, before);
  for (const json of off) {
    assert.equal(json.includes('"output"'), false);
    assert.equal(json.includes('"settings"'), false);
  }
});

test("flag on: rows carry output and settings; metrics are unchanged", () => {
  const off = toRows("p1", [spanCall()]);
  const on = toRows("p1", [spanCall()], ON);
  const payload = on[0].event.payload as { output?: unknown; settings?: unknown };
  assert.deepEqual(payload.output, expectedOutput);
  assert.deepEqual(payload.settings, expectedSettings);
  assert.deepEqual(on[0].metric, { ...off[0].metric, eventTime: on[0].metric.eventTime });
});

test("privacy: a call with no content gets no output and no settings", () => {
  const call: GroupedCall = {
    anchor: span({ ...usage, ...settingsAttrs }),
    detailsEvent: null,
    toolSpans: [],
  };
  const e = toCloudEvent(call, ON);
  assert.equal("output" in e, false);
  assert.equal("settings" in e, false);
  const payload = toRows("p1", [call], ON)[0].event.payload as unknown as Record<string, unknown>;
  assert.equal("output" in payload, false);
  assert.equal("settings" in payload, false);
});

/* --- ingest wiring --------------------------------------------------------- */

async function persistedPayloads(sessionChatCapture?: PersistSpansDeps["sessionChatCapture"]) {
  const stored: unknown[] = [];
  const deps = {
    insertEventsWithMetrics: async (
      _projectId: string,
      rows: { event: { payload: unknown } }[],
    ) => {
      stored.push(...rows.map((r) => r.event.payload));
      return rows.length;
    },
    insertTraceEvents: async (_projectId: string, rows: unknown[]) => ({ accepted: rows.length }),
    insertOtelSpans: async (_projectId: string, rows: unknown[]) => ({ accepted: rows.length }),
    logError: () => {},
    captureFailure: () => {},
    ...(sessionChatCapture ? { sessionChatCapture } : {}),
  } as unknown as PersistSpansDeps;
  const result = await persistDecodedSpans(
    [spanCall().anchor],
    { projectId: "project-1", organization: null, endpoint: "/v1/traces" },
    deps,
  );
  assert.ok(result.ok);
  return stored as Record<string, unknown>[];
}

test("ingest with the flag on stores output and settings", async () => {
  const asked: string[] = [];
  const [payload] = await persistedPayloads(async (projectId) => {
    asked.push(projectId);
    return true;
  });
  assert.deepEqual(asked, ["project-1"]);
  assert.deepEqual(payload.output, expectedOutput);
  assert.deepEqual(payload.settings, expectedSettings);
});

test("ingest with the flag off or not wired stores today's payload", async () => {
  for (const payload of [
    ...(await persistedPayloads(async () => false)),
    ...(await persistedPayloads()),
  ]) {
    assert.equal("output" in payload, false);
    assert.equal("settings" in payload, false);
  }
});
