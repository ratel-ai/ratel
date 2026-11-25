import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Kafka } from "kafkajs";
import { encodeEnvelope } from "@/lib/ingest/queue/envelope";
import type { RetryPolicy } from "@/lib/ingest/queue/port/settle";
import {
  type DeadLetter,
  envelope,
  type QueueHarness,
  runQueueConformance,
} from "@/lib/ingest/queue/port/test-support/conformance";
import { createKafkaClient } from "./client";
import { createKafkaQueue, type KafkaQueue } from "./kafka-queue";

/**
 * Against a real broker: `TEST_KAFKA_BROKERS` (the CI job `kafka-conformance` starts one). Without
 * it, nothing runs here.
 */
const brokers = process.env.TEST_KAFKA_BROKERS?.split(",");
const PARTITIONS = 3;
const FAST: RetryPolicy = {
  waitsMs: [10, 10, 10, 10],
  outageWaitMs: { first: 10, max: 20 },
};

if (!brokers) {
  test("kafka conformance", { skip: "TEST_KAFKA_BROKERS is not set" }, () => undefined);
} else {
  runQueueConformance("kafka", (policy) => kafkaHarness(brokers, policy), {
    waitMs: 60_000,
    // Long enough for a consumer to join its group.
    quietMs: 3_000,
  });

  test("kafka: an offset is committed only after its handler succeeded", async () => {
    const t = await kafkaHarness(brokers, { ...FAST, waitsMs: [2_000, 10, 10, 10] });
    const queue = await t.open();
    const committed = async () =>
      (await t.admin.fetchOffsets({ groupId: t.groupId, topics: [t.topic] }))[0].partitions
        .map(({ offset }) => Number(offset))
        .reduce((sum, offset) => sum + Math.max(0, offset), 0);
    const steps: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const consumer = queue.consume(
      async (_, { attempt }) => {
        steps.push(`delivery ${attempt}`);
        if (attempt === 1) return { outcome: "retry", reason: "later" };
        await gate;
        return { outcome: "ack" };
      },
      { onSettled: ({ outcome }) => steps.push(outcome) },
    );
    await queue.publish(envelope(t.projectIds[0]));
    await until(() => steps.length === 2);
    assert.equal(await committed(), 0, "not after a failure");
    await until(() => steps.length === 3);
    assert.equal(await committed(), 0, "not while the handler runs");
    release();
    await until(() => steps.length === 4);
    assert.equal(await committed(), 1);
    assert.deepEqual(steps, ["delivery 1", "retry", "delivery 2", "ack"]);
    await consumer.stop();
    await t.close();
  });

  test("kafka: a topic added to or removed from the list is picked up while it runs", async () => {
    const t = await kafkaHarness(brokers, FAST);
    const other = `${t.topic}-other`;
    await t.admin.createTopics({ topics: [{ topic: other, numPartitions: 1 }] });
    let topics = [t.topic];
    const queue = t.openWith({ topics: async () => topics, topicsRefreshMs: 200 });
    const toOther = t.openWith({ topic: other });
    const seen: string[] = [];
    const consumer = queue.consume(async ({ id }) => {
      seen.push(id);
      return { outcome: "ack" };
    });
    const ids = [1, 2, 3].map(() => envelope(t.projectIds[0]));
    await queue.publish(ids[0]);
    await until(() => seen.includes(ids[0].id));

    await toOther.publish(ids[1]);
    topics = [t.topic, other];
    await until(() => seen.includes(ids[1].id));

    topics = [other];
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await queue.publish(ids[2]);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(seen.includes(ids[2].id), false, "a removed topic is not read");
    topics = [];
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    topics = [t.topic];
    await until(() => seen.includes(ids[2].id));
    await consumer.stop();
    await t.close();
  });

  test("kafka: a list with a topic that does not exist is tried again", async () => {
    const t = await kafkaHarness(brokers, FAST);
    const missing = `${t.topic}-missing`;
    const queue = t.openWith({ topics: async () => [missing], topicsRefreshMs: 200 });
    const seen: string[] = [];
    const consumer = queue.consume(async ({ id }) => {
      seen.push(id);
      return { outcome: "ack" };
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await t.admin.createTopics({ topics: [{ topic: missing, numPartitions: 1 }] });
    const message = envelope(t.projectIds[0]);
    await t.openWith({ topic: missing }).publish(message);
    await until(() => seen.includes(message.id));
    await consumer.stop();
    await t.close();
  });

  test("kafka: the record's key is the project and its value the frame", async () => {
    const t = await kafkaHarness(brokers, FAST);
    const message = envelope(t.projectIds[0], { body: new Uint8Array(4_000_000).fill(7) });
    await (await t.open()).publish(message);
    const [record] = await readTopic(t.kafka, t.topic, 1);
    assert.equal(record.key, message.projectId);
    assert.deepEqual(record.value, Buffer.from(encodeEnvelope(message)));
    await t.close();
  });

  test("kafka: a broker that cannot be reached fails the publish within ten seconds", async () => {
    const kafka = await createKafkaClient({ brokers: ["localhost:1"], security: "plaintext" });
    const queue = createKafkaQueue(kafka, {
      topic: "t",
      topics: async () => [],
      groupId: "g",
      deadLetterTopic: "d",
    });
    const startedAt = Date.now();
    await assert.rejects(queue.publish(envelope(randomUUID())));
    assert.ok(Date.now() - startedAt < 10_000);
  });
}

type KafkaHarness = QueueHarness & {
  kafka: Kafka;
  admin: ReturnType<Kafka["admin"]>;
  topic: string;
  groupId: string;
  openWith(over: Partial<Parameters<typeof createKafkaQueue>[1]>): KafkaQueue;
};

async function kafkaHarness(brokers: string[], policy: RetryPolicy): Promise<KafkaHarness> {
  const kafka = await createKafkaClient({ brokers, security: "plaintext" });
  const admin = kafka.admin();
  await admin.connect();
  const topic = `ingest-test-${randomUUID()}`;
  const deadLetterTopic = `${topic}-dead`;
  const groupId = `${topic}-group`;
  await admin.createTopics({
    waitForLeaders: true,
    topics: [
      { topic, numPartitions: PARTITIONS },
      { topic: deadLetterTopic, numPartitions: 1 },
    ].map((entry) => ({
      ...entry,
      configEntries: [{ name: "max.message.bytes", value: "8388608" }],
    })),
  });
  const queues: KafkaQueue[] = [];
  const openWith: KafkaHarness["openWith"] = (over) => {
    const queue = createKafkaQueue(kafka, {
      topic,
      topics: async () => [topic],
      groupId,
      deadLetterTopic,
      policy,
      ...over,
    });
    queues.push(queue);
    return queue;
  };
  return {
    kafka,
    admin,
    topic,
    groupId,
    openWith,
    open: async () => openWith({}),
    publishFrame: async (projectId, frame) => {
      const producer = kafka.producer();
      await producer.connect();
      await producer.send({
        topic,
        acks: -1,
        messages: [{ key: projectId, value: Buffer.from(frame) }],
      });
      await producer.disconnect();
    },
    projectIds: [randomUUID(), randomUUID(), randomUUID()],
    deadLetters: async () => {
      const [{ high }] = await admin.fetchTopicOffsets(deadLetterTopic);
      const records = await readTopic(kafka, deadLetterTopic, Number(high));
      return records.map(toDeadLetter);
    },
    close: async () => {
      await Promise.all(queues.map((queue) => queue.close()));
      await admin.disconnect();
    },
  };
}

interface TopicRecord {
  key: string | undefined;
  value: Buffer;
  headers: Record<string, string>;
}

async function readTopic(kafka: Kafka, topic: string, count: number): Promise<TopicRecord[]> {
  if (count === 0) return [];
  const records: TopicRecord[] = [];
  const consumer = kafka.consumer({
    groupId: `reader-${randomUUID()}`,
    maxBytesPerPartition: 8_388_608,
  });
  await consumer.connect();
  await consumer.subscribe({ topics: [topic], fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      records.push({
        key: message.key?.toString(),
        value: message.value ?? Buffer.alloc(0),
        headers: Object.fromEntries(
          Object.entries(message.headers ?? {}).map(([name, value]) => [name, String(value)]),
        ),
      });
    },
  });
  await until(() => records.length >= count);
  await consumer.disconnect();
  return records;
}

function toDeadLetter({ value, headers }: TopicRecord): DeadLetter {
  return {
    id: readId(value),
    frame: new Uint8Array(value),
    reason: headers.reason,
    deliveries: Number(headers.deliveries),
    firstFailedAt: new Date(headers.first_failed_at),
    lastFailedAt: new Date(headers.last_failed_at),
  };
}

/** The id in the frame's header, also of a newer version. */
function readId(frame: Buffer): string | null {
  return /"id":"([0-9a-f-]{36})"/.exec(frame.toString("latin1"))?.[1] ?? null;
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
