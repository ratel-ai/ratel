import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contentHash,
  deterministicEventId,
  epochToDate,
  KNOWN_TRACE_EVENT_TYPES,
  MAX_EVENT_BYTES,
  MAX_HITS,
  parseTraceEvents,
  stableStringify,
} from "@/lib/ingest/trace-events/parse";

/** A well-formed envelope for a given event body. */
function ev(body: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return { v: 1, ts: 1_782_000_000_000, session_id: "sess-1", ...body, ...over };
}

/* — helpers ————————————————————————————————————————————————————————————————— */

test("epochToDate treats a large value as milliseconds", () => {
  const d = epochToDate(1_782_000_000_000);
  assert.equal(d.getTime(), 1_782_000_000_000);
});

test("epochToDate promotes a seconds-scale value to milliseconds", () => {
  const d = epochToDate(1_782_000_000); // epoch seconds
  assert.equal(d.getTime(), 1_782_000_000_000);
});

test("stableStringify is key-order independent", () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test("contentHash is stable across key order and distinct across content", () => {
  assert.equal(contentHash({ type: "x", a: 1, b: 2 }), contentHash({ b: 2, type: "x", a: 1 }));
  assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
});

test("deterministicEventId is a valid, stable, project-scoped uuid", () => {
  const id = deterministicEventId("proj-1", "key-1");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, deterministicEventId("proj-1", "key-1")); // stable
  assert.notEqual(id, deterministicEventId("proj-2", "key-1")); // project-scoped
  assert.notEqual(id, deterministicEventId("proj-1", "key-2")); // key-scoped
});

test("envelope v2 promotes stable source, invocation, and trace correlation ids", () => {
  const { valid, rejected } = parseTraceEvents([
    {
      v: 2,
      ts: 1_782_000_000_000,
      session_id: "sess-v2",
      event_id: "evt-1",
      source_id: "source-1",
      invocation_id: "invocation-1",
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      type: "future_event",
      future_field: true,
    },
  ]);

  assert.equal(rejected.length, 0);
  assert.deepEqual(
    {
      clientEventId: valid[0].clientEventId,
      eventId: valid[0].eventId,
      sourceId: valid[0].sourceId,
      invocationId: valid[0].invocationId,
      traceId: valid[0].traceId,
      spanId: valid[0].spanId,
      futureField: valid[0].payload.future_field,
    },
    {
      clientEventId: "evt-1",
      eventId: "evt-1",
      sourceId: "source-1",
      invocationId: "invocation-1",
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      futureField: true,
    },
  );
});

test("envelope v2 rejects missing stable event and source ids", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "future_event" }, { v: 2 }),
    ev({ type: "future_event", event_id: "evt-1" }, { v: 2 }),
  ]);

  assert.equal(valid.length, 0);
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].error, /event_id/);
  assert.match(rejected[1].error, /source_id/);
});

/* — validation + promotion ————————————————————————————————————————————————— */

test("search event promotes query/origin/top_k/hit_count and normalizes hits to tool targets", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({
      type: "search",
      query: "make a changelog",
      origin: "agent",
      top_k: 5,
      took_ms: 12,
      hits: [
        { tool_id: "changelog.generate", score: 0.9 },
        { tool_id: "git.log", score: 0.4 },
      ],
    }),
  ]);
  assert.equal(rejected.length, 0);
  const e = valid[0];
  assert.equal(e.type, "search");
  assert.equal(e.query, "make a changelog");
  assert.equal(e.origin, "agent");
  assert.equal(e.topK, 5);
  assert.equal(e.tookMs, 12);
  assert.equal(e.hitCount, 2);
  assert.deepEqual(e.hits, [
    { rank: 0, targetType: "tool", targetId: "changelog.generate", score: 0.9 },
    { rank: 1, targetType: "tool", targetId: "git.log", score: 0.4 },
  ]);
  // full fidelity preserved
  assert.equal((e.payload as { query: string }).query, "make a changelog");
});

