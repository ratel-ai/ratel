import assert from "node:assert/strict";
import { test } from "node:test";
import protobuf from "protobufjs";
import type { NewOtelLog } from "@/lib/ingest/otlp/schema";
import { chunkedCountingBody } from "@/lib/platform/http/test-support";
import type { ApiKey } from "@/lib/platform/projects/schema";
import {
  handleLogsRequest,
  type LogsHandlerDeps,
  MAX_BODY_BYTES,
  MAX_LOG_RECORDS,
} from "./logs-route-handler";
import descriptor from "./proto/otlp-logs.descriptor.json";

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
const ProtoRequestType = protoRoot.lookupType("ratel.otlp.ExportLogsServiceRequest");

function makeDeps(overrides: Partial<LogsHandlerDeps> = {}): LogsHandlerDeps {
  return {
    isDbConfigured: () => true,
    hashApiKey: (key) => `hashed:${key}`,
    findActiveApiKeyByHash: async () => FAKE_KEY,
    touchApiKey: async () => {},
    insertOtelLogs: async (_projectId, rows) => ({ accepted: rows.length }),
    // Rejections are sampled in production; default the gate open so rejection-path
    // tests emit deterministically (the sampler itself is covered in
    // ingest-observability.test.ts). Individual tests can still override.
    shouldSampleRejection: () => true,
    logError: () => {},
    logWarn: () => {},
    ...overrides,
  };
}

function request(
  body: string | Uint8Array = JSON.stringify({ resourceLogs: [] }),
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/v1/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body as BodyInit,
  });
}

function otlpLogsJson(eventNames: string[]): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "test-agent" } }],
        },
        scopeLogs: [
          {
            scope: { name: "@ratel-ai/sdk" },
            logRecords: eventNames.map((eventName, index) => ({
              timeUnixNano: `175180000000000${index.toString().padStart(4, "0")}`,
              eventName,
              attributes: [
                {
                  key: "ratel.experiment.id",
                  value: { stringValue: "search-ranking-v2" },
                },
              ],
            })),
          },
        ],
      },
    ],
  });
}

function otlpLogsProto(eventNames: string[]): Uint8Array {
  const payload = JSON.parse(otlpLogsJson(eventNames));
  return ProtoRequestType.encode(ProtoRequestType.fromObject(payload)).finish();
}

test("missing Authorization returns 401", async () => {
  const response = await handleLogsRequest(request(), makeDeps());

  assert.equal(response.status, 401);
});

test("stamps project and org onto the request log context", async () => {
  const contexts: unknown[][] = [];
  const deps = makeDeps({
    getOrganizationByProjectId: async () => ({ id: "org-1" }) as never,
    setRequestLogContext: (...args) => contexts.push(args),
  });

  const response = await handleLogsRequest(
    request(otlpLogsJson(["evt"]), { Authorization: "Bearer rtl_testkey" }),
    deps,
  );

  assert.equal(response.status, 202);
  assert.equal(contexts.length, 1);
  assert.deepEqual(contexts[0]?.[1], { project_id: "proj-1", org_id: "org-1" });
});

test("unsupported Content-Type returns 415", async () => {
  const response = await handleLogsRequest(
    request("not OTLP", {
      Authorization: "Bearer rtl_testkey",
      "Content-Type": "text/plain",
    }),
    makeDeps(),
  );

  assert.equal(response.status, 415);
});

test("oversized declared body returns 413", async () => {
  const response = await handleLogsRequest(
    request(undefined, {
      Authorization: "Bearer rtl_testkey",
      "Content-Length": String(MAX_BODY_BYTES + 1),
    }),
    makeDeps(),
  );

  assert.equal(response.status, 413);
});

test("unconfigured database returns 503", async () => {
  const response = await handleLogsRequest(
    request(undefined, { Authorization: "Bearer rtl_testkey" }),
    makeDeps({ isDbConfigured: () => false }),
  );

  assert.equal(response.status, 503);
});

