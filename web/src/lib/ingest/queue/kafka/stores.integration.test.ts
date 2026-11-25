import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadFixture } from "@/lib/ledger/turns/real-fixtures";
import type { EnvelopeHandler } from "../port/envelope-queue";
import {
  type Deployment,
  deploymentOver,
  dumpTables,
  envelopeHandler,
  envelopeOf,
  eventsBody,
  FAST_POLICY,
  type IngestBody,
  ingestEvents,
  ingestLogs,
  ingestTraces,
  killableClient,
  logsBody,
  modelCallBody,
  SHARED_KEY,
  setupDeployment,
  usageOf,
} from "../test-support";
import { createKafkaClient } from "./client";
import { createKafkaQueue } from "./kafka-queue";

/**
 * What a worker stores from a real broker (ADR-0010) is what a direct send stores: once, twice, and
 * with workers that die in the middle. Needs `TEST_KAFKA_BROKERS`; without it nothing runs here.
 */
const brokers = process.env.TEST_KAFKA_BROKERS?.split(",");
const REAL = join(import.meta.dirname, "../../otlp/__fixtures__/real");
const FIXTURES = readdirSync(REAL, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map(({ name }) => name);
const AT = Date.now() - 60_000;

interface Sent {
  traces: IngestBody[];
  logs: IngestBody[];
  events: IngestBody[];
}

const EVERYTHING: Sent = {
  traces: [...FIXTURES.flatMap((name) => loadFixture(name)), modelCallBody()],
  logs: [logsBody(), logsBody(SHARED_KEY)],
  events: [eventsBody(AT), eventsBody(AT, SHARED_KEY)],
};

/** A few exports of each signal: what several dying workers can go through in a test. */
const SOME: Sent = {
  traces: ["vercel-ai", "mcp-python-fastmcp", "pydantic-ai"].flatMap((name) => loadFixture(name)),
  logs: [logsBody()],
  events: [eventsBody(AT)],
};

const envelopesOf = ({ traces, logs, events }: Sent) => [
  ...traces.map((body) => envelopeOf("traces", body)),
  ...logs.map((body) => envelopeOf("logs", body)),
  ...events.map((body) => envelopeOf("events", body)),
];

/** Rows as a direct send leaves them. */
async function direct({ traces, logs, events }: Sent) {
  const deployment = await setupDeployment();
  await ingestTraces(deployment, traces);
  await ingestLogs(deployment, logs);
  await ingestEvents(deployment, events);
  const result = { tables: await tablesOf(deployment), usage: await usageOf(deployment) };
  await deployment.client.close();
  return result;
}

/** The usage counter can miss a killed worker's events (ADR-0010); it is compared apart. */
async function tablesOf(deployment: Deployment): Promise<Record<string, string[]>> {
  const { test_event_usage: _usage, ...dump } = await dumpTables(deployment);
  // A record without a time takes the time of accept, and the store's time in a request.
  dump.otel_logs = dump.otel_logs.map((row) =>
    row.includes('"ratel.note"') ? row.replace(/"occurred_at":"[^"]+"/, "") : row,
  );
  return dump;
}

async function broker(servers: string[]) {
  const kafka = await createKafkaClient({ brokers: servers, security: "plaintext" });
  const admin = kafka.admin();
  await admin.connect();
  const topic = `stores-${randomUUID()}`;
  const groupId = `stores.${topic}`;
  await admin.createTopics({
    topics: [
      { topic, numPartitions: 1 },
      { topic: `${topic}.dead`, numPartitions: 1 },
    ],
  });
  const open = () =>
    createKafkaQueue(kafka, {
      topic,
      topics: async () => [topic],
      groupId,
      deadLetterTopic: `${topic}.dead`,
      policy: FAST_POLICY,
    });
  const high = async (name: string) => Number((await admin.fetchTopicOffsets(name))[0]?.high ?? 0);
  const committed = async () =>
    Math.max(
      0,
      Number((await admin.fetchOffsets({ groupId, topics: [topic] }))[0].partitions[0].offset),
    );
  return { admin, topic, open, high, committed };
}

type Broker = Awaited<ReturnType<typeof broker>>;

async function until(condition: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** A worker until the topic is committed to its end. */
async function readToEnd(t: Broker, handler: EnvelopeHandler): Promise<void> {
  const queue = t.open();
  const consumer = queue.consume(handler);
  const end = await t.high(t.topic);
  assert.ok(await until(async () => (await t.committed()) === end, 90_000), "not at the end");
  await consumer.stop();
  await queue.close();
}

if (!brokers) {
  test("kafka stores", { skip: "TEST_KAFKA_BROKERS is not set" }, () => undefined);
} else {
  for (const times of [1, 2]) {
    test(`all three signals through Kafka ${times === 1 ? "once" : "twice"} store what a direct send stores`, async () => {
      const expected = await direct(EVERYTHING);
      const t = await broker(brokers);
      const envelopes = envelopesOf(EVERYTHING);
      const publisher = t.open();
      for (let i = 0; i < times; i++) {
        for (const envelope of envelopes) await publisher.publish(envelope);
      }
      await publisher.close();
      const deployment = await setupDeployment();
      await readToEnd(t, envelopeHandler(deployment));
      assert.deepEqual(await tablesOf(deployment), expected.tables);
      assert.equal(await usageOf(deployment), expected.usage);
      assert.equal(await t.high(`${t.topic}.dead`), 0, "nothing is dead-lettered");
      assert.ok(expected.tables.otel_spans.length > 50 && expected.tables.trace_events.length > 6);
      await deployment.client.close();
      await t.admin.disconnect();
    });
  }

  test("workers that die mid-batch: the next one goes on, and the rows are a direct send's", async () => {
    const expected = await direct(SOME);
    const t = await broker(brokers);
    const publisher = t.open();
    for (const envelope of envelopesOf(SOME)) await publisher.publish(envelope);
    await publisher.close();
    const deployment = await setupDeployment();

    // Each worker's database connection ends at another statement: before, in and after a store. What it
    // had in hand is never acknowledged, so the next worker gets it again.
    let killed = 0;
    for (const at of [3, 17, 38, 61]) {
      const connection = killableClient(deployment.client, at);
      const store = envelopeHandler(deploymentOver(connection.client));
      const queue = t.open();
      const consumer = queue.consume(async (envelope, delivery) => {
        const result = await store(envelope, delivery);
        // A dead process answers nothing: its message stays in hand until the stop gives it back.
        return connection.dead() ? { outcome: "outage", reason: "the process is gone" } : result;
      });
      if (await until(() => connection.dead(), 30_000)) killed += 1;
      await consumer.stop();
      await queue.close();
    }
    assert.equal(killed, 4);
    const left = (await t.high(t.topic)) - (await t.committed());
    assert.ok(left > 0, "the last worker leaves work");

    await readToEnd(t, envelopeHandler(deployment));
    assert.deepEqual(await tablesOf(deployment), expected.tables);
    assert.ok((await usageOf(deployment)) <= expected.usage);
    assert.equal(await t.high(`${t.topic}.dead`), 0);
    await deployment.client.close();
    await t.admin.disconnect();
  });
}
