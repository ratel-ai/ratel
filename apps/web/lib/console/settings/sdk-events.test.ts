import assert from "node:assert/strict";
import { test } from "node:test";
import {
  droppedTotal,
  humanizeEventType,
  SDK_EVENT_LABELS,
  SDK_EVENT_LIST_LIMIT,
  type SdkEventsState,
  sdkEventLabel,
  sdkEventsHref,
  sdkEventTone,
  sourceStatusNote,
  summaryVerdict,
  toDropView,
  toRejectView,
  toSdkEventPayload,
  toSdkEventView,
  windowLabel,
} from "@/lib/console/settings/sdk-events";
import {
  RUNTIME_EVENTS_PAGE_SIZE,
  type RuntimeEventClientDropGroup,
  type RuntimeEventRejectRow,
  type RuntimeEventRow,
} from "@/lib/ingest/runtime-events/queries";

const ROOT = "/project/p1/settings/developer";
const TRACES = "/project/p1/traces";

function row(overrides: Partial<RuntimeEventRow> = {}): RuntimeEventRow {
  return {
    id: "00000000-0000-8000-8000-000000000001",
    eventId: "evt-1",
    type: "search",
    sourceId: "worker-1",
    sourceStatus: "active",
    sourceLastSeenAt: new Date("2026-10-18T11:00:00.000Z"),
    occurredAt: new Date("2026-10-18T10:00:00.000Z"),
    receivedAt: new Date("2026-10-18T10:00:01.000Z"),
    invocationId: null,
    traceId: null,
    spanId: null,
    toolId: null,
    skillId: null,
    query: null,
    origin: null,
    tookMs: null,
    errorMessage: null,
    topK: null,
    hitCount: null,
    server: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    payload: {},
    ...overrides,
  };
}

test("every known wire type has a plain label, none of them snake_case", () => {
  for (const [type, label] of Object.entries(SDK_EVENT_LABELS)) {
    assert.doesNotMatch(label, /_/, `${type} reads as "${label}"`);
    assert.match(label, /^[A-Z]/, "sentence case");
  }
  assert.equal(sdkEventLabel("invoke_error"), "Tool call failed");
  assert.equal(sdkEventLabel("events_dropped"), "Events dropped");
  assert.equal(sdkEventLabel("index_churn"), "Tool catalog changed");
});

test("a type a newer SDK sends still reads as words", () => {
  assert.equal(humanizeEventType("custom_metric"), "Custom metric");
  assert.equal(humanizeEventType("rerank.applied-v2"), "Rerank applied v2");
  assert.equal(humanizeEventType("__"), "Unknown event");
  assert.equal(sdkEventLabel("brand_new_thing"), "Brand new thing");
});

test("failures read red, lost events amber, the rest gray", () => {
  assert.equal(sdkEventTone("invoke_error"), "danger");
  assert.equal(sdkEventTone("gateway_error"), "danger");
  assert.equal(sdkEventTone("events_dropped"), "warning");
  assert.equal(sdkEventTone("auth_needs"), "warning");
  assert.equal(sdkEventTone("search"), "neutral");
});

test("the URL holds the view, the window and the filters, in a stable order", () => {
  const base: SdkEventsState = { tab: "events", range: "7d", type: "", sourceId: "" };
  assert.equal(sdkEventsHref(ROOT, base), ROOT, "the defaults leave the URL clean");
  assert.equal(
    sdkEventsHref(
      ROOT,
      { tab: "dropped", range: "30d", type: "invoke_error", sourceId: "worker 1" },
      "evt-9",
    ),
    `${ROOT}?tab=dropped&range=30d&type=invoke_error&source=worker+1&event=evt-9`,
  );
  assert.equal(windowLabel("24h"), "Last 24 hours");
  assert.equal(windowLabel("30d"), "Last 30 days");
});

test("an event names what it was about, by type", () => {
  const about = (overrides: Partial<RuntimeEventRow>) =>
    toSdkEventView(row(overrides), TRACES).subject;
  assert.equal(about({ type: "search", query: "open invoices" }), "open invoices");
  assert.equal(about({ type: "invoke_end", toolId: "list_invoices" }), "list_invoices");
  assert.equal(about({ type: "skill_invoke", skillId: "refund-policy" }), "refund-policy");
  assert.equal(
    about({ type: "upstream_invoke", server: "billing", toolId: "get_customer" }),
    "billing · get_customer",
  );
  assert.equal(about({ type: "auth_needs", payload: { upstream: "github" } }), "github");
  assert.equal(about({ type: "events_dropped", payload: { dropped_count: 12 } }), "12 not sent");
  assert.equal(about({ type: "events_dropped", payload: {} }), null);
  assert.equal(about({ type: "turn_start" }), null);
});

