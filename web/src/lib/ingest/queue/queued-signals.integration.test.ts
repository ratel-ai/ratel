import assert from "node:assert/strict";
import { test } from "node:test";
import { startIngestConsumer } from "./consumer";
import {
  drain,
  dumpTables,
  envelopeHandler,
  eventsBody,
  ingestEvents,
  ingestLogs,
  ingestTraces,
  logsBody,
  memoryStore,
  modelCallBody,
  setupDeployment,
  testQueue,
} from "./test-support";

const AT = Date.now() - 60_000;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

/** One project sends its logs, spans and events; order in the queue is the order of the requests. */
async function sendAll(
  deployment: Awaited<ReturnType<typeof setupDeployment>>,
  queue?: ReturnType<typeof testQueue>,
) {
  await ingestLogs(deployment, [logsBody()], queue);
  await ingestTraces(deployment, [modelCallBody()], queue);
  await ingestEvents(deployment, [eventsBody(AT)], queue);
}

test("the consumer processes all three signals, and leaves what a direct send leaves", async () => {
  const direct = await setupDeployment();
  await sendAll(direct);
  const queued = await setupDeployment();
  const queue = testQueue();
  await sendAll(queued, queue);

  let settled = 0;
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
  const store = memoryStore();
  await sendAll(deployment, testQueue(store));
  const real = envelopeHandler(deployment);
  let consumed = 0;
  const consumer = testQueue(store).consume(async (envelope, delivery) => {
    consumed += 1;
    const result = await real(envelope, delivery);
    void consumer.stop();
    return result;
  });
  while (consumed === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await consumer.stop();
  assert.equal(consumed, 1);
  const left = () => [...store.projects.values()].flat().length;
  assert.equal(left(), 2);
  await drain(testQueue(store), real, 2);
  assert.equal(left(), 0);
  await deployment.client.close();
});
