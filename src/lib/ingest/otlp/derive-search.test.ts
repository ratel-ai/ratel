import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import { deriveGatewaySearches, deriveRatelSearches } from "./derive-search";
import type { AttrMap, DecodedSpan } from "./types";

const ev = (messages: CloudEvent["messages"]): CloudEvent =>
  ({ provider: "otel", model: "gpt-5.5", messages }) as unknown as CloudEvent;

const opts = {
  dedupeHash: "abc123",
  occurredAt: new Date("2026-07-08T00:00:00Z"),
  endUserId: null,
  sourceId: "gateway-worker",
};

test("derives a gateway_search per search_capabilities call, carrying the query", () => {
  const out = deriveGatewaySearches(
    ev([
      { role: "user", content: "find linear issues" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "s1",
            name: "search_capabilities",
            arguments: { query: "linear issue by id" },
          },
          {
            type: "tool_call",
            id: "i1",
            name: "invoke_tool",
            arguments: { toolId: "linear__get_issue", args: {} },
          },
          {
            type: "tool_call",
            id: "s2",
            name: "search_tools",
            arguments: { query: "create a page in notion" },
          },
        ],
      },
    ]),
    opts,
  );
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((e) => e.query),
    ["linear issue by id", "create a page in notion"],
  );
  assert.ok(out.every((e) => e.type === "gateway_search"));
  assert.ok(out.every((e) => e.ingestSource === "otlp"));
  assert.ok(out.every((e) => e.sourceId === "gateway-worker"));
  // Ordinals count search calls only (the interleaved invoke_tool is ignored), so
  // the ids stay stable across re-ingestion of the same event.
  assert.deepEqual(
    out.map((e) => e.clientEventId),
    ["otlp:abc123:gwsearch:0", "otlp:abc123:gwsearch:1"],
  );
});

test("skips search calls with no captured query (content capture off), keeping ordinals stable", () => {
  const out = deriveGatewaySearches(
    ev([
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "s1", name: "search_capabilities", arguments: {} },
          {
            type: "tool_call",
            id: "s2",
            name: "search_capabilities",
            arguments: { query: "real query" },
          },
        ],
      },
    ]),
    opts,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].query, "real query");
  // The empty first call still consumed ordinal 0, so the kept one is 1 — stable
  // across re-ingestion regardless of which calls carried a query.
  assert.equal(out[0].clientEventId, "otlp:abc123:gwsearch:1");
});

test("no search calls → nothing derived (direct tool use, string content)", () => {
  const out = deriveGatewaySearches(
    ev([
      { role: "user", content: "hi" },
      { role: "assistant", content: "just text, no tools" },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "x", name: "get_weather", arguments: { city: "Paris" } },
        ],
      },
    ]),
    opts,
  );
  assert.deepEqual(out, []);
});

/* --- ratel.search spans (the SDK funnel) --------------------------------------- */

const SPAN_START = Date.parse("2026-07-08T00:00:00Z");

function ratelSpan(attributes: AttrMap, p: Partial<DecodedSpan> = {}): DecodedSpan {
  return {
    traceId: "trace-1",
    spanId: "s1",
    parentSpanId: null,
    name: "ratel.search",
    kind: 1,
    startUnixMs: SPAN_START,
    endUnixMs: SPAN_START + 12,
    attributes,
    events: [],
    statusCode: 0,
    resourceAttributes: {},
    scopeName: "@ratel-ai/sdk",
    ...p,
  };
}

test("derives a native search row from a ratel.search span carrying a query", () => {
  const out = deriveRatelSearches([
    ratelSpan({
      "ratel.search.query": "create a page in notion",
      "ratel.search.target": "tool",
      "ratel.search.top_k": 8,
      "ratel.search.hit_count": 3,
      "ratel.origin": "agent",
    }),
  ]);
  assert.equal(out.length, 1);
  const e = out[0];
  assert.equal(e.type, "search");
  assert.equal(e.query, "create a page in notion");
  assert.equal(e.topK, 8);
  assert.equal(e.hitCount, 3);
  assert.equal(e.origin, "agent");
  assert.equal(e.tookMs, 12);
  assert.equal(e.sessionId, "trace-1");
  assert.equal(e.clientEventId, "otlp:span:trace-1:s1");
  assert.equal(e.occurredAt.getTime(), SPAN_START);
  assert.deepEqual(e.hits, []);
});

