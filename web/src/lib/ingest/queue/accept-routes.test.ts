import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { handleLogsRequest, type LogsHandlerDeps } from "@/lib/ingest/otlp/logs-route-handler";
import { handleTracesRequest, type TracesHandlerDeps } from "@/lib/ingest/otlp/route-handler";
import {
  handleRuntimeEventsRequest,
  type RuntimeEventsHandlerDeps,
} from "@/lib/ingest/trace-events/route-handler";
import { apiKeyPolicy } from "@/lib/platform/api-keys/policy";
import type { ApiKey } from "@/lib/platform/projects/schema";
import type { IngestQueueAcceptDeps } from "./accept";
import type { NewIngestBatch } from "./queries";

/**
 * RTL-314: with the ingest queue on, the three ingest routes authenticate, check size and the plan
 * cap, store the body as it arrived and answer 202, without decoding or writing a derived table.
 */

const KEY: ApiKey = {
  id: "key-1",
  projectId: "proj-1",
  name: "test",
  keyHash: "hash",
  keyPrefix: "rtl_abc",
  createdAt: new Date(),
  lastUsedAt: new Date(),
  revokedAt: null,
  expiresAt: null,
  scopes: ["*"],
  rateLimitPerMinute: null,
};
const INGEST_ONLY_KEY: ApiKey = {
  ...KEY,
  scopes: ["ingest:traces", "ingest:logs", "ingest:events"],
};

const ORG = {
  id: "org-1",
  slug: "acme",
  plan: "free",
  planOverride: null,
  subscriptionStatus: null,
};

function queue(over: Partial<IngestQueueAcceptDeps> = {}) {
  const batches: NewIngestBatch[] = [];
  let drains = 0;
  const deps: IngestQueueAcceptDeps = {
    enabled: () => true,
    enqueue: async (batch) => {
      batches.push(batch);
      return { id: `batch-${batches.length}` };
    },
    scheduleDrain: () => {
      drains++;
    },
    ...over,
  };
  return { deps, batches, drains: () => drains };
}

const writeNothing = (what: string) => async () =>
  assert.fail(`${what} must not run in the request`);

function tracesDeps(ingestQueue: IngestQueueAcceptDeps, over: Partial<TracesHandlerDeps> = {}) {
  const deps: TracesHandlerDeps = {
    scope: "ingest:traces",
    isDbConfigured: () => true,
    hashApiKey: (s) => `hashed:${s}`,
    findActiveApiKeyByHash: async () => KEY,
    touchApiKey: async () => {},
    insertEventsWithMetrics: writeNothing("insertEventsWithMetrics"),
    insertTraceEvents: writeNothing("insertTraceEvents"),
    insertOtelSpans: writeNothing("insertOtelSpans"),
    agentSpanDedupe: { findTracesWithModelCalls: writeNothing("the dedupe lookup") },
    shouldSampleRejection: () => true,
    logError: () => {},
    logWarn: () => {},
    ingestQueue,
    ...over,
  };
  return deps;
}

function otlpJson(): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            scope: { name: "ratel" },
            spans: [
              {
                traceId: "1".padStart(32, "0"),
                spanId: "1".padStart(16, "0"),
                name: "chat gpt-5.5",
                kind: 3,
                startTimeUnixNano: "1751800000000000000",
                endTimeUnixNano: "1751800000200000000",
                attributes: [{ key: "gen_ai.operation.name", value: { stringValue: "chat" } }],
              },
            ],
          },
        ],
      },
    ],
  });
}

function post(path: string, body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer rtl_key", ...headers },
    body,
  });
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("traces: 202 after the batch is queued as sent, with no decode or write in the request", async () => {
  const q = queue();
  const body = otlpJson();
  const response = await handleTracesRequest(post("/api/v1/traces", body), tracesDeps(q.deps));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { queued: 1 });
  assert.equal(response.headers.get("x-ratel-queued"), "1");
  assert.equal(q.batches.length, 1);
  const [batch] = q.batches;
  assert.deepEqual(
    { ...batch, body: decode(batch.body) },
    {
      projectId: "proj-1",
      signal: "traces",
      contentType: "application/json",
      contentEncoding: null,
      body,
      context: { appendOnly: false },
    },
  );
  assert.equal(q.drains(), 1, "a drain is kicked");
});

