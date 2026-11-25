import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { decodeOtlp } from "@/lib/ingest/otlp/decode";
import { handleTracesRequest } from "@/lib/ingest/otlp/route-handler";
import { listDeadLetters } from "@/lib/ingest/queue/postgres/store";
import { loadFixture } from "@/lib/ledger/turns/real-fixtures";
import {
  acceptOnto,
  type Deployment,
  drain,
  dumpTables,
  envelopeHandler,
  type IngestBody,
  ingestRequest,
  ingestTraces,
  ORGANIZATION_ID,
  PROJECT_ID,
  SECRET_KEY_ID,
  setupDeployment,
  spoolQueue,
  tracesRouteDeps,
} from "./test-support";

const REAL = join(import.meta.dirname, "../otlp/__fixtures__/real");
const FIXTURES = readdirSync(REAL, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map(({ name }) => name);

async function queued(
  bodies: readonly IngestBody[],
  over: Parameters<typeof envelopeHandler>[1] = {},
): Promise<Deployment> {
  const deployment = await setupDeployment();
  const queue = spoolQueue(deployment);
  await ingestTraces(deployment, bodies, acceptOnto(queue));
  await drain(queue, envelopeHandler(deployment, over), bodies.length);
  return deployment;
}

test("the real fixtures: a queued deployment stores the same rows as a direct one", async () => {
  assert.ok(FIXTURES.length >= 18);
  for (const name of FIXTURES) {
    const bodies = loadFixture(name);
    const direct = await setupDeployment();
    await ingestTraces(direct, bodies);
    const other = await queued(bodies);

    const expected = await dumpTables(direct);
    assert.ok(expected.otel_spans.length > 0, name);
    assert.deepEqual(await dumpTables(other), expected, name);
    await Promise.all([direct.client.close(), other.client.close()]);
  }
});

test("a gzip body is stored as it came, and the queued answers hold no counts", async () => {
  const [body] = loadFixture("vercel-ai");
  const gzipped = {
    ...body,
    bytes: new Uint8Array(gzipSync(body.bytes)),
    contentEncoding: "x-gzip",
  };
  const deployment = await setupDeployment();
  const queue = spoolQueue(deployment);
  const response = await handleTracesRequest(
    ingestRequest("traces", gzipped),
    tracesRouteDeps(deployment, { accept: acceptOnto(queue) }),
  );
  assert.equal(response.status, 202);
  const protobuf = body.contentType === "application/x-protobuf";
  assert.equal(response.headers.get("content-type"), body.contentType);
  assert.equal(await response.text(), protobuf ? "" : "{}");
  assert.deepEqual(
    [...response.headers.keys()].filter((name) => name.startsWith("x-ratel")),
    [],
  );
  const { rows } = await deployment.client.query<{ n: number }>(
    "select count(*)::int as n from events",
  );
  assert.equal(rows[0].n, 0, "nothing is stored in the request");

  await drain(queue, envelopeHandler(deployment), 1);
  const raw = await deployment.client.query<{ id: string; body: Uint8Array }>(
    "select id, body from otlp_raw_exports",
  );
  assert.deepEqual(Buffer.from(raw.rows[0].body), Buffer.from(gzipped.bytes));
  await deployment.client.close();
});

test("a storage failure is retried by the queue, and the client never sees it", async () => {
  const [body] = loadFixture("vercel-ai");
  let failures = 2;
  const deployment = await setupDeployment();
  const queue = spoolQueue(deployment);
  await ingestTraces(deployment, [body], acceptOnto(queue));

  const real = tracesRouteDeps(deployment).insertOtelSpans;
  const settled = await drain(
    queue,
    envelopeHandler(deployment, {
      traces: {
        insertOtelSpans: async (...args) => {
          if (failures-- > 0) throw Object.assign(new Error("prompt text"), { code: "40001" });
          return real(...args);
        },
      },
    }),
    3,
  );
  assert.deepEqual(
    settled.map(({ outcome, reason, attempt }) => [outcome, reason, attempt]),
    [
      ["retry", "uncaught Error (40001)", 1],
      ["retry", "uncaught Error (40001)", 2],
      ["ack", null, 3],
    ],
  );
  const direct = await setupDeployment();
  await ingestTraces(direct, [body]);
  // The dump holds the usage counter: the first delivery's events count once.
  assert.deepEqual(await dumpTables(deployment), await dumpTables(direct));
  await Promise.all([deployment.client.close(), direct.client.close()]);
});

test("a store that is down is an outage: no delivery counts and nothing is dead-lettered", async () => {
  const [body] = loadFixture("vercel-ai");
  let failures = 8;
  const deployment = await setupDeployment();
  const queue = spoolQueue(deployment);
  await ingestTraces(deployment, [body], acceptOnto(queue));
  const real = tracesRouteDeps(deployment).insertEventsWithMetrics;
  const settled = await drain(
    queue,
    envelopeHandler(deployment, {
      traces: {
        insertEventsWithMetrics: async (...args) => {
          const cause = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
          if (failures-- > 0) throw new Error("Failed query", { cause });
          return real(...args);
        },
      },
    }),
    9,
  );
  assert.deepEqual(
    settled.map(({ outcome, attempt }) => `${outcome} ${attempt}`),
    [...Array(8).fill("outage 1"), "ack 1"],
  );
  await deployment.client.close();
});

test("a body that can never be stored is a dead letter whose reason quotes nothing of it", async () => {
  const text = (value: string) => new TextEncoder().encode(value);
  const tooMany = JSON.stringify({
    resourceSpans: [{ scopeSpans: [{ spans: Array(5_001).fill({}) }] }],
  });
  const bodies: IngestBody[] = [
    { contentType: "application/json", bytes: text("secret prompt") },
    { contentType: "application/json", bytes: text('{"resourceSpans":{"secret":1}}') },
    { contentType: "application/x-protobuf", bytes: Uint8Array.from([0x0a, 0xff, 0x01]) },
    { contentType: "application/json", bytes: text("not gzip"), contentEncoding: "gzip" },
    { contentType: "application/json", bytes: text(tooMany) },
    {
      contentType: "application/json",
      bytes: new Uint8Array(gzipSync(Buffer.alloc(16_000_001, " "))),
      contentEncoding: "gzip",
    },
  ];
  const deployment = await queued(bodies);
  const letters = await listDeadLetters(deployment.db);
  assert.deepEqual(letters.map(({ reason }) => reason).sort(), [
    "body does not decode as OTLP traces",
    "body does not decode as OTLP traces",
    "body does not decode as OTLP traces",
    "body has 5001 spans (max 5000)",
    "body is not valid gzip",
    "body is over 16000000 bytes decompressed",
  ]);
  assert.ok(letters.every(({ deliveries }) => deliveries === 1));
  await deployment.client.close();
});

test("a project that does not exist is a dead letter", async () => {
  const deployment = await setupDeployment();
  const handler = envelopeHandler(deployment);
  const queue = {
    publish: async (envelope: Parameters<typeof handler>[0]) => {
      const result = await handler({ ...envelope, projectId: ORGANIZATION_ID }, { attempt: 1 });
      assert.deepEqual(result, { outcome: "dead-letter", reason: "project does not exist" });
    },
  };
  await ingestTraces(deployment, [loadFixture("vercel-ai")[0]], acceptOnto(queue));
  await deployment.client.close();
});

test("refused and dropped traces are final: acknowledged, logged, not stored", async () => {
  const [body] = loadFixture("vercel-ai");
  const spans = decodeOtlp(body.contentType, body.bytes);
  for (const outcome of ["refused", "dropped"] as const) {
    const deployment = await setupDeployment();
    const queue = spoolQueue(deployment);
    await ingestTraces(deployment, [body], acceptOnto(queue));
    const [settled] = await drain(
      queue,
      envelopeHandler(deployment, {
        traces: {
          traceMetering: {
            isMetered: async () => true,
            meterTraceBatch: async (_scope, byTrace) =>
              new Map([...byTrace.keys()].map((traceId) => [traceId, outcome])),
          },
        },
      }),
      1,
    );
    assert.equal(settled.outcome, "ack");
    const line = deployment.logs.find(({ message }) => message === "trace meter kept spans out");
    assert.equal(line?.fields?.[outcome], spans.length);
    assert.deepEqual((await dumpTables(deployment)).otel_spans, []);
    await deployment.client.close();
  }
});

test("the last use of a key is when accept took the request, and never moves back", async () => {
  const [body] = loadFixture("vercel-ai");
  const deployment = await setupDeployment();
  const queue = spoolQueue(deployment);
  const tracked: string[] = [];
  const at = (iso: string) => ({ now: () => new Date(iso), accept: acceptOnto(queue) });
  for (const iso of ["2026-11-20T10:00:00Z", "2026-11-19T10:00:00Z"]) {
    await handleTracesRequest(ingestRequest("traces", body), tracesRouteDeps(deployment, at(iso)));
  }
  await drain(
    queue,
    envelopeHandler(deployment, {
      traces: {
        trackServerEvent: (async (event: string) => {
          tracked.push(event);
        }) as never,
      },
    }),
    2,
  );
  const { rows } = await deployment.client.query<{ at: Date }>(
    `select last_used_at as at from api_keys where id = '${SECRET_KEY_ID}'`,
  );
  assert.equal(rows[0].at.toISOString(), "2026-11-20T10:00:00.000Z");
  assert.deepEqual(tracked, ["first_trace_received"]);
  await deployment.client.close();
});

test("a span without a usable time takes the time of accept in every table", async () => {
  const body = {
    contentType: "application/json",
    bytes: new TextEncoder().encode(
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "0af7651916cd43dd8448eb211c80319c",
                    spanId: "b7ad6b7169203331",
                    name: "chat",
                    startTimeUnixNano: "0",
                    endTimeUnixNano: "0",
                    attributes: [
                      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                      { key: "gen_ai.request.model", value: { stringValue: "gpt-5.5" } },
                      { key: "gen_ai.usage.input_tokens", value: { intValue: "10" } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ),
  };
  const deployment = await setupDeployment();
  const queue = spoolQueue(deployment);
  await handleTracesRequest(
    ingestRequest("traces", body),
    tracesRouteDeps(deployment, {
      now: () => new Date("2026-11-20T10:00:00Z"),
      accept: acceptOnto(queue),
    }),
  );
  await drain(queue, envelopeHandler(deployment), 1);
  const { rows } = await deployment.client.query<{ at: Date }>(`
    select occurred_at as at from events where project_id = '${PROJECT_ID}'
    union all select event_time from event_metrics
    union all select occurred_at from trace_events where type = 'otlp_model_call'`);
  assert.deepEqual(
    rows.map(({ at }) => at.toISOString()),
    Array(3).fill("2026-11-20T10:00:00.000Z"),
  );
  await deployment.client.close();
});
