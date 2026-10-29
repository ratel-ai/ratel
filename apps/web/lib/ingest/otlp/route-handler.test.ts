import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync, gzipSync } from "node:zlib";
import protobuf from "protobufjs";
import type { EventWithMetric } from "@/lib/ingest/otlp/queries";
import { chunkedCountingBody } from "@/lib/platform/http/test-support";
import type { ApiKey } from "@/lib/platform/projects/schema";
import descriptor from "./proto/otlp-trace.descriptor.json";
import {
  handleTracesRequest,
  inflateBody,
  MAX_BODY_BYTES,
  MAX_INFLATED_BYTES,
  MAX_SPANS,
  type TracesHandlerDeps,
} from "./route-handler";

/**
 * Route-contract tests with all dependencies injected — Bearer auth, content-type
 * negotiation, size caps, decode failures, and the 202 { accepted, calls, spans }
 * envelope, without a database. Mirrors the chats/events route tests.
 */

const FAKE_KEY: ApiKey = {
  id: "key-1",
  projectId: "proj-1",
  name: "test",
  keyHash: "hash",
  keyPrefix: "rtl_abc",
  createdAt: new Date(),
  lastUsedAt: null,
  revokedAt: null,
  expiresAt: null,
};

const protoRoot = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);
const ProtoRequestType = protoRoot.lookupType("ratel.otlp.ExportTraceServiceRequest");

function makeDeps(over: Partial<TracesHandlerDeps> = {}): {
  deps: TracesHandlerDeps;
  inserted: EventWithMetric[][];
  derived: unknown[][];
  storedSpans: Array<Array<{ projectId: string; spanId: string }>>;
} {
  const inserted: EventWithMetric[][] = [];
  const derived: unknown[][] = [];
  const storedSpans: Array<Array<{ projectId: string; spanId: string }>> = [];
  const deps: TracesHandlerDeps = {
    isDbConfigured: () => true,
    hashApiKey: (s) => `hashed:${s}`,
    findActiveApiKeyByHash: async () => FAKE_KEY,
    touchApiKey: async () => {},
    insertEventsWithMetrics: async (_projectId, rows) => {
      inserted.push(rows);
      return rows.length;
    },
    insertTraceEvents: async (_projectId, events) => {
      derived.push(events);
      return { accepted: events.length };
    },
    insertOtelSpans: async (_projectId, spans) => {
      storedSpans.push(spans);
      return { accepted: spans.length };
    },
    // Rejections are sampled in production; default the gate open so rejection-path
    // tests emit deterministically (the sampler itself is covered in
    // ingest-observability.test.ts). Individual tests can still override.
    shouldSampleRejection: () => true,
    logError: () => {},
    logWarn: () => {},
    ...over,
  };
  return { deps, inserted, derived, storedSpans };
}

/** Build an OTLP/JSON export with `n` gen_ai anchor spans (hex ids, ms→ns times). */
function otlpJson(n = 1): string {
  const START_NS = "1751800000000000000";
  const END_NS = "1751800000200000000";
  const spans = Array.from({ length: n }, (_, i) => ({
    traceId: (i + 1).toString(16).padStart(32, "0"),
    spanId: (i + 1).toString(16).padStart(16, "0"),
    name: "chat gpt-5.5",
    kind: 3,
    startTimeUnixNano: START_NS,
    endTimeUnixNano: END_NS,
    attributes: [
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
      { key: "gen_ai.request.model", value: { stringValue: "gpt-5.5" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: "1000" } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: "200" } },
    ],
  }));
  return JSON.stringify({
    resourceSpans: [
      { resource: { attributes: [] }, scopeSpans: [{ scope: { name: "ratel" }, spans }] },
    ],
  });
}

function otlpProto(n = 1): Uint8Array {
  const payload = JSON.parse(otlpJson(n)) as {
    resourceSpans: Array<{
      scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
    }>;
  };
  for (const resource of payload.resourceSpans) {
    for (const scope of resource.scopeSpans) {
      for (const span of scope.spans) {
        span.traceId = Buffer.from(span.traceId as string, "hex");
        span.spanId = Buffer.from(span.spanId as string, "hex");
      }
    }
  }
  return ProtoRequestType.encode(ProtoRequestType.fromObject(payload)).finish();
}