test("a search's base_hits stay payload-only: the without-graph ranking is never a served hit", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({
      type: "search",
      query: "did the build pass",
      hits: [
        { tool_id: "gh_run_list", score: 0.9 },
        { tool_id: "docker_build", score: 0.4 },
      ],
      base_hits: [
        { tool_id: "docker_build", score: 0.6 },
        { tool_id: "gh_run_list", score: 0.5 },
      ],
    }),
  ]);
  assert.equal(rejected.length, 0);
  const e = valid[0];
  assert.equal(e.hitCount, 2);
  assert.deepEqual(
    e.hits.map((h) => h.targetId),
    ["gh_run_list", "docker_build"],
  );
  assert.deepEqual(
    (e.payload as { base_hits: Array<{ tool_id: string }> }).base_hits.map((h) => h.tool_id),
    ["docker_build", "gh_run_list"],
  );
  // Over the hit cap, or malformed, the comparison is dropped and the search
  // kept: base_hits rides on an event every shipped SDK sends.
  const bad = parseTraceEvents([
    ev({
      type: "search",
      query: "q",
      hits: [{ tool_id: "a" }],
      base_hits: Array.from({ length: 513 }, (_, i) => ({ tool_id: `t${i}` })),
    }),
    ev({ type: "search", query: "q", hits: [{ tool_id: "a" }], base_hits: [{ score: 0.5 }] }),
  ]);
  assert.equal(bad.rejected.length, 0);
  assert.equal(bad.valid.length, 2);
  for (const e of bad.valid) {
    assert.equal(e.hits.length, 1, "the served hit is kept");
    assert.equal("base_hits" in e.payload, false, "the rejected comparison is not stored either");
  }
});

test("skill_search normalizes hits to skill targets", () => {
  const { valid } = parseTraceEvents([
    ev({
      type: "skill_search",
      query: "changelog",
      hits: [{ skill_id: "write-changelog", score: 0.8 }],
    }),
  ]);
  assert.equal(valid[0].hits[0].targetType, "skill");
  assert.equal(valid[0].hits[0].targetId, "write-changelog");
  assert.equal(valid[0].hitCount, 1);
});

test("gateway_search takes hit_count from the bare count and produces no hit rows", () => {
  const { valid } = parseTraceEvents([ev({ type: "gateway_search", query: "q", hits: 7 })]);
  assert.equal(valid[0].hitCount, 7);
  assert.equal(valid[0].hits.length, 0);
});

test("skill_invoke promotes skill_id + took_ms", () => {
  const { valid } = parseTraceEvents([
    ev({ type: "skill_invoke", skill_id: "write-changelog", took_ms: 3 }),
  ]);
  assert.equal(valid[0].skillId, "write-changelog");
  assert.equal(valid[0].tookMs, 3);
});

test("invoke_error promotes tool_id + error_message", () => {
  const { valid } = parseTraceEvents([
    ev({ type: "invoke_error", tool_id: "git.push", took_ms: 9, error: "auth failed" }),
  ]);
  assert.equal(valid[0].toolId, "git.push");
  assert.equal(valid[0].errorMessage, "auth failed");
});

test("upstream_error promotes server + tool_id + error_message", () => {
  const { valid } = parseTraceEvents([
    ev({ type: "upstream_error", server: "github", tool_id: "gh.pr", error: "429" }),
  ]);
  assert.equal(valid[0].server, "github");
  assert.equal(valid[0].toolId, "gh.pr");
  assert.equal(valid[0].errorMessage, "429");
});

test("unrecognized type is accepted payload-only (forward-compat), not rejected", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "quantum_teleport", widget: "x", session_id: "s" }),
  ]);
  assert.equal(rejected.length, 0);
  assert.equal(valid[0].type, "quantum_teleport");
  assert.equal(valid[0].toolId, null);
  assert.equal(valid[0].skillId, null);
  assert.equal((valid[0].payload as { widget: string }).widget, "x");
});

test("a KNOWN type that fails its schema is rejected with its batch index", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "skill_invoke", skill_id: "ok" }),
    ev({ type: "search" }), // missing required `query`
  ]);
  assert.equal(valid.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].index, 1);
  assert.match(rejected[0].error, /query/);
});