test("traces: a gzipped export is kept gzipped, a protobuf one as protobuf", async () => {
  const q = queue();
  const gz = gzipSync(Buffer.from(otlpJson()));
  const response = await handleTracesRequest(
    post("/api/v1/traces", gz, { "Content-Encoding": "gzip" }),
    tracesDeps(q.deps),
  );
  assert.equal(response.status, 202);
  assert.equal(q.batches[0].contentEncoding, "gzip");
  assert.deepEqual(Buffer.from(q.batches[0].body), gz);

  const proto = await handleTracesRequest(
    post("/api/v1/traces", new Uint8Array([10, 0]), { "Content-Type": "application/x-protobuf" }),
    tracesDeps(q.deps),
  );
  assert.equal(proto.status, 202);
  assert.equal(proto.headers.get("content-type"), "application/x-protobuf");
  assert.equal(q.batches[1].contentType, "application/x-protobuf");
});

test("traces: auth, size, encoding and plan-cap answers are unchanged and queue nothing", async () => {
  const q = queue();
  const deps = tracesDeps(q.deps);
  const cases: Array<[string, Request, TracesHandlerDeps, number]> = [
    [
      "no key",
      new Request("http://localhost/api/v1/traces", { method: "POST", body: otlpJson() }),
      deps,
      401,
    ],
    [
      "revoked key",
      post("/api/v1/traces", otlpJson()),
      { ...deps, findActiveApiKeyByHash: async () => null },
      401,
    ],
    [
      "declared too large",
      post("/api/v1/traces", otlpJson(), { "Content-Length": "999999999" }),
      deps,
      413,
    ],
    [
      "unsupported encoding",
      post("/api/v1/traces", otlpJson(), { "Content-Encoding": "br" }),
      deps,
      415,
    ],
    ["bad gzip", post("/api/v1/traces", "nope", { "Content-Encoding": "gzip" }), deps, 400],
    [
      "over the plan cap",
      post("/api/v1/traces", otlpJson()),
      {
        ...deps,
        getOrganizationByProjectId: async () => ORG as never,
        checkEventQuota: async () =>
          ({ ok: false, message: "Monthly event limit reached." }) as never,
      },
      429,
    ],
  ];
  for (const [name, request, caseDeps, status] of cases) {
    const response = await handleTracesRequest(request, caseDeps);
    assert.equal(response.status, status, name);
  }
  assert.equal(q.batches.length, 0);
});

test("traces: a body that will not decode is queued; the worker fails it", async () => {
  const q = queue();
  const response = await handleTracesRequest(
    post("/api/v1/traces", "{not json"),
    tracesDeps(q.deps),
  );
  assert.equal(response.status, 202);
  assert.equal(q.batches.length, 1);
});

test("traces: a failed enqueue answers 500 so the exporter retries, and kicks no drain", async () => {
  const q = queue({
    enqueue: async () => {
      throw new Error("db down");
    },
  });
  const errors: string[] = [];
  const response = await handleTracesRequest(
    post("/api/v1/traces", otlpJson()),
    tracesDeps(q.deps, {
      logError: (message) => errors.push(message),
      reportServerException: () => {},
    }),
  );
  assert.equal(response.status, 500);
  assert.deepEqual(errors, ["ingest batch enqueue failed"]);
  assert.equal(q.drains(), 0);
});

