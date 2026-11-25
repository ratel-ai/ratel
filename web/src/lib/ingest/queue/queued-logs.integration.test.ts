import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { handleLogsRequest } from "@/lib/ingest/otlp/logs-route-handler";
import { listDeadLetters } from "@/lib/ingest/queue/postgres/store";
import {
  acceptOnto,
  type Deployment,
  drain,
  dumpTables,
  envelopeHandler,
  type IngestBody,
  ingestLogs,
  ingestRequest,
  ingestTraces,
  logsBody,
  logsRouteDeps,
  modelCallBody,
  processLogsDeps,
  SHARED_KEY,
  setupDeployment,
  spoolQueue,
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
  const queue = spoolQueue(result);
  await ingestLogs(result, bodies, acceptOnto(queue));
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
  test(`${label}: a queued deployment stores the same rows as a direct one`, async () => {
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
      // The record without a time takes the time of accept, and the store's time in direct mode.
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

test("the route answers before it stores, without counts, and uses the time of accept", async () => {
  const result = await setupDeployment();
  const queue = spoolQueue(result);
  const response = await handleLogsRequest(
    ingestRequest("logs", logsBody()),
    logsRouteDeps(result, { accept: acceptOnto(queue), now: () => NOW }),
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {});
  assert.deepEqual([...(await logTimes(result)).keys()], []);
  await drain(queue, envelopeHandler(result), 1);
  assert.equal((await logTimes(result)).get("ratel.note"), NOW.toISOString());
  const raw = await result.client.query("select id from otlp_raw_exports");
  assert.equal(raw.rows.length, 1);
  await result.client.close();
});

test("a failed write or join is retried, and a body that does not decode is a dead letter", async () => {
  const result = await setupDeployment();
  await ingestTraces(result, [modelCallBody()]);
  const queue = spoolQueue(result);
  const bad = { contentType: "application/json", bytes: new TextEncoder().encode("secret") };
  await ingestLogs(result, [logsBody(), bad], acceptOnto(queue));
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
  assert.equal((await listDeadLetters(result.db))[0].reason, "body does not decode as OTLP logs");
  const direct = await setupDeployment();
  await ingestTraces(direct, [modelCallBody()]);
  await ingestLogs(direct, [logsBody()]);
  assert.deepEqual((await dumpTables(result)).events, (await dumpTables(direct)).events);
  await Promise.all([result.client.close(), direct.client.close()]);
});

test("a catalog definition that could not be written fails the delivery", async () => {
  const result = await setupDeployment();
  await result.client.exec("alter table runtime_catalog_entries rename to gone");
  const queue = spoolQueue(result);
  await ingestLogs(result, [logsBody()], acceptOnto(queue));
  const [settled] = await drain(queue, envelopeHandler(result), 1);
  assert.equal(settled.outcome, "retry");
  await result.client.close();
});
