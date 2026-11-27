import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { type IngestPersistDeps, persistIngestBatch } from "./persist";
import type { ClaimedIngestBatch } from "./queries";

/**
 * RTL-314: a worker persists a claimed batch through the same write functions the inline routes
 * use. What no retry can fix fails at once; a failed write is retried.
 */

const PROJECT = "proj-1";
const ORG = {
  id: "org-1",
  slug: "acme",
  plan: "free",
  planOverride: null,
  subscriptionStatus: null,
};

function spansJson(n = 2): string {
  const spans = Array.from({ length: n }, (_, i) => ({
    traceId: (i + 1).toString(16).padStart(32, "0"),
    spanId: (i + 1).toString(16).padStart(16, "0"),
    name: "chat gpt-5.5",
    kind: 3,
    startTimeUnixNano: "1751800000000000000",
    endTimeUnixNano: "1751800000200000000",
    attributes: [
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.request.model", value: { stringValue: "gpt-5.5" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: "1000" } },
    ],
  }));
  return JSON.stringify({
    resourceSpans: [
      { resource: { attributes: [] }, scopeSpans: [{ scope: { name: "ratel" }, spans }] },
    ],
  });
}

function batch(over: Partial<ClaimedIngestBatch> = {}): ClaimedIngestBatch {
  return {
    id: "batch-1",
    projectId: PROJECT,
    signal: "traces",
    contentType: "application/json",
    contentEncoding: null,
    body: new TextEncoder().encode(spansJson()),
    context: { appendOnly: false },
    attempts: 1,
    receivedAt: new Date(),
    ...over,
  };
}

function makeDeps() {
  const spans: unknown[] = [];
  const events: unknown[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const traceEvents: unknown[] = [];
  const usage: Array<[string, number]> = [];
  const deps: IngestPersistDeps = {
    getOrganizationByProjectId: async () => ORG as never,
    traces: {
      insertEventsWithMetrics: async (_p, rows) => {
        events.push(...rows);
        return rows.length;
      },
      insertTraceEvents: async (_p, rows) => ({ accepted: rows.length }),
      insertOtelSpans: async (_p, rows) => {
        spans.push(...rows);
        return { accepted: rows.length };
      },
      incrementEventUsage: async (orgId, n) => {
        usage.push([orgId, n]);
      },
      agentSpanDedupe: { findTracesWithModelCalls: async () => new Set() },
    },
    logs: {
      insertOtelLogs: async (_p, rows) => {
        logs.push(...(rows as unknown as Array<Record<string, unknown>>));
        return { accepted: rows.length };
      },
    },
    events: {
      insertTraceEvents: async (_p, rows) => {
        traceEvents.push(...rows);
        return { accepted: rows.length };
      },
      insertTraceEventRejects: async () => {},
    },
    logError: () => {},
    logWarn: () => {},
    reportServerException: () => {},
  };
  return { deps, spans, events, logs, traceEvents, usage };
}

test("a trace batch is stored through the inline write path and counted against the plan", async () => {
  const h = makeDeps();
  const outcome = await persistIngestBatch(batch(), h.deps);
  assert.deepEqual(outcome, { kind: "done", result: { accepted: 2, calls: 2, spans: 2 } });
  assert.equal(h.spans.length, 2, "otel_spans");
  assert.equal(h.events.length, 2, "events");
  assert.deepEqual(h.usage, [["org-1", 2]], "the monthly cap counts the stored events");
});

test("a gzipped batch is inflated before it is decoded", async () => {
  const h = makeDeps();
  const outcome = await persistIngestBatch(
    batch({ contentEncoding: "gzip", body: gzipSync(Buffer.from(spansJson(3))) }),
    h.deps,
  );
  assert.equal(outcome.kind, "done");
  assert.equal(h.spans.length, 3);
});

test("what no retry can fix fails at once: bad bytes, bad compression, too many spans", async () => {
  const h = makeDeps();
  const malformed = await persistIngestBatch(
    batch({ body: new TextEncoder().encode("{nope") }),
    h.deps,
  );
  assert.equal(malformed.kind, "failed");
  assert.match((malformed as { error: string }).error, /^malformed: Malformed OTLP payload/);
  const badGzip = await persistIngestBatch(
    batch({ contentEncoding: "gzip", body: new TextEncoder().encode("nope") }),
    h.deps,
  );
  assert.deepEqual(badGzip, { kind: "failed", error: "malformed: Malformed compressed body." });
  const tooMany = await persistIngestBatch(
    batch({ body: new TextEncoder().encode(spansJson(5_001)) }),
    h.deps,
  );
  assert.deepEqual(tooMany, {
    kind: "failed",
    error: "oversized: Too many spans in one export (max 5000).",
  });
  assert.equal(h.spans.length, 0);
});

test("a failed write is retried", async () => {
  const h = makeDeps();
  h.deps.traces.insertEventsWithMetrics = async () => {
    throw new Error("db down");
  };
  const outcome = await persistIngestBatch(batch(), h.deps);
  assert.deepEqual(outcome, { kind: "retry", error: "storage: the batch was not stored" });
});

test("a batch the edition's span bounds refuse is done, with what was refused", async () => {
  const h = makeDeps();
  h.deps.traces.traceMetering = {
    isMetered: async () => true,
    meterTraceBatch: async (_scope, spansByTrace) =>
      new Map([...spansByTrace.keys()].map((id) => [id, "refused" as const])),
    releaseSpans: async () => {},
  };
  const outcome = await persistIngestBatch(batch(), h.deps);
  assert.deepEqual(outcome, { kind: "done", result: { refused: true } });
});

test("a log batch is stored through the inline log write; an append-only key's keeps no catalog definition", async () => {
  const h = makeDeps();
  const body = JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "agent" } }] },
        scopeLogs: [
          {
            scope: { name: "@ratel-ai/sdk" },
            logRecords: [
              {
                timeUnixNano: "1751800000000000000",
                eventName: "ratel.experiment.exposure",
                attributes: [{ key: "ratel.experiment.id", value: { stringValue: "exp-1" } }],
              },
            ],
          },
        ],
      },
    ],
  });
  const outcome = await persistIngestBatch(
    batch({ signal: "logs", body: new TextEncoder().encode(body), context: { appendOnly: true } }),
    h.deps,
  );
  assert.deepEqual(outcome, { kind: "done", result: { accepted: 1, records: 1, dropped: 0 } });
  assert.equal(h.logs.length, 1);
  assert.equal("catalogDefinition" in h.logs[0], false);
});