test("missing envelope fields are rejected", () => {
  const noSession = parseTraceEvents([{ v: 1, ts: 1, type: "skill_invoke", skill_id: "x" }]);
  assert.equal(noSession.rejected.length, 1);
  const noType = parseTraceEvents([{ v: 1, ts: 1, session_id: "s" }]);
  assert.equal(noType.rejected.length, 1);
});

test("non-object items are rejected, not thrown on", () => {
  const { valid, rejected } = parseTraceEvents([null, 42, "nope"]);
  assert.equal(valid.length, 0);
  assert.equal(rejected.length, 3);
});

test("client_event_id is used verbatim when present; a content hash is derived otherwise", () => {
  const withId = parseTraceEvents([
    ev({ type: "skill_invoke", skill_id: "x", client_event_id: "abc" }),
  ]);
  assert.equal(withId.valid[0].clientEventId, "abc");

  const raw = ev({ type: "skill_invoke", skill_id: "x" });
  const without = parseTraceEvents([raw]);
  assert.equal(without.valid[0].clientEventId, contentHash(raw));
});

test("client_event_id admits a max-length session_id plus the SDK's :seq / :uuid suffix", () => {
  // The SDK exporter derives client_event_id = `${session_id}:${seq | uuid}`, so
  // its bound must exceed session_id's — a 512-char session_id is valid and must
  // not get its events rejected by the derived id.
  const session = "s".repeat(512);
  const withSeq = parseTraceEvents([
    ev(
      { type: "skill_invoke", skill_id: "x", client_event_id: `${session}:${"9".repeat(20)}` },
      { session_id: session },
    ),
  ]);
  assert.equal(withSeq.rejected.length, 0);
  assert.equal(withSeq.valid[0].clientEventId, `${session}:${"9".repeat(20)}`);

  const uuid = "0f9b2c3d-4e5a-6789-abcd-ef0123456789";
  const withUuid = parseTraceEvents([
    ev(
      { type: "skill_invoke", skill_id: "x", client_event_id: `${session}:${uuid}` },
      { session_id: session },
    ),
  ]);
  assert.equal(withUuid.rejected.length, 0);

  const oversized = parseTraceEvents([
    ev(
      { type: "skill_invoke", skill_id: "x", client_event_id: `${session}:${uuid}x` },
      { session_id: session },
    ),
  ]);
  assert.equal(oversized.rejected.length, 1);
});

test("occurred_at override wins over ts; otherwise ts drives occurred_at", () => {
  const override = parseTraceEvents([
    ev({ type: "skill_invoke", skill_id: "x", occurred_at: "2026-01-02T03:04:05Z" }),
  ]);
  assert.equal(override.valid[0].occurredAt.toISOString(), "2026-01-02T03:04:05.000Z");

  const fromTs = parseTraceEvents([
    ev({ type: "skill_invoke", skill_id: "x", ts: 1_782_000_000_000 }),
  ]);
  assert.equal(fromTs.valid[0].occurredAt.getTime(), 1_782_000_000_000);
});

test("forward-compat metric fields are promoted when present", () => {
  const { valid } = parseTraceEvents([
    ev({
      type: "gateway_invoke",
      tool_id: "t",
      catalog_version: "v7",
      correlation_id: "corr-1",
      input_tokens: 100,
      output_tokens: 20,
      cost_usd: 0.0031,
      harness: "claude-code",
      environment: "ci",
    }),
  ]);
  const e = valid[0];
  assert.equal(e.catalogVersion, "v7");
  assert.equal(e.correlationId, "corr-1");
  assert.equal(e.inputTokens, 100);
  assert.equal(e.outputTokens, 20);
  assert.equal(e.costUsd, 0.0031);
  assert.equal(e.harness, "claude-code");
  assert.equal(e.environment, "ci");
});

test("end_user_id is promoted on a known type AND on the unknown-type fallback", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "search", query: "q", end_user_id: "u-ada", hits: [] }),
    ev({ type: "some_future_variant", end_user_id: "u-bob" }),
  ]);
  assert.equal(rejected.length, 0);
  assert.equal(valid[0].endUserId, "u-ada");
  assert.equal(valid[1].endUserId, "u-bob");
});