function req(body: string | Uint8Array, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body as BodyInit,
  });
}

const auth = { Authorization: "Bearer rtl_testkey" };

test("missing Authorization → 401", async () => {
  const { deps } = makeDeps();
  assert.equal((await handleTracesRequest(req(otlpJson()), deps)).status, 401);
});

test("malformed Authorization (no Bearer) → 401", async () => {
  const { deps } = makeDeps();
  const res = await handleTracesRequest(req(otlpJson(), { Authorization: "Token abc" }), deps);
  assert.equal(res.status, 401);
});

test("unsupported Content-Type → 415", async () => {
  const { deps } = makeDeps();
  const res = await handleTracesRequest(
    req(otlpJson(), { ...auth, "Content-Type": "text/plain" }),
    deps,
  );
  assert.equal(res.status, 415);
});

test("oversized body (declared content-length) → 413", async () => {
  const { deps } = makeDeps();
  const res = await handleTracesRequest(
    req(otlpJson(), { ...auth, "Content-Length": String(MAX_BODY_BYTES + 1) }),
    deps,
  );
  assert.equal(res.status, 413);
});

test("chunked over-cap body with no content-length → 413 without full buffering", async () => {
  const MiB = 1024 * 1024;
  const { deps, inserted } = makeDeps();
  const { stream, counters } = chunkedCountingBody({ chunkBytes: MiB, totalBytes: 8 * MiB });
  const chunked = new Request("http://localhost/api/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const res = await handleTracesRequest(chunked, deps);

  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), {
    error: `Request body too large (max ${MAX_BODY_BYTES} bytes).`,
  });
  assert.ok(
    counters.enqueuedBytes <= MAX_BODY_BYTES + 2 * MiB,
    `handler should stop pulling near the cap; enqueued ${counters.enqueuedBytes} bytes`,
  );
  assert.equal(inserted.length, 0);
});

test("db not configured → 503", async () => {
  const { deps } = makeDeps({ isDbConfigured: () => false });
  assert.equal((await handleTracesRequest(req(otlpJson(), auth), deps)).status, 503);
});

test("invalid / revoked key → 401", async () => {
  const { deps } = makeDeps({ findActiveApiKeyByHash: async () => null });
  assert.equal((await handleTracesRequest(req(otlpJson(), auth), deps)).status, 401);
});

test("malformed JSON body → 400", async () => {
  const { deps } = makeDeps();
  const res = await handleTracesRequest(req("{not json", auth), deps);
  assert.equal(res.status, 400);
});

test("too many spans (> MAX_SPANS) → 413", async () => {
  const { deps } = makeDeps();
  const res = await handleTracesRequest(req(otlpJson(MAX_SPANS + 1), auth), deps);
  assert.equal(res.status, 413);
});

test("happy path → 202, inserts mapped rows, returns envelope", async () => {
  const { deps, inserted } = makeDeps();
  const res = await handleTracesRequest(req(otlpJson(2), auth), deps);
  assert.equal(res.status, 202);
  const body = (await res.json()) as { accepted: number; calls: number; spans: number };
  assert.equal(body.spans, 2);
  assert.equal(body.calls, 2);
  assert.equal(body.accepted, 2);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].length, 2);
  assert.equal(inserted[0][0].event.projectId, "proj-1");
  assert.equal(inserted[0][0].event.provider, "openai");
  assert.equal(inserted[0][0].event.inputTokens, 1000);
});

test("stamps project and org onto the request log context", async () => {
  const contexts: unknown[][] = [];
  const { deps } = makeDeps({
    getOrganizationByProjectId: async () => ({ id: "org-1" }) as never,
    setRequestLogContext: (...args) => contexts.push(args),
  });

  const res = await handleTracesRequest(req(otlpJson(), auth), deps);

  assert.equal(res.status, 202);
  assert.equal(contexts.length, 1);
  assert.deepEqual(contexts[0]?.[1], { project_id: "proj-1", org_id: "org-1" });
});