test("invalid or revoked API key returns 401", async () => {
  const response = await handleLogsRequest(
    request(undefined, { Authorization: "Bearer rtl_revoked" }),
    makeDeps({ findActiveApiKeyByHash: async () => null }),
  );

  assert.equal(response.status, 401);
});

test("does not gate log ingest on the monthly event quota", async () => {
  // Retained logs are quota-free telemetry (raw-span-tap sibling), so an org
  // resolved only for request-log context must never introduce a monthly-cap 429.
  const response = await handleLogsRequest(
    request(otlpLogsJson(["ratel.experiment.outcome"]), {
      Authorization: "Bearer rtl_testkey",
    }),
    makeDeps({
      findActiveApiKeyByHash: async () => ({
        ...FAKE_KEY,
        projectId: "proj-log-quota-free",
      }),
      getOrganizationByProjectId: async () =>
        ({
          id: "org-1",
          slug: "ratel",
          plan: "free",
          planOverride: "pro",
          subscriptionStatus: "canceled",
        }) as never,
    }),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: 1,
    records: 1,
    dropped: 0,
  });
});

test("oversized buffered body returns 413", async () => {
  const response = await handleLogsRequest(
    request("x".repeat(MAX_BODY_BYTES + 1), {
      Authorization: "Bearer rtl_testkey",
    }),
    makeDeps(),
  );

  assert.equal(response.status, 413);
});

test("chunked over-cap body with no content-length returns 413 without full buffering", async () => {
  const MiB = 1024 * 1024;
  let inserts = 0;
  const { stream, counters } = chunkedCountingBody({ chunkBytes: MiB, totalBytes: 8 * MiB });
  const chunked = new Request("http://localhost/api/v1/logs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer rtl_testkey",
    },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const response = await handleLogsRequest(
    chunked,
    makeDeps({
      insertOtelLogs: async (_projectId, rows) => {
        inserts += 1;
        return { accepted: rows.length };
      },
    }),
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: `Request body too large (max ${MAX_BODY_BYTES} bytes).`,
  });
  assert.ok(
    counters.enqueuedBytes <= MAX_BODY_BYTES + 2 * MiB,
    `handler should stop pulling near the cap; enqueued ${counters.enqueuedBytes} bytes`,
  );
  assert.equal(inserts, 0);
});

test("malformed OTLP payload returns 400", async () => {
  const response = await handleLogsRequest(
    request("{not json", { Authorization: "Bearer rtl_testkey" }),
    makeDeps(),
  );

  assert.equal(response.status, 400);
});

test("more than the maximum log records returns 413", async () => {
  const response = await handleLogsRequest(
    request(
      otlpLogsJson(Array.from({ length: MAX_LOG_RECORDS + 1 }, () => "ratel.experiment.outcome")),
      { Authorization: "Bearer rtl_testkey" },
    ),
    makeDeps(),
  );

  assert.equal(response.status, 413);
});

test("seven lifecycle events persist while a host log is counted as dropped", async () => {
  const inserted: NewOtelLog[][] = [];
  const eventNames = [
    "ratel.experiment.results",
    "ratel.experiment.comparison",
    "ratel.experiment.skip",
    "ratel.experiment.fallback",
    "ratel.experiment.drop",
    "ratel.experiment.invocation",
    "ratel.experiment.outcome",
    "host.application.log",
  ];
  const response = await handleLogsRequest(
    request(otlpLogsJson(eventNames), {
      Authorization: "Bearer rtl_testkey",
    }),
    makeDeps({
      insertOtelLogs: async (_projectId, rows) => {
        inserted.push(rows);
        return { accepted: rows.length };
      },
    }),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: 7,
    records: 8,
    dropped: 1,
  });
  assert.equal(inserted.length, 1);
  assert.deepEqual(
    inserted[0].map((row) => [row.projectId, row.eventName]),
    eventNames.slice(0, 7).map((name) => ["proj-1", name]),
  );
});

