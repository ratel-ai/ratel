import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  type Deployment,
  drain,
  dumpTables,
  envelopeHandler,
  envelopeOf,
  type IngestBody,
  ingestLogs,
  ingestTraces,
  logsBody,
  memoryStore,
  modelCallBody,
  processLogsDeps,
  SHARED_KEY,
  setupDeployment,
  testQueue,
} from "./test-support";

const NOW = new Date("2026-11-20T10:00:00.000Z");

/** The spans are stored directly in both deployments; only the logs are queued in one. */
async function deployment(
  bodies: readonly IngestBody[],
  mode: "direct" | "queued",
): Promise<Deployment> {
  const result = await setupDeployment();
  await ingestTraces(result, [modelCallBody()]);
  if (mode === "direct") {
    await ingestLogs(result, bodies);
    return result;
  }
  const queue = testQueue();
  await ingestLogs(result, bodies, queue);
  await drain(queue, envelopeHandler(result), bodies.length);
  return result;
}

const logTimes = async ({ client }: Deployment) => {
  const { rows } = await client.query<{ name: string; at: Date }>(
    "select event_name as name, occurred_at as at from otel_logs order by 1",
  );
  return new Map(rows.map(({ name, at }) => [name, at.toISOString()]));
};

for (const [label, key] of [
  ["a secret key", undefined],
  ["an append-only key", SHARED_KEY],
] as const) {
  test(`${label}: an envelope stores the same rows as a direct send`, async () => {
    const body = logsBody(key);
    const gzipped = {
      ...body,
      bytes: new Uint8Array(gzipSync(body.bytes)),
      contentEncoding: "gzip",
    };
    for (const bodies of [[body], [gzipped], [body, body]]) {
      const direct = await deployment(bodies, "direct");
      const queued = await deployment(bodies, "queued");
      const [expected, actual] = [await dumpTables(direct), await dumpTables(queued)];
      // The record without a time takes the time of accept, and the store's time in a request.
      for (const dump of [expected, actual]) {
        dump.otel_logs = dump.otel_logs.map((row) =>
          row.includes('"ratel.note"') ? row.replace(/"occurred_at":"[^"]+"/, "") : row,
        );
      }
      assert.deepEqual(actual, expected);
      assert.equal(expected.otel_logs.length, 3);
      assert.equal(expected.runtime_catalog_entries.length, key ? 0 : 1);
      assert.equal(expected.events[0].includes("Weather in Rome?"), !key, "restated");
      await Promise.all([direct.client.close(), queued.client.close()]);
    }
  });
}

test("a record without a time takes the time of accept, and the body is kept once", async () => {
  const result = await setupDeployment();
  const envelope = envelopeOf("logs", logsBody(), NOW.getTime());
  const handler = envelopeHandler(result);
  for (const attempt of [1, 2]) {
    assert.deepEqual(await handler(envelope, { attempt }), { outcome: "ack" });
  }
  assert.equal((await logTimes(result)).get("ratel.note"), NOW.toISOString());
  const raw = await result.client.query("select id from otlp_raw_exports");
  assert.deepEqual(raw.rows, [{ id: envelope.id }]);
  await result.client.close();
});

test("a failed write or join is retried, and a body that does not decode is a dead letter", async () => {
  const result = await setupDeployment();
  await ingestTraces(result, [modelCallBody()]);
  const store = memoryStore();
  const queue = testQueue(store);
  const bad = { contentType: "application/json", bytes: new TextEncoder().encode("secret") };
  await ingestLogs(result, [logsBody(), bad], queue);
  const real = processLogsDeps(result);
  const join = real.genAiLogJoin;
  assert.ok(join);
  let inserts = 0;
  let joins = 0;
  const settled = await drain(
    queue,
    envelopeHandler(result, {
      logs: {
        insertOtelLogs: async (...args) => {
          inserts += 1;
          if (inserts === 1) throw new Error("insert");
          return real.insertOtelLogs(...args);
        },
        genAiLogJoin: {
          ...join,
          store: {
            ...join.store,
            findSpans: async (...args) => {
              joins += 1;
              if (joins === 1) throw new Error("join");
              return join.store.findSpans(...args);
            },
          },
        },
      },
    }),
    4,
  );
  assert.deepEqual(
    settled.map(({ outcome, attempt }) => `${outcome} ${attempt}`),
    ["retry 1", "retry 2", "ack 3", "dead-letter 1"],
  );
  assert.equal(store.deadLetters[0].reason, "body does not decode as OTLP logs");
  const direct = await setupDeployment();
  await ingestTraces(direct, [modelCallBody()]);
  await ingestLogs(direct, [logsBody()]);
  assert.deepEqual((await dumpTables(result)).events, (await dumpTables(direct)).events);
  await Promise.all([result.client.close(), direct.client.close()]);
});

test("a catalog definition that could not be written fails the delivery", async () => {
  const result = await setupDeployment();
  await result.client.exec("alter table runtime_catalog_entries rename to gone");
  const queue = testQueue();
  await ingestLogs(result, [logsBody()], queue);
  const [settled] = await drain(queue, envelopeHandler(result), 1);
  assert.equal(settled.outcome, "retry");
  await result.client.close();
});
