import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { SdkEventPayloadBlock } from "@/components/console/settings/SdkEventPayloadBlock";
import {
  listedLabel,
  receivedHint,
  type SdkEventsData,
  SdkEventsView,
} from "@/components/console/settings/SdkEventsView";
import { UndeliveredEvents } from "@/components/console/settings/UndeliveredEvents";
import { type SdkEventView, toSdkEventView } from "@/lib/console/settings/sdk-events";
import { renderWithRouter } from "@/lib/console/settings/test-support";
import type { RuntimeEventRow } from "@/lib/ingest/runtime-events/queries";

const ROOT = "/project/p1/settings/developer";
const NOW = "2026-10-18T12:00:00.000Z";

function event(overrides: Partial<RuntimeEventRow>): SdkEventView {
  return toSdkEventView(
    {
      id: "00000000-0000-8000-8000-000000000001",
      eventId: "evt-1",
      type: "search",
      sourceId: "worker-1",
      sourceStatus: "active",
      sourceLastSeenAt: null,
      occurredAt: new Date("2026-10-18T11:55:00.000Z"),
      receivedAt: new Date("2026-10-18T11:55:01.000Z"),
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
    },
    "/project/p1/traces",
  );
}

function data(overrides: Partial<SdkEventsData> = {}): SdkEventsData {
  return {
    root: ROOT,
    projectId: "p1",
    setupHref: "/project/p1/settings/api-keys",
    state: { tab: "events", range: "7d", type: "", sourceId: "" },
    summary: { received: 1204, dropped: 0, rejected: 2, sources: 2 },
    events: [
      event({ type: "invoke_error", toolId: "create_refund", tookMs: 1200, errorMessage: "502" }),
      event({
        id: "00000000-0000-8000-8000-000000000002",
        eventId: "evt-2",
        type: "search",
        query: "open invoices",
        tookMs: 42,
      }),
    ],
    pinned: null,
    openPayload: null,
    rejects: [],
    drops: [],
    typeOptions: [{ value: "invoke_error", label: "Tool call failed" }],
    sourceOptions: [{ value: "worker-1", label: "worker-1" }],
    everReceived: true,
    now: NOW,
    ...overrides,
  };
}

function render(overrides: Partial<SdkEventsData> = {}, search = ""): string {
  return renderWithRouter(createElement(SdkEventsView, { data: data(overrides) }), {
    pathname: ROOT,
    search,
  });
}

test("the page answers first: received, dropped and rejected in the window", () => {
  const html = render();
  for (const label of ["Received", "Dropped", "Rejected"])
    assert.match(html, new RegExp(`<dt[^>]*>(<a[^>]*>)?${label}`));
  assert.match(html, />1,204</);
  assert.match(html, />Last 7 days, 2 sources active</);
  assert.match(
    html,
    /<a(?=[^>]*href="\/project\/p1\/settings\/developer\?tab=dropped")[^>]*>Rejected<\/a>/,
    "a count with something behind it opens it",
  );
  assert.match(html, /<nav aria-label="Time window"/);
  assert.match(
    html,
    /<a(?=[^>]*aria-current="true")(?=[^>]*href="\/project\/p1\/settings\/developer")[^>]*>7 days<\/a>/,
  );
  assert.match(
    html,
    /<a[^>]*href="\/project\/p1\/settings\/developer\?range=30d"[^>]*>30 days<\/a>/,
  );
});

test("refused events lead with one alert that points at what was lost", () => {
  const html = render();
  assert.match(html, /role="alert"/);
  assert.match(html, /Ratel Cloud refused 2 events\. Fix the reasons they give and send again\./);
  assert.match(
    html,
    /<a[^>]*href="\/project\/p1\/settings\/developer\?tab=dropped"[^>]*>See what was lost<\/a>/,
  );
  assert.doesNotMatch(
    render({ summary: { received: 4, dropped: 0, rejected: 0, sources: 1 } }),
    /role="alert"/,
  );
});

test("the list names events in words; the wire type waits in the panel", () => {
  const html = render();
  assert.match(html, /<caption[^>]*>SDK events<\/caption>/);
  assert.match(html, />Tool call failed</);
  assert.match(html, />Tool search</);
  assert.match(html, />open invoices</);
  assert.match(html, />2 events</);
  assert.doesNotMatch(html, />invoke_error</, "no raw snake_case type on the default view");
  assert.match(html, /<time[^>]*dateTime="2026-10-18T11:55:00.000Z"[^>]*>5m ago<\/time>/);
});

