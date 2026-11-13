import assert from "node:assert/strict";
import { test } from "node:test";
import { FOLD_MIN_INTERVAL_MS } from "@/lib/ingest/trace-events/fold-schedule";
import type { ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";
import {
  handleRuntimeEventsRequest,
  MAX_BATCH_EVENTS,
  MAX_BODY_BYTES,
  type RuntimeEventsHandlerDeps,
} from "@/lib/ingest/trace-events/route-handler";
import { chunkedCountingBody } from "@/lib/platform/http/test-support";

const AUTHORIZED = {
  ok: true as const,
  projectId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "key-1",
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    v: 2,
    ts: 1_786_000_000_000,
    session_id: "session-1",
    event_id: "event-1",
    source_id: "source-1",
    type: "future_event",
    ...overrides,
  };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://cloud.ratel.sh/api/v1/events", {
    method: "POST",
    headers: {
      authorization: "Bearer rtl_test",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeDeps(overrides: Partial<RuntimeEventsHandlerDeps> = {}) {
  const inserted: ParsedTraceEvent[][] = [];
  const rejects: Array<Record<string, unknown>> = [];
  const contexts: Array<Record<string, unknown>> = [];
  const events: Array<{
    event: string;
    context: Record<string, unknown>;
    properties: Record<string, unknown>;
  }> = [];
  const deps: RuntimeEventsHandlerDeps = {
    resolveProjectFromBearer: async () => AUTHORIZED,
    getOrganizationByProjectId: async () =>
      ({
        id: "org-1",
        slug: "ratel",
        plan: "free",
        planOverride: null,
        subscriptionStatus: null,
      }) as never,
    insertTraceEvents: async (_projectId, rows) => {
      inserted.push(rows);
      return { accepted: rows.length };
    },
    insertTraceEventRejects: async (_projectId, rows) => {
      rejects.push(...rows);
    },
    rateLimiter: { consume: () => ({ allowed: true }) },
    setRequestLogContext: (_request, context) => contexts.push(context),
    trackServerEvent: async (name, context, properties) => {
      events.push({
        event: name,
        context: context as Record<string, unknown>,
        properties: properties ?? {},
      });
    },
    logError: () => {},
    reportServerException: () => {},
    ...overrides,
  };
  return { deps, inserted, rejects, contexts, events };
}

test("auth failure is returned before runtime events are read", async () => {
  const unauthorized = Response.json({ error: "Invalid key" }, { status: 401 });
  const { deps, inserted } = makeDeps({
    resolveProjectFromBearer: async () => ({ ok: false, response: unauthorized }),
  });

  const response = await handleRuntimeEventsRequest(request({ events: [event()] }), deps);

  assert.equal(response.status, 401);
  assert.equal(inserted.length, 0);
});

test("valid and unknown events are accepted with project and org request context", async () => {
  const { deps, inserted, contexts, events } = makeDeps();

  const response = await handleRuntimeEventsRequest(
    request({ events: [event({ type: "sdk_added_later", future_field: true })] }),
    deps,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: 1,
    duplicates: 0,
    rejected: [],
  });
  assert.equal(inserted[0][0].type, "sdk_added_later");
  assert.equal(inserted[0][0].payload.future_field, true);
  assert.deepEqual(contexts, [{ project_id: AUTHORIZED.projectId, org_id: "org-1" }]);
  assert.deepEqual(events, [
    {
      event: "runtime_events_ingested",
      context: { projectId: AUTHORIZED.projectId, orgId: "org-1" },
      properties: {
        object_action: "runtime_events_ingested",
        received: 1,
        accepted: 1,
        duplicates: 0,
        rejected: 0,
      },
    },
  ]);
});

test("malformed items produce partial success and metadata-only rejects", async () => {
  const { deps, inserted, rejects } = makeDeps();
  const response = await handleRuntimeEventsRequest(
    request({
      events: [event(), event({ event_id: "bad-event", type: "search", query: undefined })],
    }),
    deps,
  );

  assert.equal(response.status, 202);
  const body = (await response.json()) as {
    accepted: number;
    duplicates: number;
    rejected: Array<{ event_id: string; reason: string }>;
  };
  assert.equal(body.accepted, 1);
  assert.equal(body.duplicates, 0);
  assert.equal(body.rejected.length, 1);
  assert.equal(body.rejected[0].event_id, "bad-event");
  assert.match(body.rejected[0].reason, /query/);
  assert.equal(inserted[0].length, 1);
  const { payloadHash, ...rejectRow } = rejects[0];
  assert.deepEqual(
    [rejectRow],
    [
      {
        eventId: "bad-event",
        type: "search",
        reason: body.rejected[0].reason,
        sizeBytes: Buffer.byteLength(
          JSON.stringify(event({ event_id: "bad-event", type: "search", query: undefined })),
        ),
        sourceId: "source-1",
      },
    ],
  );
  // A stable per-item discriminator so anonymous rejects don't collapse.
  assert.match(String(payloadHash), /^[0-9a-f]{64}$/);
  assert.equal("payload" in rejects[0], false);
});

test("oversized individual events are rejected without sinking the batch", async () => {
  const { deps, inserted, rejects } = makeDeps();
  const response = await handleRuntimeEventsRequest(
    request({
      events: [event(), event({ event_id: "too-big", value: "x".repeat(64 * 1024) })],
    }),
    deps,
  );

  assert.equal(response.status, 202);
  const body = (await response.json()) as {
    accepted: number;
    rejected: Array<{ event_id: string; reason: string }>;
  };
  assert.equal(body.accepted, 1);
  assert.equal(body.rejected[0].event_id, "too-big");
  assert.match(body.rejected[0].reason, /exceeds/);
  assert.equal(inserted[0].length, 1);
  assert.equal(rejects.length, 1);
});

test("malformed JSON returns 400 without writes", async () => {
  const { deps, inserted, rejects } = makeDeps();
  const response = await handleRuntimeEventsRequest(request("{not json"), deps);

  assert.equal(response.status, 400);
  assert.equal(inserted.length, 0);
  assert.equal(rejects.length, 0);
});

test("measured bodies above 4MB return 413 even without a content-length header", async () => {
  const { deps, inserted } = makeDeps();
  const oversized = new Request("https://cloud.ratel.sh/api/v1/events", {
    method: "POST",
    headers: {
      authorization: "Bearer rtl_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ events: [], padding: "x".repeat(MAX_BODY_BYTES) }),
  });

  const response = await handleRuntimeEventsRequest(oversized, deps);

  assert.equal(response.status, 413);
  assert.equal(inserted.length, 0);
});

test("a chunked 8MiB body with no content-length is rejected without full buffering", async () => {
  const MiB = 1024 * 1024;
  const { deps, inserted } = makeDeps();
  const { stream, counters } = chunkedCountingBody({ chunkBytes: MiB, totalBytes: 8 * MiB });
  const chunked = new Request("https://cloud.ratel.sh/api/v1/events", {
    method: "POST",
    headers: {
      authorization: "Bearer rtl_test",
      "content-type": "application/json",
    },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const response = await handleRuntimeEventsRequest(chunked, deps);

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: `Request body too large (max ${MAX_BODY_BYTES} bytes).`,
  });
  assert.ok(
    counters.enqueuedBytes <= MAX_BODY_BYTES + 2 * MiB,
    `handler should stop pulling near the cap; enqueued ${counters.enqueuedBytes} bytes`,
  );
  assert.equal(inserted.length, 0);
});

test("declared oversized bodies and batches above 5k return 413", async () => {
  const { deps } = makeDeps();
  const bodyTooLarge = await handleRuntimeEventsRequest(
    request({ events: [] }, { "content-length": String(MAX_BODY_BYTES + 1) }),
    deps,
  );
  assert.equal(bodyTooLarge.status, 413);

  const batchTooLarge = await handleRuntimeEventsRequest(
    request({
      events: Array.from({ length: MAX_BATCH_EVENTS + 1 }, (_, index) =>
        event({ event_id: `event-${index}` }),
      ),
    }),
    deps,
  );
  assert.equal(batchTooLarge.status, 413);
});

test("rate-limited keys receive 429 with Retry-After", async () => {
  const consumed: string[] = [];
  const { deps, inserted } = makeDeps({
    rateLimiter: {
      consume: (key) => {
        consumed.push(key);
        return { allowed: false, retryAfterSeconds: 7 };
      },
    },
  });

  const response = await handleRuntimeEventsRequest(request({ events: [event()] }), deps);

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.deepEqual(consumed, ["key-1"]);
  assert.equal(inserted.length, 0);
});

test("replayed batches report duplicates and remain successful", async () => {
  const seen = new Set<string>();
  const { deps } = makeDeps({
    insertTraceEvents: async (_projectId, rows) => {
      const accepted = rows.filter((row) => !seen.has(row.clientEventId));
      rows.forEach((row) => seen.add(row.clientEventId));
      return { accepted: accepted.length };
    },
  });
  const body = { events: [event()] };

  const first = await handleRuntimeEventsRequest(request(body), deps);
  const replay = await handleRuntimeEventsRequest(request(body), deps);

  assert.deepEqual(await first.json(), {
    accepted: 1,
    duplicates: 0,
    rejected: [],
  });
  assert.deepEqual(await replay.json(), {
    accepted: 0,
    duplicates: 1,
    rejected: [],
  });
});

test("a hot-looping client is rate limited before anything is stored", async () => {
  const { deps, inserted } = makeDeps({
    rateLimiter: {
      consume: () => ({ allowed: false, retryAfterSeconds: 11 }),
    },
  });

  const response = await handleRuntimeEventsRequest(request({ events: [event()] }), deps);

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "11");
  assert.equal(inserted.length, 0);
});

test("storage failures are logged, reported, and returned as 500", async () => {
  const failure = new Error("database offline");
  const logged: unknown[][] = [];
  const reported: unknown[][] = [];
  const { deps, rejects } = makeDeps({
    insertTraceEvents: async () => {
      throw failure;
    },
    logError: (...args) => logged.push(args),
    reportServerException: (...args) => reported.push(args),
  });

  const response = await handleRuntimeEventsRequest(
    request({
      events: [event(), event({ event_id: "bad-event", type: "search", query: undefined })],
    }),
    deps,
  );

  assert.equal(response.status, 500);
  assert.deepEqual(logged, [
    ["runtime event insert failed", failure, { project_id: AUTHORIZED.projectId }],
  ]);
  assert.deepEqual(reported, [
    [failure, `project:${AUTHORIZED.projectId}`, { endpoint: "/api/v1/events" }],
  ]);
  assert.equal(rejects.length, 0);
});

/* — intent graph fold trigger ————————————————————————————————————————————————— */

function foldDeps(over: { enqueue?: () => Promise<{ id: string } | null> } = {}) {
  const enqueued: string[] = [];
  const intervals: Array<number | undefined> = [];
  const drained: string[] = [];
  const logged: string[] = [];
  const { deps, ...rest } = makeDeps({
    enqueueFoldIntentGraphJob:
      over.enqueue ??
      (async (projectId, _db, options) => {
        enqueued.push(projectId);
        intervals.push(options?.minIntervalMs);
        return { id: "job-1" };
      }),
    scheduleProjectDrain: (projectId) => {
      drained.push(projectId);
    },
    logError: (message) => {
      logged.push(message);
    },
  });
  return { deps, enqueued, intervals, drained, logged, ...rest };
}

test("an accepted batch with a learning event enqueues one coalesced fold and kicks the drain", async () => {
  const { deps, enqueued, intervals, drained } = foldDeps();

  const response = await handleRuntimeEventsRequest(
    request({ events: [event({ type: "search", query: "q", origin: "agent" })] }),
    deps,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(enqueued, [AUTHORIZED.projectId]);
  assert.deepEqual(drained, [AUTHORIZED.projectId]);
  assert.deepEqual(intervals, [FOLD_MIN_INTERVAL_MS], "the ingest path paces its folds");
});

test("a coalesced enqueue (null) does not kick the drain again", async () => {
  const { deps, drained } = foldDeps({ enqueue: async () => null });

  await handleRuntimeEventsRequest(
    request({ events: [event({ type: "invoke_start", tool_id: "t" })] }),
    deps,
  );

  assert.deepEqual(drained, []);
});

test("a batch without any learning event never enqueues a fold", async () => {
  const { deps, enqueued } = foldDeps();

  await handleRuntimeEventsRequest(
    request({ events: [event({ type: "invoke_end", tool_id: "t", took_ms: 1 })] }),
    deps,
  );

  assert.deepEqual(enqueued, []);
});

test("a batch that was all duplicates never enqueues a fold", async () => {
  const { deps, enqueued } = foldDeps();
  deps.insertTraceEvents = async () => ({ accepted: 0 });

  await handleRuntimeEventsRequest(
    request({ events: [event({ type: "search", query: "q", origin: "agent" })] }),
    deps,
  );

  assert.deepEqual(enqueued, []);
});

test("an enqueue failure is logged and the ingest still answers 202", async () => {
  const { deps, logged, drained } = foldDeps({
    enqueue: async () => {
      throw new Error("jobs table unavailable");
    },
  });

  const response = await handleRuntimeEventsRequest(
    request({ events: [event({ type: "search", query: "q", origin: "agent" })] }),
    deps,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(logged, ["intent graph fold enqueue failed"]);
  assert.deepEqual(drained, []);
});

test("the intent engine is queued beside the fold, paced the same way, with one drain for both", async () => {
  const engine: Array<number | undefined> = [];
  const { deps, enqueued, drained } = foldDeps();
  deps.enqueueClusterIntentsJob = async (_projectId, _db, options) => {
    engine.push(options?.minIntervalMs);
    return { id: "job-2" };
  };

  const response = await handleRuntimeEventsRequest(
    request({ events: [event({ type: "search", query: "q", origin: "agent" })] }),
    deps,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(enqueued, [AUTHORIZED.projectId]);
  assert.deepEqual(engine, [FOLD_MIN_INTERVAL_MS]);
  assert.deepEqual(drained, [AUTHORIZED.projectId], "one drain runs both jobs");
});

test("an intent engine enqueue failure is logged on its own; the fold still kicks and the ingest answers 202", async () => {
  const { deps, logged, drained, enqueued } = foldDeps();
  deps.enqueueClusterIntentsJob = async () => {
    throw new Error("jobs table unavailable");
  };

  const response = await handleRuntimeEventsRequest(
    request({ events: [event({ type: "search", query: "q", origin: "agent" })] }),
    deps,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(logged, ["intent engine enqueue failed"]);
  assert.deepEqual(enqueued, [AUTHORIZED.projectId]);
  assert.deepEqual(drained, [AUTHORIZED.projectId]);
});

test("a drain that cannot be scheduled is logged, never a failed ingest", async () => {
  const { deps, logged } = foldDeps();
  deps.scheduleProjectDrain = () => {
    throw new Error("after() outside a request");
  };

  const response = await handleRuntimeEventsRequest(
    request({ events: [event({ type: "search", query: "q", origin: "agent" })] }),
    deps,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(logged, ["ingest drain schedule failed"]);
});

test("without the fold deps the handler behaves exactly as before", async () => {
  const { deps, inserted } = makeDeps();

  const response = await handleRuntimeEventsRequest(
    request({ events: [event({ type: "search", query: "q", origin: "agent" })] }),
    deps,
  );

  assert.equal(response.status, 202);
  assert.equal(inserted.length, 1);
});
