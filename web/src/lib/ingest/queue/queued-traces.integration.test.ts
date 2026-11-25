import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { decodeOtlp } from "@/lib/ingest/otlp/decode";
import { loadFixture } from "@/lib/ledger/turns/real-fixtures";
import {
  type Deployment,
  drain,
  dumpTables,
  envelopeHandler,
  envelopeOf,
  type IngestBody,
  ingestTraces,
  memoryStore,
  ORGANIZATION_ID,
  PROJECT_ID,
  SECRET_KEY_ID,
  setupDeployment,
  testQueue,
  tracesRouteDeps,
} from "./test-support";

const REAL = join(import.meta.dirname, "../otlp/__fixtures__/real");
const FIXTURES = readdirSync(REAL, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map(({ name }) => name);

async function queued(
  bodies: readonly IngestBody[],
  over: Parameters<typeof envelopeHandler>[1] = {},
  store = memoryStore(),
): Promise<Deployment> {
  const deployment = await setupDeployment();
  const queue = testQueue(store);
  await ingestTraces(deployment, bodies, queue);
  await drain(queue, envelopeHandler(deployment, over), bodies.length);
  return deployment;
}

test("the real fixtures: an envelope stores the same rows as a direct send", async () => {
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

test("a gzip body is kept as it came", async () => {
  const [body] = loadFixture("vercel-ai");
  const gzipped = {
    ...body,
    bytes: new Uint8Array(gzipSync(body.bytes)),
    contentEncoding: "x-gzip",
  };
  const deployment = await queued([gzipped]);
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
  const queue = testQueue();
  await ingestTraces(deployment, [body], queue);

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
  const queue = testQueue();
  await ingestTraces(deployment, [body], queue);
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
  const store = memoryStore();
  const deployment = await queued(bodies, {}, store);
  const letters = store.deadLetters;
  assert.deepEqual(letters.map(({ reason }) => reason).sort(), [
    "body does not decode as OTLP traces",
    "body does not decode as OTLP traces",
    "body does not decode as OTLP traces",
    "body has more than 5000 spans",
    "body is not valid gzip",
    "body is over 16000000 bytes decompressed",
  ]);
  assert.ok(letters.every(({ deliveries }) => deliveries === 1));
  await deployment.client.close();
});

test("a project that does not exist is a dead letter", async () => {
  const deployment = await setupDeployment();
  const handler = envelopeHandler(deployment);
  const envelope = envelopeOf("traces", loadFixture("vercel-ai")[0]);
  const result = await handler({ ...envelope, projectId: ORGANIZATION_ID }, { attempt: 1 });
  assert.deepEqual(result, { outcome: "dead-letter", reason: "project does not exist" });
  await deployment.client.close();
});

test("refused and dropped traces are final: acknowledged, logged, not stored", async () => {
  const [body] = loadFixture("vercel-ai");
  const spans = decodeOtlp(body.contentType, body.bytes);
  for (const outcome of ["refused", "dropped"] as const) {
    const deployment = await setupDeployment();
    const queue = testQueue();
    await ingestTraces(deployment, [body], queue);
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
  const queue = testQueue();
  const tracked: string[] = [];
  for (const iso of ["2026-11-20T10:00:00Z", "2026-11-19T10:00:00Z"]) {
    await queue.publish(envelopeOf("traces", body, Date.parse(iso)));
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
  const queue = testQueue();
  await queue.publish(envelopeOf("traces", body, Date.parse("2026-11-20T10:00:00Z")));
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