test("an events batch is stored through the inline events write; a body that is not { events } fails", async () => {
  const h = makeDeps();
  const ok = await persistIngestBatch(
    batch({
      signal: "events",
      body: new TextEncoder().encode(
        JSON.stringify({
          events: [
            {
              v: 2,
              ts: 1_786_000_000_000,
              session_id: "s",
              event_id: "e1",
              source_id: "x",
              type: "future_event",
            },
          ],
        }),
      ),
    }),
    h.deps,
  );
  assert.deepEqual(ok, { kind: "done", result: { accepted: 1, duplicates: 0, rejected: 0 } });
  assert.equal(h.traceEvents.length, 1);
  const bad = await persistIngestBatch(
    batch({ signal: "events", body: new TextEncoder().encode("[]") }),
    h.deps,
  );
  assert.deepEqual(bad, { kind: "failed", error: "malformed: expected { events: [] }" });
});

test("an events write that throws is retried", async () => {
  const h = makeDeps();
  h.deps.events.insertTraceEvents = async () => {
    throw new Error("db down");
  };
  const outcome = await persistIngestBatch(
    batch({ signal: "events", body: new TextEncoder().encode('{"events":[]}') }),
    h.deps,
  );
  assert.deepEqual(outcome, { kind: "retry", error: "storage: db down" });
});

test("only a batch's first try keeps its raw body, so a re-run does not store it twice", async () => {
  for (const [attempts, kept] of [
    [1, 1],
    [2, 0],
  ] as const) {
    const h = makeDeps();
    let stored = 0;
    const store = {
      store: async () => {
        stored++;
        return { stored: true as const, id: "raw-1", rawBytes: 1, storedBytes: 1 };
      },
    };
    h.deps.traces.otlpRawCapture = { store };
    h.deps.logs.otlpRawCapture = { store };
    assert.equal((await persistIngestBatch(batch({ attempts }), h.deps)).kind, "done");
    assert.equal(stored, kept, `try ${attempts}`);
  }
});