test("an absent end_user_id maps to null", () => {
  const { valid } = parseTraceEvents([ev({ type: "search", query: "q", hits: [] })]);
  assert.equal(valid[0].endUserId, null);
});

test("an empty-string end_user_id folds to null (never aliases the global dedup sentinel)", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "search", query: "q", end_user_id: "", hits: [] }),
  ]);
  assert.equal(rejected.length, 0);
  assert.equal(valid[0].endUserId, null);
});

test("an oversized end_user_id rejects that item only, not the batch", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "search", query: "ok", hits: [] }),
    ev({ type: "search", query: "bad", end_user_id: "u".repeat(600), hits: [] }),
  ]);
  assert.equal(valid.length, 1);
  assert.deepEqual(
    rejected.map((r) => r.index),
    [1],
  );
});

test("a mixed batch keeps valid events and reports every rejection with the right index", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "search", query: "a", hits: [{ tool_id: "t1" }] }), // 0 ok
    ev({ type: "invoke_error", tool_id: "t2" }), // 1 rejected (no error)
    ev({ type: "skill_invoke", skill_id: "s1" }), // 2 ok
    { garbage: true }, // 3 rejected
  ]);
  assert.equal(valid.length, 2);
  assert.deepEqual(rejected.map((r) => r.index).sort(), [1, 3]);
});

test("the promoted type set is exactly the SDK TraceEvent union (snake_case tags)", () => {
  // The full tag set from ratel core trace/event.rs — a rename/typo in
  // KNOWN_SCHEMAS that preserves the count would fail this — plus the runtime
  // publisher's client-drop marker (`events_dropped`, first-class per the ADR).
  const EXPECTED = [
    "search",
    "skill_search",
    "gateway_search",
    "turn_start",
    "skill_invoke",
    "skill_churn",
    "index_churn",
    "invoke_start",
    "invoke_end",
    "invoke_error",
    "gateway_invoke",
    "gateway_error",
    "upstream_register",
    "upstream_invoke",
    "upstream_error",
    "auth_refresh",
    "auth_needs",
    "auth_flow_start",
    "auth_flow_end",
    "events_dropped",
    "usage_boost",
    "usage_model_mismatch",
    "usage_cluster_policy_changed",
    "usage_ranking_status",
  ];
  assert.deepEqual([...KNOWN_TRACE_EVENT_TYPES].sort(), [...EXPECTED].sort());
});

test("turn_start keeps the turn id and the user's message in the payload", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "turn_start", turn_id: "t1", user_message: "plan my trip" }),
    ev({ type: "turn_start", turn_id: "t2" }),
    ev({ type: "turn_start" }),
  ]);
  assert.equal(valid.length, 2);
  assert.equal(valid[0]!.payload.user_message, "plan my trip");
  assert.equal(valid[1]!.payload.turn_id, "t2");
  assert.equal(rejected.length, 1, "a turn_start without its turn id is rejected");
});

test("events_dropped is typed: valid fields store, garbage rejects per item", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({
      type: "events_dropped",
      dropped_count: 17,
      reason: "queue_overflow",
      window_start_ts: 1_782_000_000_000,
      window_end_ts: 1_782_000_030_000,
    }),
    ev({ type: "events_dropped", dropped_count: -1, reason: "queue_overflow" }),
    ev({ type: "events_dropped", reason: "queue_overflow" }),
  ]);

  assert.equal(valid.length, 1);
  assert.equal(valid[0].type, "events_dropped");
  assert.equal(valid[0].payload.dropped_count, 17);
  assert.equal(valid[0].payload.window_start_ts, 1_782_000_000_000);
  assert.deepEqual(
    rejected.map((r) => r.index),
    [1, 2],
  );
  assert.match(rejected[0].error, /dropped_count/);
  assert.match(rejected[1].error, /dropped_count/);
});

/* — bounds (batch-isolation + abuse resistance) ———————————————————————————— */