test("a protobuf log export returns an empty protobuf success with count headers", async () => {
  const response = await handleLogsRequest(
    request(otlpLogsProto(["ratel.experiment.outcome", "host.application.log"]), {
      Authorization: "Bearer rtl_testkey",
      "Content-Type": "application/x-protobuf",
    }),
    makeDeps(),
  );

  assert.equal(response.status, 202);
  assert.equal(response.headers.get("content-type"), "application/x-protobuf");
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.equal(response.headers.get("x-ratel-accepted"), "1");
  assert.equal(response.headers.get("x-ratel-records"), "2");
  assert.equal(response.headers.get("x-ratel-dropped"), "1");
});

test("an OTLP/JSON log export keeps its envelope and gains count headers", async () => {
  const response = await handleLogsRequest(
    request(otlpLogsJson(["ratel.experiment.outcome", "host.application.log"]), {
      Authorization: "Bearer rtl_testkey",
    }),
    makeDeps(),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: 1, records: 2, dropped: 1 });
  assert.equal(response.headers.get("x-ratel-accepted"), "1");
  assert.equal(response.headers.get("x-ratel-records"), "2");
  assert.equal(response.headers.get("x-ratel-dropped"), "1");
});

test("insert failure returns 500 and reports the exception through the telemetry shim", async () => {
  const insertError = new Error("database unavailable");
  const captured: Array<{
    error: unknown;
    distinctId: string;
    properties: Record<string, unknown>;
  }> = [];
  const response = await handleLogsRequest(
    request(otlpLogsJson(["ratel.experiment.outcome"]), {
      Authorization: "Bearer rtl_testkey",
    }),
    makeDeps({
      insertOtelLogs: async () => {
        throw insertError;
      },
      reportServerException: (error, distinctId, properties) => {
        captured.push({ error, distinctId, properties });
      },
    }),
  );

  assert.equal(response.status, 500);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.error, insertError);
  assert.equal(captured[0]?.distinctId, "project:proj-1");
  assert.equal(captured[0]?.properties?.endpoint, "/v1/logs");
  assert.equal(captured[0]?.properties?.project_id, "proj-1");
});

test("telemetry capture failure does not replace the insert-failure response", async () => {
  const response = await handleLogsRequest(
    request(otlpLogsJson(["ratel.experiment.outcome"]), {
      Authorization: "Bearer rtl_testkey",
    }),
    makeDeps({
      insertOtelLogs: async () => {
        throw new Error("database unavailable");
      },
      reportServerException: () => {
        throw new Error("telemetry unavailable");
      },
    }),
  );

  assert.equal(response.status, 500);
});

test("touchApiKey failure does not downgrade successful ingest", async () => {
  const response = await handleLogsRequest(
    request(otlpLogsJson(["ratel.experiment.outcome"]), {
      Authorization: "Bearer rtl_testkey",
    }),
    makeDeps({
      touchApiKey: async () => {
        throw new Error("touch failed");
      },
    }),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: 1,
    records: 1,
    dropped: 0,
  });
});

