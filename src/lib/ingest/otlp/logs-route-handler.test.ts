import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import protobuf from "protobufjs";
import { decodeOtlpLogs } from "@/lib/ingest/otlp/decode-logs";
import type { NewOtelLog } from "@/lib/ingest/otlp/schema";
import type { OtlpRawCaptureDeps } from "@/lib/ingest/otlp-raw/capture";
import {
  compressForStorage,
  type OtlpRawExportInput,
  type OtlpRawStore,
} from "@/lib/ingest/otlp-raw/domain";
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
  scopes: ["*"],
  rateLimitPerMinute: null,
  createdBy: null,
};

const protoRoot = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);
const ProtoRequestType = protoRoot.lookupType("ratel.otlp.ExportLogsServiceRequest");

function makeDeps(overrides: Partial<LogsHandlerDeps> = {}): LogsHandlerDeps {
  return {
    scope: "ingest:logs",
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

function rawCapture(store?: OtlpRawStore["store"]) {
  const stored: OtlpRawExportInput[] = [];
  const capture: OtlpRawCaptureDeps = {
    store: {
      store:
        store ??
        (async (input) => {
          stored.push(input);
          return { stored: true, id: "raw-1", rawBytes: input.body.byteLength, storedBytes: 1 };
        }),
    },
  };
  return { capture, stored };
}

const LIFECYCLE = ["ratel.experiment.results", "ratel.experiment.skip"];

test("raw capture on: one stored export whose body decodes back to the same records", async () => {
  const { capture, stored } = rawCapture();
  const body = otlpLogsProto(LIFECYCLE);
  const response = await handleLogsRequest(
    request(body, { Authorization: "Bearer rtl_test", "Content-Type": "application/x-protobuf" }),
    makeDeps({ otlpRawCapture: capture }),
  );
  assert.equal(response.status, 202);
  assert.equal(stored.length, 1);
  const [raw] = stored;
  assert.equal(raw.signal, "logs");
  assert.equal(raw.contentType, "application/x-protobuf");
  assert.equal(raw.itemCount, 2);
  assert.deepEqual(
    decodeOtlpLogs("application/x-protobuf", gunzipSync(compressForStorage(raw))).map(
      (r) => r.eventName,
    ),
    LIFECYCLE,
  );
});

test("a throwing raw store still returns the same log response", async () => {
  const logged: string[] = [];
  const { capture } = rawCapture(async () => {
    throw new Error("raw store down");
  });
  const response = await handleLogsRequest(
    request(otlpLogsJson(LIFECYCLE), { Authorization: "Bearer rtl_test" }),
    makeDeps({ otlpRawCapture: capture, logError: (message) => logged.push(message) }),
  );
  const baseline = await handleLogsRequest(
    request(otlpLogsJson(LIFECYCLE), { Authorization: "Bearer rtl_test" }),
    makeDeps(),
  );
  assert.equal(response.status, baseline.status);
  assert.deepEqual(await response.json(), await baseline.json());
  assert.deepEqual(logged, ["otlp raw capture failed"]);
});

function genAiLogsJson(): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "test-agent" } }] },
        scopeLogs: [
          {
            scope: { name: "opentelemetry.instrumentation.openai" },
            logRecords: [
              {
                timeUnixNano: "1751800000000000000",
                eventName: "gen_ai.client.inference.operation.details",
                traceId: "0123456789abcdef0123456789abcdef",
                spanId: "0123456789abcdef",
                attributes: [
                  { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                  {
                    key: "gen_ai.input.messages",
                    value: {
                      stringValue: '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]',
                    },
                  },
                ],
              },
              { timeUnixNano: "1751800000000000001", eventName: "host.application.started" },
            ],
          },
        ],
      },
    ],
  });
}

test("a gzip body is inflated and accepted like an identity body", async () => {
  const body = otlpLogsJson(LIFECYCLE);
  const plain = await handleLogsRequest(
    request(body, { Authorization: "Bearer rtl_test" }),
    makeDeps(),
  );
  const gzipped = await handleLogsRequest(
    request(gzipSync(body), { Authorization: "Bearer rtl_test", "Content-Encoding": "gzip" }),
    makeDeps(),
  );
  assert.equal(gzipped.status, plain.status);
  assert.deepEqual(await gzipped.json(), await plain.json());
});

test("a corrupt gzip body returns 400 and an unknown encoding 415", async () => {
  const corrupt = await handleLogsRequest(
    request("not gzip", { Authorization: "Bearer rtl_test", "Content-Encoding": "gzip" }),
    makeDeps(),
  );
  const unknown = await handleLogsRequest(
    request(otlpLogsJson(LIFECYCLE), {
      Authorization: "Bearer rtl_test",
      "Content-Encoding": "br",
    }),
    makeDeps(),
  );
  assert.equal(corrupt.status, 400);
  assert.equal(unknown.status, 415);
});