test("a protobuf export returns an empty protobuf success with count headers", async () => {
  const { deps } = makeDeps();
  const res = await handleTracesRequest(
    req(otlpProto(2), {
      ...auth,
      "Content-Type": "application/x-protobuf",
    }),
    deps,
  );

  assert.equal(res.status, 202);
  assert.equal(res.headers.get("content-type"), "application/x-protobuf");
  assert.equal((await res.arrayBuffer()).byteLength, 0);
  assert.equal(res.headers.get("x-ratel-accepted"), "2");
  assert.equal(res.headers.get("x-ratel-calls"), "2");
  assert.equal(res.headers.get("x-ratel-spans"), "2");
});

test("an OTLP/JSON export keeps its envelope and gains count headers", async () => {
  const { deps } = makeDeps();
  const res = await handleTracesRequest(req(otlpJson(2), auth), deps);

  assert.deepEqual(await res.json(), { accepted: 2, calls: 2, spans: 2 });
  assert.equal(res.headers.get("x-ratel-accepted"), "2");
  assert.equal(res.headers.get("x-ratel-calls"), "2");
  assert.equal(res.headers.get("x-ratel-spans"), "2");
});

test("the raw-span tap stores every decoded span under the API-key project", async () => {
  const projectId = "proj-trace-span-identity";
  const { deps, storedSpans } = makeDeps({
    findActiveApiKeyByHash: async () => ({ ...FAKE_KEY, projectId }),
    getOrganizationByProjectId: async () =>
      ({
        id: "org-1",
        slug: "ratel",
        plan: "pro",
        planOverride: null,
        subscriptionStatus: "canceled",
      }) as never,
  });

  const res = await handleTracesRequest(req(otlpJson(2), auth), deps);

  assert.equal(res.status, 202);
  assert.equal(storedSpans.length, 1);
  assert.equal(storedSpans[0].length, 2);
  assert.deepEqual(
    storedSpans[0].map((span) => span.projectId),
    [projectId, projectId],
  );
});

test("export with no LLM spans → 202 with accepted 0 (no insert)", async () => {
  const { deps, inserted } = makeDeps();
  // A lone ratel.search span → zero anchors.
  const body = JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            scope: { name: "ratel" },
            spans: [
              {
                traceId: "0".repeat(32),
                spanId: "0".repeat(16),
                name: "ratel.search",
                kind: 1,
                startTimeUnixNano: "1751800000000000000",
                endTimeUnixNano: "1751800000000000000",
                attributes: [{ key: "ratel.search.target", value: { stringValue: "tool" } }],
              },
            ],
          },
        ],
      },
    ],
  });
  const res = await handleTracesRequest(req(body, auth), deps);
  assert.equal(res.status, 202);
  const json = (await res.json()) as { accepted: number; calls: number; spans: number };
  assert.equal(json.spans, 1);
  assert.equal(json.calls, 0);
  assert.equal(json.accepted, 0);
  assert.equal(inserted.length, 0, "no rows → no insert call");
});