test("the view carries ISO times, the raw type, ids and the trace link", () => {
  const view = toSdkEventView(
    row({
      type: "invoke_error",
      toolId: "create_refund",
      errorMessage: "upstream returned 502",
      tookMs: 1200,
      traceId: "t/1",
      spanId: "s 1",
      invocationId: "inv-2",
      occurredAt: null,
      payload: { error: "upstream returned 502" },
    }),
    TRACES,
  );
  assert.equal(view.identifier, "evt-1");
  assert.equal(view.type, "invoke_error");
  assert.equal(view.label, "Tool call failed");
  assert.equal(view.tone, "danger");
  assert.equal(view.at, "2026-10-18T10:00:01.000Z", "no event time falls back to the receive time");
  assert.equal(view.traceHref, "/project/p1/traces/t%2F1?span=s%201");
  assert.deepEqual(view.ids, { event: "evt-1", invocation: "inv-2", trace: "t/1", span: "s 1" });
  assert.equal(
    toSdkEventView(row({ eventId: null }), TRACES).identifier,
    row().id,
    "no SDK id: the row id",
  );
});

test("list rows ship without payloads; one event's payload is read on its own", () => {
  const big = row({ payload: { blob: "x".repeat(40_000) } });
  const view = toSdkEventView(big, TRACES);
  assert.equal("payload" in view, false, "the list never carries a payload");
  assert.ok(JSON.stringify(view).length < 2_000);
  assert.deepEqual(toSdkEventPayload(row({ payload: { error: "502" } })), {
    identifier: "evt-1",
    json: JSON.stringify({ error: "502" }, null, 2),
  });
  assert.equal(
    toSdkEventPayload(big).json.length,
    JSON.stringify(big.payload, null, 2).length,
    "whole, not cut",
  );
  assert.equal(toSdkEventPayload(row({ eventId: null })).identifier, row().id);
});

test("the page's list size is the query's page", () => {
  assert.equal(SDK_EVENT_LIST_LIMIT, RUNTIME_EVENTS_PAGE_SIZE);
});

test("quiet sources say so; active ones need no word", () => {
  assert.equal(sourceStatusNote("active"), null);
  assert.equal(sourceStatusNote("stale"), "Quiet for 7 days");
  assert.equal(sourceStatusNote("dormant"), "Quiet for 30 days");
  assert.equal(sourceStatusNote("unknown"), "Not registered");
});

test("the summary sums the SDK's drop reports and says what was lost", () => {
  const drops: RuntimeEventClientDropGroup[] = [
    {
      sourceId: "a",
      reason: "queue_overflow",
      droppedCount: 40,
      windowCount: 2,
      lastDropAt: new Date(),
    },
    {
      sourceId: "b",
      reason: "flush_failed",
      droppedCount: 2,
      windowCount: 1,
      lastDropAt: new Date(),
    },
  ];
  assert.equal(droppedTotal(drops), 42);
  assert.equal(droppedTotal(null), null, "a failed read is not zero");

  assert.equal(summaryVerdict({ received: null, dropped: 0, rejected: 0, sources: 0 }), null);
  assert.equal(
    summaryVerdict({ received: 0, dropped: 0, rejected: 0, sources: 0 }),
    null,
    "nothing yet is the empty state's job",
  );
  assert.deepEqual(summaryVerdict({ received: 9, dropped: 0, rejected: 0, sources: 1 }), {
    tone: "success",
    text: "Every event in this window arrived.",
  });
  assert.deepEqual(summaryVerdict({ received: 9, dropped: 0, rejected: 1, sources: 1 }), {
    tone: "danger",
    text: "Ratel Cloud refused 1 event. Fix the reason it gives and send again.",
  });
  assert.deepEqual(summaryVerdict({ received: 9, dropped: 0, rejected: 3, sources: 1 }), {
    tone: "danger",
    text: "Ratel Cloud refused 3 events. Fix the reasons they give and send again.",
  });
  assert.deepEqual(summaryVerdict({ received: 9, dropped: 1, rejected: 0, sources: 1 }), {
    tone: "warning",
    text: "The SDK dropped 1 event before sending.",
  });
  assert.deepEqual(summaryVerdict({ received: 9, dropped: 1200, rejected: 2, sources: 1 }), {
    tone: "danger",
    text: "Ratel Cloud refused 2 events, and the SDK dropped 1,200 events before sending.",
  });
});

test("rejects and drop reports become plain rows, with ISO times", () => {
  const reject: RuntimeEventRejectRow = {
    id: "r1",
    eventId: "evt-bad",
    type: "search",
    reason: "query: required",
    sizeBytes: 321,
    sourceId: "worker-1",
    receivedAt: new Date("2026-10-18T10:00:00.000Z"),
  };
  assert.deepEqual(toRejectView(reject), {
    key: "r1",
    at: "2026-10-18T10:00:00.000Z",
    reason: "query: required",
    eventId: "evt-bad",
    label: "Tool search",
    type: "search",
    source: "worker-1",
    sizeBytes: 321,
  });
  assert.equal(toRejectView({ ...reject, type: null }).label, null);
  assert.deepEqual(
    toDropView({
      sourceId: null,
      reason: "queue_overflow",
      droppedCount: 5,
      windowCount: 2,
      lastDropAt: new Date("2026-10-18T09:00:00.000Z"),
    }),
    {
      key: ":queue_overflow",
      source: null,
      reason: "queue_overflow",
      dropped: 5,
      reports: 2,
      lastAt: "2026-10-18T09:00:00.000Z",
    },
  );
});