test("invalid log API keys emit a rejection with timing", async () => {
  const warnings: unknown[][] = [];
  const events: Array<{
    event: string;
    context: Record<string, unknown>;
    properties: Record<string, unknown>;
  }> = [];
  let now = 1_000;

  const response = await handleLogsRequest(
    request(undefined, { Authorization: "Bearer rtl_revoked" }),
    makeDeps({
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
    }),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(events, [
    {
      event: "otlp_ingest_request",
      context: { distinctId: "otlp:anonymous" },
      properties: {
        endpoint: "/v1/logs",
        outcome: "rejected",
        reason: "invalid_key",
        status: 401,
        duration_ms: 25,
      },
    },
  ]);
  assert.equal(warnings.length, 1);
});

test("log rejections classify every response path", async () => {
  const cases: Array<{
    name: string;
    expected: [number, string, string];
    run: (track: NonNullable<LogsHandlerDeps["trackServerEvent"]>) => Promise<Response>;
  }> = [
    {
      name: "missing auth",
      expected: [401, "invalid_key", "anonymous"],
      run: (trackServerEvent) => handleLogsRequest(request(), makeDeps({ trackServerEvent })),
    },
    {
      name: "unsupported media",
      expected: [415, "unsupported_media", "anonymous"],
      run: (trackServerEvent) =>
        handleLogsRequest(
          request("not OTLP", {
            Authorization: "Bearer rtl_testkey",
            "Content-Type": "text/plain",
          }),
          makeDeps({ trackServerEvent }),
        ),
    },
    {
      name: "declared oversized",
      expected: [413, "oversized", "anonymous"],
      run: (trackServerEvent) =>
        handleLogsRequest(
          request(undefined, {
            Authorization: "Bearer rtl_testkey",
            "Content-Length": String(MAX_BODY_BYTES + 1),
          }),
          makeDeps({ trackServerEvent }),
        ),
    },
    {
      name: "database unavailable",
      expected: [503, "unavailable", "anonymous"],
      run: (trackServerEvent) =>
        handleLogsRequest(
          request(undefined, { Authorization: "Bearer rtl_testkey" }),
          makeDeps({
            trackServerEvent,
            isDbConfigured: () => false,
          }),
        ),
    },
    {
      name: "buffered oversized",
      expected: [413, "oversized", "project"],
      run: (trackServerEvent) =>
        handleLogsRequest(
          request("x".repeat(MAX_BODY_BYTES + 1), {
            Authorization: "Bearer rtl_testkey",
          }),
          makeDeps({ trackServerEvent }),
        ),
    },
    {
      name: "malformed payload",
      expected: [400, "malformed", "project"],
      run: (trackServerEvent) =>
        handleLogsRequest(
          request("{not json", { Authorization: "Bearer rtl_testkey" }),
          makeDeps({ trackServerEvent }),
        ),
    },
    {
      name: "decoded oversized",
      expected: [413, "oversized", "project"],
      run: (trackServerEvent) =>
        handleLogsRequest(
          request(
            otlpLogsJson(
              Array.from({ length: MAX_LOG_RECORDS + 1 }, () => "ratel.experiment.outcome"),
            ),
            { Authorization: "Bearer rtl_testkey" },
          ),
          makeDeps({ trackServerEvent }),
        ),
    },
    {
      name: "storage failure",
      expected: [500, "storage", "project"],
      run: (trackServerEvent) =>
        handleLogsRequest(
          request(otlpLogsJson(["ratel.experiment.outcome"]), {
            Authorization: "Bearer rtl_testkey",
          }),
          makeDeps({
            trackServerEvent,
            insertOtelLogs: async () => {
              throw new Error("db down");
            },
          }),
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
    assert.equal(events[0].properties.endpoint, "/v1/logs", rejection.name);
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

test("accepted log events follow the injected success sampler", async () => {
  const events: Array<{
    event: string;
    context: Record<string, unknown>;
    properties: Record<string, unknown>;
  }> = [];
  let sampled = false;
  const deps = makeDeps({
    shouldSampleSuccess: () => sampled,
    trackServerEvent: async (event, context, properties) => {
      events.push({ event, context, properties: properties ?? {} });
    },
    now: () => new Date(1_000),
  });
  const makeRequest = () =>
    request(otlpLogsJson(["ratel.experiment.outcome", "host.application.log"]), {
      Authorization: "Bearer rtl_testkey",
    });

  assert.equal((await handleLogsRequest(makeRequest(), deps)).status, 202);
  assert.deepEqual(events, []);

  sampled = true;
  assert.equal((await handleLogsRequest(makeRequest(), deps)).status, 202);
  assert.deepEqual(events, [
    {
      event: "otlp_ingest_request",
      context: { projectId: "proj-1" },
      properties: {
        endpoint: "/v1/logs",
        outcome: "accepted",
        status: 202,
        duration_ms: 0,
        accepted: 1,
        records: 2,
        dropped: 1,
      },
    },
  ]);
});