test("each empty list says why, with the way out", () => {
  const firstRun = render({
    events: [],
    everReceived: false,
    summary: { received: 0, dropped: 0, rejected: 0, sources: 0 },
  });
  assert.match(firstRun, />No SDK events yet</);
  assert.match(
    firstRun,
    /<a[^>]*href="\/project\/p1\/settings\/api-keys"[^>]*>Set up the SDK<\/a>/,
  );

  const filtered = render({
    events: [],
    state: { tab: "events", range: "7d", type: "invoke_error", sourceId: "" },
  });
  assert.match(filtered, />No events match</);
  assert.match(
    filtered,
    /<a[^>]*href="\/project\/p1\/settings\/developer"[^>]*>Clear filters<\/a>/,
  );

  const quiet = render({ events: [] });
  assert.match(quiet, />No SDK events in this window</);
  assert.match(
    quiet,
    /<a[^>]*href="\/project\/p1\/settings\/developer\?range=30d"[^>]*>Last 30 days<\/a>/,
  );
});

test("a failed read becomes a retry in its place; the rest of the page stays", () => {
  const listFailed = render({ events: null });
  assert.match(listFailed, /Couldn&#x27;t load SDK events/);
  assert.match(listFailed, />1,204</, "the counts still show");
  const countsFailed = render({ summary: { received: null, dropped: 0, rejected: 0, sources: 0 } });
  assert.match(countsFailed, /Couldn&#x27;t load the event counts/);
  assert.match(countsFailed, />Tool call failed</, "the list still shows");
});

test("the dropped view lists refusals with their reason and the SDK's drop reports", () => {
  const html = render({
    state: { tab: "dropped", range: "7d", type: "", sourceId: "" },
    events: [],
    rejects: [
      {
        key: "r1",
        at: "2026-10-18T11:58:00.000Z",
        reason: "query: required",
        eventId: "evt-x",
        label: "Tool search",
        type: "search",
        source: "worker-1",
        sizeBytes: 208,
      },
    ],
    drops: [
      {
        key: "worker-1:queue_overflow",
        source: "worker-1",
        reason: "queue_overflow",
        dropped: 12,
        reports: 1,
        lastAt: "2026-10-18T11:50:00.000Z",
      },
    ],
  });
  assert.match(html, /<caption[^>]*>Events Ratel Cloud rejected<\/caption>/);
  assert.match(html, />query: required</);
  assert.match(html, /<caption[^>]*>Events the SDK dropped before sending<\/caption>/);
  assert.match(html, />Queue overflow</, "a reason code reads as words");
  assert.match(html, /<a(?=[^>]*aria-current="true")[^>]*>Dropped and rejected<\/a>/);
});

test("nothing lost says so", () => {
  const html = renderWithRouter(
    createElement(UndeliveredEvents, { rejects: [], drops: [], now: NOW }),
  );
  assert.match(html, />Nothing dropped or rejected</);
});

test("the quiet lines under the numbers and above the list", () => {
  assert.equal(receivedHint("24h", 0), "Last 24 hours");
  assert.equal(receivedHint("30d", 1), "Last 30 days, 1 source active");
  assert.equal(listedLabel(1), "1 event");
  assert.equal(listedLabel(100), "Newest 100", "a full page says it shows the newest only");
});

test("a payload loads with the open event: lines, then the JSON, or a retry", () => {
  const retry = () => {};
  const loading = renderWithRouter(
    createElement(SdkEventPayloadBlock, { state: { status: "loading" }, onRetry: retry }),
  );
  assert.match(loading, /role="status"/);
  assert.match(loading, /aria-busy="true"/);
  const ready = renderWithRouter(
    createElement(SdkEventPayloadBlock, {
      state: { status: "ready", payload: { identifier: "evt-1", json: '{\n  "error": "502"\n}' } },
      onRetry: retry,
    }),
  );
  assert.match(ready, />Payload</);
  assert.match(ready, /&quot;error&quot;: &quot;502&quot;/);
  const failed = renderWithRouter(
    createElement(SdkEventPayloadBlock, {
      state: { status: "error", error: "This event is no longer stored." },
      onRetry: retry,
    }),
  );
  assert.match(failed, /role="alert"/);
  assert.match(failed, /This event is no longer stored\./);
  assert.match(failed, />Try again</);
});

test("a full page of refusals or drop groups says it is not everything", () => {
  const rejects = Array.from({ length: 100 }, (_, index) => ({
    key: `r${index}`,
    at: NOW,
    reason: "query: required",
    eventId: null,
    label: "Tool search",
    type: "search",
    source: "worker-1",
    sizeBytes: 10,
  }));
  const drops = Array.from({ length: 100 }, (_, index) => ({
    key: `d${index}`,
    source: `worker-${index}`,
    reason: "queue_overflow",
    dropped: 1,
    reports: 1,
    lastAt: NOW,
  }));
  const full = renderWithRouter(createElement(UndeliveredEvents, { rejects, drops, now: NOW }));
  assert.match(full, />The newest 100</);
  assert.match(full, />The 100 largest groups</);
  const few = renderWithRouter(
    createElement(UndeliveredEvents, {
      rejects: rejects.slice(0, 3),
      drops: drops.slice(0, 2),
      now: NOW,
    }),
  );
  assert.doesNotMatch(few, /The newest|largest groups/);
});