test("OTLP search derivation preserves source and ratel.event.id correlation", () => {
  const [event] = deriveRatelSearches([
    ratelSpan(
      {
        "ratel.event.id": "evt-search",
        "ratel.search.query": "linked query",
      },
      { resourceAttributes: { "service.name": "worker-a" } },
    ),
  ]);

  assert.equal(event.ingestSource, "otlp");
  assert.equal(event.clientEventId, "evt-search");
  assert.equal(event.eventId, "evt-search");
  assert.equal(event.sourceId, "worker-a");
  assert.equal(event.traceId, "trace-1");
  assert.equal(event.spanId, "s1");
});

test("target=skill → skill_search; missing/unknown target → search", () => {
  const out = deriveRatelSearches([
    ratelSpan({ "ratel.search.query": "q1", "ratel.search.target": "skill" }, { spanId: "a" }),
    ratelSpan({ "ratel.search.query": "q2" }, { spanId: "b" }),
    ratelSpan({ "ratel.search.query": "q3", "ratel.search.target": "wat" }, { spanId: "c" }),
  ]);
  assert.deepEqual(
    out.map((e) => e.type),
    ["skill_search", "search", "search"],
  );
});

test("spans without a captured query become search_uncaptured marker rows; other spans are ignored", () => {
  const out = deriveRatelSearches([
    ratelSpan({ "ratel.search.target": "tool", "ratel.search.hit_count": 5 }), // capture off
    ratelSpan({ "ratel.search.query": "   " }, { spanId: "blank" }), // whitespace-only
    ratelSpan({ "ratel.search.query": "real" }, { spanId: "kept", name: "ratel.skill.load" }), // not a search span
    ratelSpan({ "gen_ai.tool.name": "x" }, { spanId: "tool", name: "execute_tool" }),
  ]);
  // The two query-less ratel.search spans persist as markers (the "SDK searching
  // with capture off" signal); the non-search spans derive nothing.
  assert.deepEqual(
    out.map((e) => e.type),
    ["search_uncaptured", "search_uncaptured"],
  );
  assert.deepEqual(
    out.map((e) => e.query),
    [null, null],
  );
  assert.equal(out[0].hitCount, 5);
  assert.equal(out[0].payload.reason, "content_capture_off");
});

test("id-less spans are skipped (their deterministic ids would all collide)", () => {
  const out = deriveRatelSearches([
    ratelSpan({ "ratel.search.query": "q1" }, { spanId: "" }),
    ratelSpan({ "ratel.search.query": "q2" }, { spanId: "" }),
  ]);
  assert.deepEqual(out, []);
});

test("a broken span clock buckets by receipt time and voids the duration", () => {
  const out = deriveRatelSearches([
    ratelSpan({ "ratel.search.query": "q" }, { startUnixMs: 0, endUnixMs: 5 }),
  ]);
  assert.equal(out.length, 1);
  assert.ok(out[0].occurredAt.getTime() > Date.parse("2026-01-01T00:00:00Z"));
  // startUnixMs 0 is the broken-clock case — end minus start (~1.75e12) would
  // overflow the int4 took_ms column and abort the whole batch insert.
  assert.equal(out[0].tookMs, null);
});

test("out-of-range or non-integer numeric attributes are clamped, never inserted raw", () => {
  const out = deriveRatelSearches([
    ratelSpan(
      {
        "ratel.search.query": "q",
        "ratel.search.top_k": 8.7, // doubleValue → truncated
        "ratel.search.hit_count": 3_000_000_000, // > int4 max → dropped
      },
      { spanId: "n1" },
    ),
    ratelSpan(
      {
        "ratel.search.query": "q2",
        "ratel.search.top_k": -2,
        "ratel.search.hit_count": Number.NaN,
      },
      { spanId: "n2" },
    ),
  ]);
  assert.equal(out[0].topK, 8);
  assert.equal(out[0].hitCount, null);
  assert.equal(out[1].topK, null);
  assert.equal(out[1].hitCount, null);
});