test("promoted integers outside the int4 domain reject that item, not the batch", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "invoke_start", tool_id: "ok.tool" }),
    ev({ type: "invoke_start", tool_id: "big.tokens", input_tokens: 3_000_000_000 }),
    ev({ type: "invoke_start", tool_id: "big.out", output_tokens: 2 ** 31 }),
    ev({ type: "invoke_start", tool_id: "neg.tokens", input_tokens: -1 }),
    ev({ type: "search", query: "q", top_k: 2 ** 31 }),
    ev({ type: "gateway_search", query: "q", hits: 2 ** 31 }),
    ev({ type: "invoke_end", tool_id: "slow.tool", took_ms: 2 ** 31 }),
    ev({
      type: "invoke_start",
      tool_id: "big.v",
      v: 2 ** 31,
      event_id: "evt-v",
      source_id: "src-v",
    }),
  ]);

  assert.equal(valid.length, 1);
  assert.equal(valid[0].toolId, "ok.tool");
  assert.deepEqual(
    rejected.map((r) => r.index),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.match(rejected[0].error, /input_tokens/);
  assert.match(rejected[1].error, /output_tokens/);
  assert.match(rejected[2].error, /input_tokens/);
  assert.match(rejected[3].error, /top_k/);
  assert.match(rejected[4].error, /hits/);
  assert.match(rejected[5].error, /took_ms/);
  assert.match(rejected[6].error, /(^|; )v:/);
});

test("cost_usd outside the numeric(12,6) domain rejects that item, not the batch", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "invoke_start", tool_id: "ok.tool", cost_usd: 0.25 }),
    ev({ type: "invoke_start", tool_id: "big.cost", cost_usd: 1_000_000 }),
    ev({ type: "invoke_start", tool_id: "neg.cost", cost_usd: -1 }),
  ]);

  assert.equal(valid.length, 1);
  assert.equal(valid[0].costUsd, 0.25);
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].error, /cost_usd/);
  assert.match(rejected[1].error, /cost_usd/);
});

test("a fractional took_ms is rounded to fit the integer column", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "invoke_end", tool_id: "t", took_ms: 12.7 }),
  ]);

  assert.equal(rejected.length, 0);
  assert.equal(valid[0].tookMs, 13);
});

test("an out-of-range ts is rejected as one item and never sinks the batch", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "skill_invoke", skill_id: "ok" }), // 0 valid
    ev({ type: "skill_invoke", skill_id: "ns", ts: 1.78e18 }), // 1 nanosecond ts → out of range
    ev({ type: "skill_invoke", skill_id: "huge", ts: 8.65e15 }), // 2 beyond JS Date max
  ]);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].skillId, "ok");
  assert.deepEqual(rejected.map((r) => r.index).sort(), [1, 2]);
  // Every surviving event has a representable occurred_at (no Invalid Date reaches insert).
  assert.equal(Number.isNaN(valid[0].occurredAt.getTime()), false);
});

test("an event exceeding the byte cap is rejected", () => {
  const big = "x".repeat(MAX_EVENT_BYTES); // query alone pushes the event over the cap
  const { valid, rejected } = parseTraceEvents([ev({ type: "search", query: big })]);
  assert.equal(valid.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].error, /bytes/);
});

test("a search with more than MAX_HITS hits is rejected", () => {
  const hits = Array.from({ length: MAX_HITS + 1 }, (_, i) => ({ skill_id: `s${i}` }));
  const { valid, rejected } = parseTraceEvents([ev({ type: "skill_search", query: "q", hits })]);
  assert.equal(valid.length, 0);
  assert.equal(rejected.length, 1);
});

/* — turn_id and the adaptive-ranking events —————————————————————————————————— */

test("turn_id is promoted on search and invoke_start and kept in the payload", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "search", query: "q", turn_id: "turn-abc", hits: [] }),
    ev({ type: "invoke_start", tool_id: "t", turn_id: "turn-abc" }),
    ev({ type: "search", query: "q2", hits: [] }),
  ]);
  assert.equal(rejected.length, 0);
  assert.equal(valid[0].turnId, "turn-abc");
  assert.equal(valid[0].payload.turn_id, "turn-abc");
  assert.equal(valid[1].turnId, "turn-abc");
  assert.equal(valid[2].turnId, null);
});

