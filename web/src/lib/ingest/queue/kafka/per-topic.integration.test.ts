import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { envelope } from "@/lib/ingest/queue/port/test-support/conformance";
import { createKafkaClient } from "./client";
import { createKafkaQueue } from "./kafka-queue";
import { createPerTopicKafkaQueue } from "./per-topic";

/** Against a real broker, as `kafka-queue.integration.test.ts`: `TEST_KAFKA_BROKERS`. */
const brokers = process.env.TEST_KAFKA_BROKERS?.split(",");

if (!brokers) {
  test("kafka per topic", { skip: "TEST_KAFKA_BROKERS is not set" }, () => undefined);
} else {
  const setup = async () => {
    const kafka = await createKafkaClient({ brokers, security: "plaintext" });
    const admin = kafka.admin();
    await admin.connect();
    const run = randomUUID().slice(0, 8);
    const [a, b] = [`org-a-${run}`, `org-b-${run}`];
    await admin.createTopics({
      topics: [a, b, `${a}.dead`, `${b}.dead`].map((topic) => ({ topic, numPartitions: 1 })),
    });
    const publishTo = (topic: string) =>
      createKafkaQueue(kafka, {
        topic,
        topics: async () => [],
        groupId: "-",
        deadLetterTopic: "-",
      });
    const committed = async (topic: string) =>
      Number(
        (await admin.fetchOffsets({ groupId: `ratel-ingest.${topic}`, topics: [topic] }))[0]
          .partitions[0].offset,
      );
    return { kafka, admin, a, b, publishTo, committed };
  };

  test("a topic goes on at the offset its group committed, and one that leaves stops after the message in hand", async () => {
    const t = await setup();
    const [toA, toB] = [t.publishTo(t.a), t.publishTo(t.b)];
    const sent = [envelope(randomUUID()), envelope(randomUUID()), envelope(randomUUID())];
    for (const message of sent) await toA.publish(message);
    // The other reader of the group (the relay) has delivered the first two.
    await t.admin.setOffsets({
      groupId: `ratel-ingest.${t.a}`,
      topic: t.a,
      partitions: [{ partition: 0, offset: "2" }],
    });

    let topics: string[] = [];
    const seen: string[] = [];
    let hold: Promise<void> | undefined;
    const queue = createPerTopicKafkaQueue(t.kafka, {
      topics: async () => topics,
      groupId: "ratel-ingest.{topic}",
      deadLetterTopic: "{topic}.dead",
      topicsRefreshMs: 200,
      policy: { waitsMs: [10, 10, 10, 10], outageWaitMs: { first: 10, max: 20 } },
    });
    const consumer = queue.consume(async ({ id }) => {
      seen.push(id);
      await hold;
      return { outcome: "ack" };
    });

    topics = [t.a];
    await until(() => seen.length > 0);
    assert.deepEqual(seen, [sent[2].id], "only what the group had not committed");
    await until(async () => (await t.committed(t.a)) === 3);

    // A second topic joins while the first runs.
    const other = envelope(randomUUID());
    await toB.publish(other);
    topics = [t.a, t.b];
    await until(() => seen.includes(other.id));

    // The first one leaves with a message in hand.
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inHand = envelope(randomUUID());
    await toA.publish(inHand);
    await until(() => seen.includes(inHand.id));
    topics = [t.b];
    const after = envelope(randomUUID());
    await toA.publish(after);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    hold = undefined;
    release();
    await until(async () => (await t.committed(t.a)) === 4);
    await until(
      async () =>
        (await t.admin.describeGroups([`ratel-ingest.${t.a}`])).groups[0].state !== "Stable",
    );
    assert.equal(seen.includes(after.id), false, "nothing after the message in hand");
    const late = envelope(randomUUID());
    await toB.publish(late);
    await until(() => seen.includes(late.id));

    // It comes back where it left.
    topics = [t.a, t.b];
    await until(() => seen.includes(after.id));
    await consumer.stop();
    await Promise.all([queue.close(), toA.close(), toB.close(), t.admin.disconnect()]);
  });

  test("a message that cannot pass goes to its topic's own dead-letter topic", async () => {
    const t = await setup();
    const toA = t.publishTo(t.a);
    const queue = createPerTopicKafkaQueue(t.kafka, {
      topics: async () => [t.a],
      groupId: "ratel-ingest.{topic}",
      deadLetterTopic: "{topic}.dead",
      topicsRefreshMs: 200,
    });
    const consumer = queue.consume(async () => ({ outcome: "dead-letter", reason: "no" }));
    await toA.publish(envelope(randomUUID()));
    await until(async () => Number((await t.admin.fetchTopicOffsets(`${t.a}.dead`))[0].high) === 1);
    await consumer.stop();
    await Promise.all([queue.close(), toA.close(), t.admin.disconnect()]);
  });

  test("a list that cannot be read changes nothing", async () => {
    const t = await setup();
    const toA = t.publishTo(t.a);
    let fails = false;
    const seen: string[] = [];
    const queue = createPerTopicKafkaQueue(t.kafka, {
      topics: async () => {
        if (fails) throw new Error("db down");
        return [t.a];
      },
      groupId: "ratel-ingest.{topic}",
      deadLetterTopic: "{topic}.dead",
      topicsRefreshMs: 100,
    });
    const consumer = queue.consume(async ({ id }) => {
      seen.push(id);
      return { outcome: "ack" };
    });
    await toA.publish(envelope(randomUUID()));
    await until(() => seen.length === 1);
    fails = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await toA.publish(envelope(randomUUID()));
    await until(() => seen.length === 2);
    await consumer.stop();
    await Promise.all([queue.close(), toA.close(), t.admin.disconnect()]);
  });
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