test("raw capture of a gzip export keeps the inflated body and the sent gzip", async () => {
  const { capture, stored } = rawCapture();
  const sent = gzipSync(otlpLogsJson(LIFECYCLE));
  await handleLogsRequest(
    request(sent, { Authorization: "Bearer rtl_test", "Content-Encoding": "gzip" }),
    makeDeps({ otlpRawCapture: capture }),
  );
  assert.equal(stored.length, 1);
  assert.equal(new TextDecoder().decode(stored[0].body), otlpLogsJson(LIFECYCLE));
  assert.deepEqual(stored[0].gzipped, new Uint8Array(sent));
});

test("with FF_INGEST_STRIP_CLIENT_ADDRESS on, raw capture of a log export keeps no client IP address", async () => {
  const { capture, stored } = rawCapture();
  const payload = JSON.parse(otlpLogsJson(LIFECYCLE));
  payload.resourceLogs[0].resource.attributes.push({
    key: "host.ip",
    value: { stringValue: "192.0.2.10" },
  });
  payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.push({
    key: "client.address",
    value: { stringValue: "203.0.113.7" },
  });
  const sent = gzipSync(JSON.stringify(payload));
  const response = await handleLogsRequest(
    request(sent, { Authorization: "Bearer rtl_test", "Content-Encoding": "gzip" }),
    makeDeps({ otlpRawCapture: capture, stripClientAddresses: () => true }),
  );
  assert.equal(response.status, 202);
  assert.equal(stored.length, 1);
  const kept = gunzipSync(compressForStorage(stored[0])).toString("utf8");
  assert.doesNotMatch(kept, /192\.0\.2\.10|203\.0\.113\.7|host\.ip|client\.address/);
  assert.equal(stored[0].itemCount, 2);
  assert.equal(stored[0].gzipped, undefined);
});

test("with the strip off (the default), a log export is captured as sent", async () => {
  const { capture, stored } = rawCapture();
  const payload = JSON.parse(otlpLogsJson(LIFECYCLE));
  payload.resourceLogs[0].resource.attributes.push({
    key: "host.ip",
    value: { stringValue: "192.0.2.10" },
  });
  const response = await handleLogsRequest(
    request(JSON.stringify(payload), { Authorization: "Bearer rtl_test" }),
    makeDeps({ otlpRawCapture: capture }),
  );
  assert.equal(response.status, 202);
  assert.match(new TextDecoder().decode(stored[0].body), /192\.0\.2\.10/);
});

test("gen_ai details records are stored with ids and content", async () => {
  const inserted: unknown[] = [];
  const response = await handleLogsRequest(
    request(genAiLogsJson(), { Authorization: "Bearer rtl_test" }),
    makeDeps({
      getOrganizationByProjectId: async () => ({ id: "org-1" }) as never,
      insertOtelLogs: async (_projectId, rows) => {
        inserted.push(...rows);
        return { accepted: rows.length };
      },
    }),
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: 1, records: 2, dropped: 1 });
  const [row] = inserted as NewOtelLog[];
  assert.equal(row.eventName, "gen_ai.client.inference.operation.details");
  assert.equal(row.traceId, "0123456789abcdef0123456789abcdef");
  assert.equal(row.spanId, "0123456789abcdef");
  assert.equal(
    (row.attributes as Record<string, unknown>)["gen_ai.input.messages"],
    '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]',
  );
});

// RC-585: scoped keys on log ingest.

test("an ingest-only key sends logs; a key without ingest:logs gets 403", async () => {
  const ingest = makeDeps({
    findActiveApiKeyByHash: async () => ({
      ...FAKE_KEY,
      keyPrefix: "rtl_pub_abcdefgh",
      scopes: ["ingest:traces", "ingest:logs", "ingest:events"],
    }),
  });
  const accepted = await handleLogsRequest(
    request(otlpLogsJson(["evt"]), { Authorization: "Bearer rtl_pub_x" }),
    ingest,
  );
  assert.equal(accepted.status, 202);

  const readOnly = makeDeps({
    findActiveApiKeyByHash: async () => ({ ...FAKE_KEY, scopes: ["catalog:read"] }),
  });
  const refused = await handleLogsRequest(
    request(otlpLogsJson(["evt"]), { Authorization: "Bearer rtl_x" }),
    readOnly,
  );
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).scope, "ingest:logs");
});