test("traces: with the queue off, or an ingest-only key, the export is stored in the request", async () => {
  for (const [name, ingestQueue, key] of [
    ["queue off", queue({ enabled: () => false }).deps, KEY],
    ["ingest-only key", queue().deps, INGEST_ONLY_KEY],
  ] as const) {
    const spans: unknown[] = [];
    const response = await handleTracesRequest(
      post("/api/v1/traces", otlpJson()),
      tracesDeps(ingestQueue, {
        findActiveApiKeyByHash: async () => key,
        insertEventsWithMetrics: async (_p, rows) => rows.length,
        insertTraceEvents: async (_p, events) => ({ accepted: events.length }),
        insertOtelSpans: async (_p, rows) => {
          spans.push(...rows);
          return { accepted: rows.length };
        },
        agentSpanDedupe: { findTracesWithModelCalls: async () => new Set() },
      }),
    );
    assert.equal(response.status, 202, name);
    assert.equal(spans.length, 1, `${name}: stored inline`);
    assert.equal((await response.json()).spans, 1, name);
  }
});

function logsDeps(ingestQueue: IngestQueueAcceptDeps, over: Partial<LogsHandlerDeps> = {}) {
  const deps: LogsHandlerDeps = {
    scope: "ingest:logs",
    isDbConfigured: () => true,
    hashApiKey: (s) => `hashed:${s}`,
    findActiveApiKeyByHash: async () => KEY,
    touchApiKey: async () => {},
    insertOtelLogs: writeNothing("insertOtelLogs"),
    shouldSampleRejection: () => true,
    logError: () => {},
    logWarn: () => {},
    ingestQueue,
    ...over,
  };
  return deps;
}

test("logs: 202 after the batch is queued, with no write in the request", async () => {
  const q = queue();
  const body = JSON.stringify({ resourceLogs: [] });
  const response = await handleLogsRequest(post("/api/v1/logs", body), logsDeps(q.deps));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { queued: 1 });
  assert.equal(q.batches[0].signal, "logs");
  assert.equal(decode(q.batches[0].body), body);
  assert.equal(q.drains(), 1);
  const unauthorized = await handleLogsRequest(
    post("/api/v1/logs", body),
    logsDeps(q.deps, { findActiveApiKeyByHash: async () => null }),
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(q.batches.length, 1);
});

function eventsDeps(ingestQueue: IngestQueueAcceptDeps, scopes: string[] = ["*"]) {
  const deps: RuntimeEventsHandlerDeps = {
    scope: "ingest:events",
    resolveProjectFromBearer: async () => ({
      ok: true as const,
      projectId: "proj-1",
      apiKeyId: "key-1",
      policy: apiKeyPolicy(scopes),
      rateLimitPerMinute: null,
    }),
    getOrganizationByProjectId: async () => ORG as never,
    insertTraceEvents: writeNothing("insertTraceEvents"),
    insertTraceEventRejects: writeNothing("insertTraceEventRejects"),
    rateLimiter: { consume: () => ({ allowed: true }) },
    ingestQueue,
  };
  return deps;
}

test("events: 202 after the batch is queued, the body's shape kept, nothing stored yet", async () => {
  const q = queue();
  const body = JSON.stringify({ events: [{ v: 2 }, { v: 2 }] });
  const response = await handleRuntimeEventsRequest(
    post("/api/v1/events", body),
    eventsDeps(q.deps),
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: 0, duplicates: 0, rejected: [], queued: 2 });
  assert.equal(q.batches[0].signal, "events");
  assert.equal(decode(q.batches[0].body), body);
  assert.equal(q.drains(), 1);
});

test("events: a malformed body is still a 400 and too many events a 413, queueing nothing", async () => {
  const q = queue();
  const malformed = await handleRuntimeEventsRequest(
    post("/api/v1/events", "{nope"),
    eventsDeps(q.deps),
  );
  assert.equal(malformed.status, 400);
  const tooMany = await handleRuntimeEventsRequest(
    post("/api/v1/events", JSON.stringify({ events: Array.from({ length: 5_001 }, () => ({})) })),
    eventsDeps(q.deps),
  );
  assert.equal(tooMany.status, 413);
  assert.equal(q.batches.length, 0);
});
