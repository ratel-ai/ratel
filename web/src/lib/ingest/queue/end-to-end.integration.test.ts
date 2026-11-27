import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { PGlite } from "@electric-sql/pglite";
import {
  findStoredOtelSpans,
  findTracesWithModelCalls,
  insertEventsWithMetrics,
  insertOtelSpans,
} from "@/lib/ingest/otlp/queries";
import { handleTracesRequest, type TracesHandlerDeps } from "@/lib/ingest/otlp/route-handler";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import type { ApiKey } from "@/lib/platform/projects/schema";
import {
  type Db,
  ORGANIZATION_ID,
  PROJECT_ID,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import type { IngestQueueAcceptDeps } from "./accept";
import { drainIngestBatches, type IngestQueueStore } from "./drain";
import { type IngestPersistDeps, persistIngestBatch } from "./persist";
import {
  claimNextIngestBatch,
  enqueueIngestBatch,
  failIngestBatch,
  markIngestBatchDone,
  retryIngestBatch,
} from "./queries";

/**
 * RTL-314 end to end on PGlite: the traces route queues, a drain persists through the inline
 * write path, and the stored rows are the ones the inline route stores. A batch persisted twice
 * (its worker died after the write, before marking it done) and an exporter's resend add nothing.
 */

const KEY: ApiKey = {
  id: "key-1",
  projectId: PROJECT_ID,
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
const ORG = {
  id: ORGANIZATION_ID,
  slug: "acme",
  plan: "free",
  planOverride: null,
  subscriptionStatus: null,
};

function spansJson(n: number, offset = 0): string {
  const spans = Array.from({ length: n }, (_, i) => ({
    traceId: (offset + i + 1).toString(16).padStart(32, "0"),
    spanId: (offset + i + 1).toString(16).padStart(16, "0"),
    name: "chat gpt-5.5",
    kind: 3,
    startTimeUnixNano: "1751800000000000000",
    endTimeUnixNano: "1751800000200000000",
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

function routeDeps(db: Db, ingestQueue?: IngestQueueAcceptDeps): TracesHandlerDeps {
  return {
    scope: "ingest:traces",
    isDbConfigured: () => true,
    hashApiKey: (s) => `hashed:${s}`,
    findActiveApiKeyByHash: async () => KEY,
    touchApiKey: async () => {},
    insertEventsWithMetrics: (p, rows) => insertEventsWithMetrics(p, rows, db),
    insertTraceEvents: (p, events) => insertTraceEvents(p, events, db),
    insertOtelSpans: (p, rows) => insertOtelSpans(p, rows, db),
    findStoredOtelSpans: (p, spans) => findStoredOtelSpans(p, spans, db),
    agentSpanDedupe: { findTracesWithModelCalls: (p, ids) => findTracesWithModelCalls(p, ids, db) },
    logError: (message, err) => assert.fail(`${message}: ${String(err)}`),
    logWarn: () => {},
    ...(ingestQueue ? { ingestQueue } : {}),
  };
}

function persistDeps(db: Db, usage: number[]): IngestPersistDeps {
  return {
    getOrganizationByProjectId: async () => ORG as never,
    traces: {
      insertEventsWithMetrics: (p, rows) => insertEventsWithMetrics(p, rows, db),
      insertTraceEvents: (p, events) => insertTraceEvents(p, events, db),
      insertOtelSpans: (p, rows, _db, options) => insertOtelSpans(p, rows, db, options),
      findStoredOtelSpans: (p, spans) => findStoredOtelSpans(p, spans, db),
      incrementEventUsage: async (_org, n) => {
        usage.push(n);
      },
      agentSpanDedupe: {
        findTracesWithModelCalls: (p, ids) => findTracesWithModelCalls(p, ids, db),
      },
    },
    logs: { insertOtelLogs: async () => assert.fail("no logs here") },
    events: {
      insertTraceEvents: async () => assert.fail("no events here"),
      insertTraceEventRejects: async () => {},
    },
    logError: (message, err) => assert.fail(`${message}: ${String(err)}`),
    logWarn: () => {},
    reportServerException: () => {},
  };
}

function store(db: Db): IngestQueueStore {
  return {
    claim: (options) => claimNextIngestBatch(db, options),
    done: (id, attempt, result) => markIngestBatchDone(id, attempt, result, db),
    fail: (id, attempt, error) => failIngestBatch(id, attempt, error, db),
    retry: (id, attempt, error, options) => retryIngestBatch(id, attempt, error, options, db),
  };
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

async function counts(client: PGlite): Promise<Record<string, number>> {
  const one = async (sql: string) => Number((await client.query<{ n: number }>(sql)).rows[0].n);
  return {
    spans: await one("select count(*)::int as n from otel_spans"),
    events: await one("select count(*)::int as n from events"),
    queued: await one("select count(*)::int as n from ingest_batches where status = 'queued'"),
    done: await one("select count(*)::int as n from ingest_batches where status = 'done'"),
  };
}

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/v1/traces", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer rtl_key", ...headers },
    body,
  });
}

test("a queued export is stored by the drain exactly as the inline route stores it", async () => {
  const inline = await setupDb();
  const inlineResponse = await handleTracesRequest(post(spansJson(3)), routeDeps(inline.db));
  assert.equal(inlineResponse.status, 202);
  const expected = await counts(inline.client);

  const queued = await setupDb();
  const accept: IngestQueueAcceptDeps = {
    enabled: () => true,
    enqueue: (batch) => enqueueIngestBatch(batch, queued.db),
    scheduleDrain: () => {},
  };
  const gz = gzipSync(Buffer.from(spansJson(3)));
  const response = await handleTracesRequest(
    post(gz, { "Content-Encoding": "gzip" }),
    routeDeps(queued.db, accept),
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await counts(queued.client), { spans: 0, events: 0, queued: 1, done: 0 });

  const usage: number[] = [];
  const summary = await drainIngestBatches(
    store(queued.db),
    (batch) => persistIngestBatch(batch, persistDeps(queued.db, usage)),
    { perProject: 1, maxAttempts: 5, log: silent },
  );
  assert.deepEqual(summary, { done: 1, failed: 0, retried: 0 });
  const after = await counts(queued.client);
  assert.deepEqual(
    { spans: after.spans, events: after.events },
    { spans: expected.spans, events: expected.events },
  );
  assert.equal(after.spans, 3);
  assert.deepEqual(usage, [3], "the monthly cap counted the stored events once");
});

test("a batch persisted twice, and an exporter's resend, add no row and no usage", async () => {
  const { db, client } = await setupDb();
  const usage: number[] = [];
  const deps = persistDeps(db, usage);
  await enqueueIngestBatch(
    {
      projectId: PROJECT_ID,
      signal: "traces",
      contentType: "application/json",
      contentEncoding: null,
      body: new TextEncoder().encode(spansJson(4)),
      context: {},
    },
    db,
  );
  const batch = await claimNextIngestBatch(db, { perProject: 1 });
  assert.ok(batch);
  // The worker wrote the batch, then died before marking it done: the reaper queues it again.
  assert.equal((await persistIngestBatch(batch, deps)).kind, "done");
  assert.deepEqual(await persistIngestBatch(batch, deps), {
    kind: "done",
    result: { accepted: 0, calls: 4, spans: 4 },
  });
  // The exporter timed out and sent the same export again: a second batch.
  await enqueueIngestBatch(
    {
      projectId: PROJECT_ID,
      signal: "traces",
      contentType: "application/json",
      contentEncoding: null,
      body: new TextEncoder().encode(spansJson(4)),
      context: {},
    },
    db,
  );
  await markIngestBatchDone(batch.id, batch.attempts, {}, db);
  await drainIngestBatches(store(db), (b) => persistIngestBatch(b, deps), {
    perProject: 1,
    maxAttempts: 5,
    log: silent,
  });
  const after = await counts(client);
  assert.equal(after.spans, 4);
  assert.equal(after.events, 4);
  assert.deepEqual(usage, [4], "usage counts only what was new");
});

test("a batch whose write keeps failing is retried, then failed and kept for an operator", async () => {
  const { db, client } = await setupDb();
  const deps = persistDeps(db, []);
  deps.traces.insertEventsWithMetrics = async () => {
    throw new Error("db down");
  };
  deps.logError = () => {};
  const { id } = await enqueueIngestBatch(
    {
      projectId: PROJECT_ID,
      signal: "traces",
      contentType: "application/json",
      contentEncoding: null,
      body: new TextEncoder().encode(spansJson(1)),
      context: {},
    },
    db,
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    await client.query("update ingest_batches set available_at = now() where id = $1", [id]);
    await drainIngestBatches(store(db), (b) => persistIngestBatch(b, deps), {
      perProject: 1,
      maxAttempts: 3,
      log: silent,
    });
  }
  const row = await client.query<{
    status: string;
    attempts: number;
    error: string;
    body_len: number;
  }>("select status, attempts, error, length(body) as body_len from ingest_batches where id = $1", [
    id,
  ]);
  assert.equal(row.rows[0].status, "failed");
  assert.equal(row.rows[0].attempts, 3);
  assert.equal(row.rows[0].error, "storage: the batch was not stored");
  assert.ok(row.rows[0].body_len > 0, "its bytes stay for a reprocess");
});
