import assert from "node:assert/strict";
import { test } from "node:test";
import { startIngestConsumer } from "./consumer";
import {
  acceptOnto,
  drain,
  dumpTables,
  envelopeHandler,
  eventsBody,
  ingestEvents,
  ingestLogs,
  ingestTraces,
  logsBody,
  modelCallBody,
  setupDeployment,
  spoolQueue,
} from "./test-support";

const AT = Date.now() - 60_000;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

/** One project sends its logs, spans and events; order in the queue is the order of the requests. */
async function sendAll(deployment: Awaited<ReturnType<typeof setupDeployment>>, queued: boolean) {
  const accept = queued ? acceptOnto(spoolQueue(deployment)) : undefined;
  await ingestLogs(deployment, [logsBody()], accept);
  await ingestTraces(deployment, [modelCallBody()], accept);
  await ingestEvents(deployment, [eventsBody(AT)], accept);
}

test("the consumer processes all three signals, and leaves what direct mode leaves", async () => {
  const direct = await setupDeployment();
  await sendAll(direct, false);
  const queued = await setupDeployment();
  await sendAll(queued, true);

  let settled = 0;
  const queue = spoolQueue(queued);
  const consumer = startIngestConsumer({
    queue: {
      publish: queue.publish,
      consume: (handler, options) =>
        queue.consume(handler, {
          onSettled: (delivery) => {
            settled += 1;
            options?.onSettled?.(delivery);
          },
        }),
    },
    handler: envelopeHandler(queued),
    log: silent,
  });
  const deadline = Date.now() + 10_000;
  while (settled < 3) {
    assert.ok(Date.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await consumer.stop();

  const [expected, actual] = [await dumpTables(direct), await dumpTables(queued)];
  for (const dump of [expected, actual]) {
    dump.otel_logs = dump.otel_logs.map((row) =>
      row.includes('"ratel.note"') ? row.replace(/"occurred_at":"[^"]+"/, "") : row,
    );
  }
  assert.deepEqual(actual, expected);
  assert.ok(expected.events[0].includes("Weather in Rome?"), "the logs joined their call");
  await Promise.all([direct.client.close(), queued.client.close()]);
});

test("a stop in the middle leaves the rest for the next consumer", async () => {
  const deployment = await setupDeployment();
  await sendAll(deployment, true);
  const real = envelopeHandler(deployment);
  const queue = spoolQueue(deployment);
  let consumed = 0;
  const consumer = queue.consume(async (envelope, delivery) => {
    consumed += 1;
    const result = await real(envelope, delivery);
    void consumer.stop();
    return result;
  });
  while (consumed === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await consumer.stop();
  assert.equal(consumed, 1);
  const { rows } = await deployment.client.query("select claim_token from ingest_spool");
  assert.deepEqual(rows, [{ claim_token: null }, { claim_token: null }]);
  await drain(spoolQueue(deployment), real, 2);
  const left = await deployment.client.query("select seq from ingest_spool");
  assert.equal(left.rows.length, 0);
  await deployment.client.close();
});