test("an ingest-only key over its shared-key budget gets 429 with Retry-After", async () => {
  const deps = makeDeps({
    findActiveApiKeyByHash: async () => ({ ...FAKE_KEY, scopes: ["ingest:logs"] }),
    publishableLimits: {
      check: () => ({ allowed: false, retryAfterSeconds: 3, limit: "per_key" }),
      chargeItems: () => ({ allowed: true as const }),
    },
  });
  const response = await handleLogsRequest(
    request(otlpLogsJson(["evt"]), { Authorization: "Bearer rtl_pub_x" }),
    deps,
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "3");
});

// RC-590: an ingest-only key's logs are kept and change nothing else.

function attr(key: string, value: unknown) {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (Array.isArray(value)) return { key, value: { arrayValue: { values: [] } } };
  return { key, value: { stringValue: String(value) } };
}

function catalogAndGenAiLogs(): string {
  return JSON.stringify({
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1751800000000000000",
                eventName: "ratel.catalog.definition",
                attributes: Object.entries({
                  "ratel.catalog.kind": "tool",
                  "ratel.catalog.id": "send_invoice",
                  "ratel.catalog.name": "send_invoice",
                  "ratel.catalog.description": "Forged description",
                  "ratel.catalog.tags": [],
                  "ratel.catalog.input_schema": "true",
                  "ratel.catalog.output_schema": "true",
                  "ratel.catalog.searchable_description": "Forged description",
                  "ratel.catalog.searchable_description_overridden": false,
                  "ratel.catalog.content_hash": "b".repeat(64),
                }).map(([key, value]) => attr(key, value)),
              },
              {
                timeUnixNano: "1751800000000000001",
                eventName: "gen_ai.user.message",
                traceId: "0af7651916cd43dd8448eb211c80319c",
                spanId: "b7ad6b7169203331",
                body: { stringValue: "forged content" },
              },
            ],
          },
        ],
      },
    ],
  });
}

function recordingDeps(scopes: string[]) {
  const stored: Array<Array<{ catalogDefinition?: unknown }>> = [];
  const storeCalls: string[] = [];
  const store = new Proxy({} as never, {
    get: (_target, property) => async () => {
      storeCalls.push(String(property));
      return [];
    },
  });
  const deps = makeDeps({
    findActiveApiKeyByHash: async () => ({ ...FAKE_KEY, scopes }),
    insertOtelLogs: async (_projectId, rows) => {
      stored.push(rows);
      return { accepted: rows.length };
    },
    genAiLogJoin: { store },
  });
  return { deps, stored, storeCalls };
}

test("an ingest-only key's catalog definitions are stored as logs but never rewrite the runtime catalog", async () => {
  const full = recordingDeps(["*"]);
  await handleLogsRequest(
    request(catalogAndGenAiLogs(), { Authorization: "Bearer rtl_x" }),
    full.deps,
  );
  assert.ok(
    full.stored[0]?.some((row) => row.catalogDefinition),
    "a Full key upserts the definition",
  );

  const ingest = recordingDeps(["ingest:traces", "ingest:logs", "ingest:events"]);
  const response = await handleLogsRequest(
    request(catalogAndGenAiLogs(), { Authorization: "Bearer rtl_pub_x" }),
    ingest.deps,
  );
  assert.equal(response.status, 202);
  assert.equal(ingest.stored[0]?.length, 2, "both records are kept");
  assert.ok(
    ingest.stored[0]?.every((row) => !row.catalogDefinition),
    "no definition reaches the runtime catalog",
  );
});

test("an ingest-only key's gen_ai logs never restate a stored model call", async () => {
  const full = recordingDeps(["*"]);
  await handleLogsRequest(
    request(catalogAndGenAiLogs(), { Authorization: "Bearer rtl_x" }),
    full.deps,
  );
  assert.ok(full.storeCalls.includes("findSpans"), "a Full key looks for the calls to restate");

  const ingest = recordingDeps(["ingest:logs"]);
  await handleLogsRequest(
    request(catalogAndGenAiLogs(), { Authorization: "Bearer rtl_pub_x" }),
    ingest.deps,
  );
  assert.deepEqual(ingest.storeCalls, []);
});

test("a stored log export logs its record counts by project and org", async () => {
  const lines: Array<[string, Record<string, unknown>]> = [];
  const response = await handleLogsRequest(
    request(otlpLogsJson(["ratel.experiment.results", "host.application.log"]), {
      Authorization: "Bearer rtl_testkey",
    }),
    makeDeps({
      ingestLog: {
        sink: { info: (fields, message) => lines.push([message, fields]) },
        lookupLabels: async () => ({
          org_id: "org-1",
          org_slug: "acme",
          project_path: "acme/agent",
        }),
      },
    }),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(lines, [
    [
      "otlp_logs_ingested",
      {
        project_id: "proj-1",
        org_id: "org-1",
        org_slug: "acme",
        project_path: "acme/agent",
        records: 2,
        accepted: 1,
        dropped: 1,
      },
    ],
  ]);
});