test("anchor-less ratel.search span with a captured query → derived trace event, accepted 0", async () => {
  const { deps, inserted, derived } = makeDeps();
  // The SDK funnel exports its search spans on their own traces (no LLM anchor in
  // the batch); the derivation must run even though no events row is written.
  const body = JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "worker-a" } }],
        },
        scopeSpans: [
          {
            scope: { name: "@ratel-ai/sdk" },
            spans: [
              {
                traceId: "a".repeat(32),
                spanId: "b".repeat(16),
                name: "ratel.search",
                kind: 1,
                startTimeUnixNano: "1751800000000000000",
                endTimeUnixNano: "1751800000012000000",
                attributes: [
                  { key: "ratel.search.target", value: { stringValue: "tool" } },
                  { key: "ratel.search.query", value: { stringValue: "create a page in notion" } },
                  { key: "ratel.search.hit_count", value: { intValue: "3" } },
                  { key: "ratel.event.id", value: { stringValue: "evt-search" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const res = await handleTracesRequest(req(body, auth), deps);
  assert.equal(res.status, 202);
  const json = (await res.json()) as { accepted: number; calls: number; spans: number };
  assert.equal(json.accepted, 0);
  assert.equal(inserted.length, 0);
  assert.equal(derived.length, 1, "insertTraceEvents called once");
  const rows = derived[0] as Array<{
    type: string;
    query: string;
    hitCount: number;
    eventId: string | null;
    sourceId: string | null;
    ingestSource: string;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "search");
  assert.equal(rows[0].query, "create a page in notion");
  assert.equal(rows[0].hitCount, 3);
  assert.equal(rows[0].eventId, "evt-search");
  assert.equal(rows[0].sourceId, "worker-a");
  assert.equal(rows[0].ingestSource, "otlp");
});

test("derived inserts leave the facts-era supersede at its default", async () => {
  const anchorlessSearch = JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "worker-a" } }] },
        scopeSpans: [
          {
            scope: { name: "@ratel-ai/sdk" },
            spans: [
              {
                traceId: "d".repeat(32),
                spanId: "e".repeat(16),
                name: "ratel.search",
                kind: 1,
                startTimeUnixNano: "1751800000000000000",
                endTimeUnixNano: "1751800000012000000",
                attributes: [
                  { key: "ratel.search.target", value: { stringValue: "tool" } },
                  { key: "ratel.search.query", value: { stringValue: "list open incidents" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const options: unknown[] = [];
  const { deps } = makeDeps({
    insertTraceEvents: async (_projectId, events, _db, opts) => {
      options.push(opts);
      return { accepted: events.length };
    },
  });
  const res = await handleTracesRequest(req(anchorlessSearch, auth), deps);

  assert.equal(res.status, 202);
  // No per-request override: consolidate.ts defaults the supersede on, so the
  // facts era suppresses these derived rows for latched sources.
  assert.deepEqual(options, [undefined]);
});

/** An OTLP/JSON export: one anchor whose span-attr messages carry a search_capabilities
 * call, plus a ratel.search span for the SAME query (the SDK-under-host-trace shape). */
function otlpJsonWithDuplicateSearch(query: string): string {
  const outputMessages = JSON.stringify([
    {
      role: "assistant",
      parts: [{ type: "tool_call", id: "c1", name: "search_capabilities", arguments: { query } }],
    },
  ]);
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            scope: { name: "ratel" },
            spans: [
              {
                traceId: "c".repeat(32),
                spanId: "1".repeat(16),
                name: "chat gpt-5.5",
                kind: 3,
                startTimeUnixNano: "1751800000000000000",
                endTimeUnixNano: "1751800000200000000",
                attributes: [
                  { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                  { key: "gen_ai.request.model", value: { stringValue: "gpt-5.5" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: "100" } },
                  { key: "gen_ai.output.messages", value: { stringValue: outputMessages } },
                ],
              },
              {
                traceId: "c".repeat(32),
                spanId: "2".repeat(16),
                parentSpanId: "1".repeat(16),
                name: "ratel.search",
                kind: 1,
                startTimeUnixNano: "1751800000000000000",
                endTimeUnixNano: "1751800000012000000",
                attributes: [
                  { key: "ratel.search.target", value: { stringValue: "tool" } },
                  { key: "ratel.search.query", value: { stringValue: query } },
                  { key: "ratel.search.hit_count", value: { intValue: "2" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

test("a search captured in BOTH message content and a ratel.search span derives one row, not two", async () => {
  const { deps, derived } = makeDeps();
  const res = await handleTracesRequest(
    req(otlpJsonWithDuplicateSearch("shared query"), auth),
    deps,
  );
  assert.equal(res.status, 202);
  assert.equal(derived.length, 1);
  const rows = derived[0] as Array<{ type: string; query: string | null }>;
  // The span row wins (it carries hit_count/took_ms); the gateway_search
  // duplicate from the reconstructed messages is dropped.
  assert.deepEqual(
    rows.map((r) => [r.type, r.query]),
    [["search", "shared query"]],
  );
});

test("derived-insert failure on an anchor-less batch → 500 (exporter must retry)", async () => {
  const { deps } = makeDeps({
    insertTraceEvents: async () => {
      throw new Error("neon hiccup");
    },
  });
  const body = JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            scope: { name: "@ratel-ai/sdk" },
            spans: [
              {
                traceId: "d".repeat(32),
                spanId: "e".repeat(16),
                name: "ratel.search",
                kind: 1,
                startTimeUnixNano: "1751800000000000000",
                endTimeUnixNano: "1751800000012000000",
                attributes: [
                  { key: "ratel.search.query", value: { stringValue: "will be lost otherwise" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const res = await handleTracesRequest(req(body, auth), deps);
  assert.equal(res.status, 500);
});

test("derived-insert failure stays best-effort when events rows were stored", async () => {
  const { deps, inserted } = makeDeps({
    insertTraceEvents: async () => {
      throw new Error("neon hiccup");
    },
  });
  const res = await handleTracesRequest(req(otlpJsonWithDuplicateSearch("q"), auth), deps);
  // The events insert succeeded and keeps the queries recoverable via backfill.
  assert.equal(res.status, 202);
  assert.equal(inserted.length, 1);
});

test("raw-span insert failure stays best-effort and preserves existing writes", async () => {
  const { deps, inserted, derived } = makeDeps({
    getOrganizationByProjectId: async () => ({ id: "org-1" }) as never,
    insertOtelSpans: async () => {
      throw new Error("span storage down");
    },
  });

  const res = await handleTracesRequest(req(otlpJsonWithDuplicateSearch("q"), auth), deps);
  const body = (await res.json()) as { accepted: number; calls: number; spans: number };

  assert.equal(res.status, 202);
  assert.deepEqual(body, { accepted: 1, calls: 1, spans: 2 });
  assert.equal(inserted.length, 1);
  assert.equal(derived.length, 1);
});

test("insert failure → 500", async () => {
  const { deps } = makeDeps({
    insertEventsWithMetrics: async () => {
      throw new Error("db down");
    },
  });
  const res = await handleTracesRequest(req(otlpJson(), auth), deps);
  assert.equal(res.status, 500);
});

test("touchApiKey failure never downgrades a successful insert", async () => {
  const { deps } = makeDeps({
    touchApiKey: async () => {
      throw new Error("touch failed");
    },
  });
  const res = await handleTracesRequest(req(otlpJson(), auth), deps);
  assert.equal(res.status, 202);
});

test("invalid trace API keys emit a rejection with timing", async () => {
  const warnings: unknown[][] = [];
  const events: Array<{
    event: string;
    context: Record<string, unknown>;
    properties: Record<string, unknown>;
  }> = [];
  let now = 1_000;
  const { deps } = makeDeps({
    findActiveApiKeyByHash: async () => null,
    trackServerEvent: async (event, context, properties) => {
      events.push({ event, context, properties: properties ?? {} });
    },
    shouldSampleSuccess: () => false,
    logWarn: (...args) => warnings.push(args),
    now: () => {
      now += 25;
      return new Date(now);
    },
  });

  const response = await handleTracesRequest(req(otlpJson(), auth), deps);

  assert.equal(response.status, 401);
  assert.deepEqual(events, [
    {
      event: "otlp_ingest_request",
      context: { distinctId: "otlp:anonymous" },
      properties: {
        endpoint: "/v1/traces",
        outcome: "rejected",
        reason: "invalid_key",
        status: 401,
        duration_ms: 25,
      },
    },
  ]);
  assert.equal(warnings.length, 1);
});

test("trace rejections classify every response path", async () => {
  const cases: Array<{
    name: string;
    expected: [number, string, string];
    run: (track: NonNullable<TracesHandlerDeps["trackServerEvent"]>) => Promise<Response>;
  }> = [
    {
      name: "missing auth",
      expected: [401, "invalid_key", "anonymous"],
      run: (trackServerEvent) =>
        handleTracesRequest(req(otlpJson()), makeDeps({ trackServerEvent }).deps),
    },
    {
      name: "unsupported media",
      expected: [415, "unsupported_media", "anonymous"],
      run: (trackServerEvent) =>
        handleTracesRequest(
          req(otlpJson(), { ...auth, "Content-Type": "text/plain" }),
          makeDeps({ trackServerEvent }).deps,
        ),
    },
    {
      name: "declared oversized",
      expected: [413, "oversized", "anonymous"],
      run: (trackServerEvent) =>
        handleTracesRequest(
          req(otlpJson(), {
            ...auth,
            "Content-Length": String(MAX_BODY_BYTES + 1),
          }),
          makeDeps({ trackServerEvent }).deps,
        ),
    },
    {
      name: "database unavailable",
      expected: [503, "unavailable", "anonymous"],
      run: (trackServerEvent) =>
        handleTracesRequest(
          req(otlpJson(), auth),
          makeDeps({
            trackServerEvent,
            isDbConfigured: () => false,
          }).deps,
        ),
    },
    {
      name: "malformed payload",
      expected: [400, "malformed", "project"],
      run: (trackServerEvent) =>
        handleTracesRequest(req("{not json", auth), makeDeps({ trackServerEvent }).deps),
    },
    {
      name: "decoded oversized",
      expected: [413, "oversized", "project"],
      run: (trackServerEvent) =>
        handleTracesRequest(
          req(otlpJson(MAX_SPANS + 1), auth),
          makeDeps({ trackServerEvent }).deps,
        ),
    },
    {
      name: "quota",
      expected: [429, "quota", "project"],
      run: (trackServerEvent) =>
        handleTracesRequest(
          req(otlpJson(), auth),
          makeDeps({
            trackServerEvent,
            getOrganizationByProjectId: async () =>
              ({
                id: "org-1",
                limitOverrides: { monthlyEventLimit: 100 },
              }) as never,
            resetEventUsageIfElapsed: async () => 50_000,
          }).deps,
        ),
    },
    {
      name: "storage failure",
      expected: [500, "storage", "project"],
      run: (trackServerEvent) =>
        handleTracesRequest(
          req(otlpJson(), auth),
          makeDeps({
            trackServerEvent,
            insertEventsWithMetrics: async () => {
              throw new Error("db down");
            },
          }).deps,
        ),
    },
  ];

  for (const rejection of cases) {
    const events: Array<{
      context: Record<string, unknown>;
      properties: Record<string, unknown>;
    }> = [];
    const response = await rejection.run(async (_event, context, properties) => {
      events.push({ context, properties: properties ?? {} });
    });
    const [status, reason, identity] = rejection.expected;
    assert.equal(response.status, status, rejection.name);
    assert.equal(events.length, 1, rejection.name);
    assert.equal(events[0].properties.endpoint, "/v1/traces", rejection.name);
    assert.equal(events[0].properties.outcome, "rejected", rejection.name);
    assert.equal(events[0].properties.reason, reason, rejection.name);
    assert.equal(events[0].properties.status, status, rejection.name);
    assert.equal(typeof events[0].properties.duration_ms, "number", rejection.name);
    assert.equal(
      identity === "project" ? events[0].context.projectId : events[0].context.distinctId,
      identity === "project" ? "proj-1" : "otlp:anonymous",
      rejection.name,
    );
  }
});

test("accepted trace events follow the injected success sampler", async () => {
  const events: Array<{
    event: string;
    context: Record<string, unknown>;
    properties: Record<string, unknown>;
  }> = [];
  let sampled = false;
  const { deps } = makeDeps({
    findActiveApiKeyByHash: async () => ({
      ...FAKE_KEY,
      lastUsedAt: new Date("2026-01-01T00:00:00Z"),
    }),
    shouldSampleSuccess: () => sampled,
    trackServerEvent: async (event, context, properties) => {
      events.push({ event, context, properties: properties ?? {} });
    },
    now: () => new Date(1_000),
  });

  assert.equal((await handleTracesRequest(req(otlpJson(2), auth), deps)).status, 202);
  assert.deepEqual(events, []);

  sampled = true;
  assert.equal((await handleTracesRequest(req(otlpJson(2), auth), deps)).status, 202);
  assert.deepEqual(events, [
    {
      event: "otlp_ingest_request",
      context: { projectId: "proj-1" },
      properties: {
        endpoint: "/v1/traces",
        outcome: "accepted",
        status: 202,
        duration_ms: 0,
        accepted: 2,
        calls: 2,
        spans: 2,
      },
    },
  ]);
});

test("the default success sampler reads OBS_INGEST_SUCCESS_SAMPLE_RATE", async (t) => {
  const previousRate = process.env.OBS_INGEST_SUCCESS_SAMPLE_RATE;
  t.after(() => {
    if (previousRate === undefined) {
      delete process.env.OBS_INGEST_SUCCESS_SAMPLE_RATE;
    } else {
      process.env.OBS_INGEST_SUCCESS_SAMPLE_RATE = previousRate;
    }
  });
  t.mock.method(Math, "random", () => 0.999);
  const events: string[] = [];
  const { deps } = makeDeps({
    findActiveApiKeyByHash: async () => ({
      ...FAKE_KEY,
      lastUsedAt: new Date("2026-01-01T00:00:00Z"),
    }),
    trackServerEvent: async (event) => {
      events.push(event);
    },
  });

  process.env.OBS_INGEST_SUCCESS_SAMPLE_RATE = "1";
  await handleTracesRequest(req(otlpJson(), auth), deps);
  process.env.OBS_INGEST_SUCCESS_SAMPLE_RATE = "0";
  await handleTracesRequest(req(otlpJson(), auth), deps);

  assert.deepEqual(events, ["otlp_ingest_request"]);
});

test("the first successful trace for an untouched API key emits first_trace_received", async () => {
  const events: Array<{
    event: string;
    context: Record<string, unknown>;
    properties: Record<string, unknown>;
  }> = [];
  const { deps } = makeDeps({
    shouldSampleSuccess: () => false,
    trackServerEvent: async (event, context, properties) => {
      events.push({ event, context, properties: properties ?? {} });
    },
    now: () => new Date(1_000),
  });

  const response = await handleTracesRequest(req(otlpJson(), auth), deps);

  assert.equal(response.status, 202);
  assert.deepEqual(events, [
    {
      event: "first_trace_received",
      context: { projectId: "proj-1" },
      properties: { endpoint: "/v1/traces", duration_ms: 0 },
    },
  ]);
});

test("trace processing reports exceptions through the telemetry shim", async () => {
  const errors = {
    insert: new Error("insert failed"),
    derived: new Error("derived failed"),
    rawSpan: new Error("raw span failed"),
    normalize: new Error("normalize failed"),
  };
  const captured: Array<{
    error: unknown;
    distinctId: string;
    properties: Record<string, unknown>;
  }> = [];
  const captureDeps = {
    reportServerException: (
      error: unknown,
      distinctId: string,
      properties: Record<string, unknown>,
    ) => {
      captured.push({ error, distinctId, properties });
    },
  };

  await handleTracesRequest(
    req(otlpJson(), auth),
    makeDeps({
      ...captureDeps,
      insertEventsWithMetrics: async () => {
        throw errors.insert;
      },
    }).deps,
  );
  await handleTracesRequest(
    req(otlpJsonWithDuplicateSearch("q"), auth),
    makeDeps({
      ...captureDeps,
      insertTraceEvents: async () => {
        throw errors.derived;
      },
    }).deps,
  );
  await handleTracesRequest(
    req(otlpJson(), auth),
    makeDeps({
      ...captureDeps,
      insertOtelSpans: async () => {
        throw errors.rawSpan;
      },
    }).deps,
  );
  await handleTracesRequest(
    req(otlpJson(), auth),
    makeDeps({
      ...captureDeps,
      normalizeAiSdkSpans: () => {
        throw errors.normalize;
      },
    }).deps,
  );

  assert.deepEqual(
    captured.map(({ error, distinctId, properties }) => ({
      error,
      distinctId,
      endpoint: properties.endpoint,
      project_id: properties.project_id,
    })),
    Object.values(errors).map((error) => ({
      error,
      distinctId: "project:proj-1",
      endpoint: "/v1/traces",
      project_id: "proj-1",
    })),
  );
});

test("gzip and deflate bodies are read as the OpenTelemetry Collector sends them", async () => {
  const { deps } = makeDeps();
  const gz = await handleTracesRequest(
    req(gzipSync(otlpJson(2)), { ...auth, "Content-Encoding": "gzip" }),
    deps,
  );
  assert.equal(gz.status, 202);
  assert.equal(((await gz.json()) as { spans: number }).spans, 2);
  const { deps: protoDeps, inserted } = makeDeps();
  const proto = await handleTracesRequest(
    req(gzipSync(otlpProto(3)), {
      ...auth,
      "Content-Type": "application/x-protobuf",
      "Content-Encoding": "gzip",
    }),
    protoDeps,
  );
  assert.equal(proto.status, 202, "protobuf answers in protobuf");
  assert.equal(inserted[0]?.length, 3);
  const deflated = await handleTracesRequest(
    req(deflateSync(otlpJson(1)), { ...auth, "Content-Encoding": "deflate" }),
    deps,
  );
  assert.equal(deflated.status, 202);
});

test("a compressed body is capped once inflated, and unknown or broken encodings are refused", async () => {
  const { deps } = makeDeps();
  const bomb = gzipSync(Buffer.alloc(MAX_INFLATED_BYTES + 1, 0x20));
  assert.ok(bomb.byteLength < MAX_BODY_BYTES, "small on the wire");
  assert.equal(
    (await handleTracesRequest(req(bomb, { ...auth, "Content-Encoding": "gzip" }), deps)).status,
    413,
  );
  assert.equal(
    (await handleTracesRequest(req(otlpJson(1), { ...auth, "Content-Encoding": "br" }), deps))
      .status,
    415,
  );
  assert.equal(
    (await handleTracesRequest(req(otlpJson(1), { ...auth, "Content-Encoding": "gzip" }), deps))
      .status,
    400,
  );
  assert.deepEqual(inflateBody(new Uint8Array([1, 2]), null), {
    ok: true,
    bytes: new Uint8Array([1, 2]),
  });
});

/** An `invoke_agent` root with the run's summed usage and one `chat` child. */
function agentRootJson(): string {
  const usage = [
    { key: "gen_ai.request.model", value: { stringValue: "gpt-5.5" } },
    { key: "gen_ai.usage.input_tokens", value: { intValue: "1000" } },
    { key: "gen_ai.usage.output_tokens", value: { intValue: "200" } },
  ];
  const span = (spanId: string, parentSpanId: string, op: string) => ({
    traceId: "a".repeat(32),
    spanId,
    parentSpanId,
    name: op,
    kind: 3,
    startTimeUnixNano: "1751800000000000000",
    endTimeUnixNano: "1751800000200000000",
    attributes: [{ key: "gen_ai.operation.name", value: { stringValue: op } }, ...usage],
  });
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            scope: { name: "agent" },
            spans: [
              span("1".repeat(16), "", "invoke_agent"),
              span("2".repeat(16), "1".repeat(16), "chat"),
            ],
          },
        ],
      },
    ],
  });
}

test("agent span dedupe: the agent root is not a call of its own", async () => {
  const { deps, inserted } = makeDeps({
    agentSpanDedupe: { findTracesWithModelCalls: async () => new Set() },
  });
  const res = await handleTracesRequest(req(agentRootJson(), auth), deps);
  assert.equal(res.status, 202);
  assert.equal(inserted[0].length, 1);
});