test("an empty, oversized or non-string turn_id loses the pairing, not the event, and is not stored", () => {
  // Main did not know the field and kept these events; a value a host passed
  // through unset must not start dropping its searches.
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "search", query: "q", turn_id: "", hits: [{ tool_id: "a" }] }),
    ev({ type: "search", query: "q", turn_id: "x".repeat(600), hits: [] }),
    ev({ type: "invoke_start", tool_id: "t", turn_id: 42 }),
    ev({ type: "search", query: "ok", turn_id: "t1", hits: [] }),
  ]);
  assert.equal(rejected.length, 0);
  assert.equal(valid.length, 4);
  for (const e of valid.slice(0, 3)) {
    assert.equal(e.turnId, null);
    assert.equal(
      "turn_id" in e.payload,
      false,
      "the reader's payload fallback cannot see the bad value",
    );
  }
  assert.equal(valid[0].hits.length, 1);
  assert.equal(valid[3].turnId, "t1");
  assert.equal(valid[3].payload.turn_id, "t1", "a valid one stays in the payload");
});

test("the four adaptive-ranking events are known, validated, and stored payload-only", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({
      type: "usage_boost",
      intent: "intent_18",
      similarity: 0.67,
      support: 41,
      promoted: 2,
      dropped: 0,
      extra: true,
    }),
    ev({ type: "usage_boost", intent: null, similarity: 0, support: 0, promoted: 0 }),
    ev({
      type: "usage_model_mismatch",
      built: "bge-small",
      active: "bge-base",
      dim_mismatch: true,
    }),
    ev({
      type: "usage_cluster_policy_changed",
      built_similarity: 0.7,
      built_coverage: 0.5,
      active_similarity: 0.9,
      active_coverage: 0.5,
    }),
    ev({
      type: "usage_ranking_status",
      status: "active",
      reason: "enabled",
      rev: 214,
      graph_key: "cloud",
      learn: false,
    }),
    ev({ type: "usage_ranking_status", status: "inactive", reason: "disabled" }),
  ]);
  assert.equal(rejected.length, 0);
  assert.equal(valid.length, 6);
  assert.equal(valid[0].payload.extra, true, "unknown fields ride along in the payload");
  assert.equal(valid[0].toolId, null, "nothing is promoted beyond the envelope");
  assert.equal(valid[1].payload.intent, null);
  assert.equal(valid[4].payload.learn, false);
  assert.equal(
    valid[5].payload.learn,
    undefined,
    "the default applies at read time, not on the wire",
  );
  for (const t of [
    "usage_boost",
    "usage_model_mismatch",
    "usage_cluster_policy_changed",
    "usage_ranking_status",
  ]) {
    assert.ok((KNOWN_TRACE_EVENT_TYPES as string[]).includes(t), t);
  }
});

test("a malformed adaptive-ranking event is rejected as one item: only the co-developed SDK sends these, and the reject is the signal", () => {
  const { valid, rejected } = parseTraceEvents([
    ev({ type: "usage_boost", intent: "i", similarity: "high", support: 1, promoted: 1 }),
    ev({ type: "usage_ranking_status", reason: "enabled" }),
    ev({ type: "usage_model_mismatch", built: "a", active: "b", dim_mismatch: "yes" }),
    ev({ type: "search", query: "ok", hits: [] }),
  ]);
  assert.equal(valid.length, 1);
  assert.equal(rejected.length, 3);
  assert.match(rejected[0].error, /similarity/);
  assert.match(rejected[1].error, /status/);
  assert.match(rejected[2].error, /dim_mismatch/);
  const fractional = parseTraceEvents([
    ev({ type: "usage_boost", intent: "i", similarity: 0.5, support: 1.5, promoted: 1 }),
  ]);
  assert.match(fractional.rejected[0]!.error, /support/);
  const noReason = parseTraceEvents([ev({ type: "usage_ranking_status", status: "active" })]);
  assert.match(noReason.rejected[0]!.error, /reason/);
});
