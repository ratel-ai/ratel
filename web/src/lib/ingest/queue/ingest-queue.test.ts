import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, test } from "node:test";
import { resetConfigForTests } from "@/config";
import { ingestAccept, ingestQueue, resetIngestQueueForTests } from "./ingest-queue";

const { cache } = createRequire(import.meta.url);
const loaded = (name: string) =>
  Object.keys(cache).some((file) => file.includes(`/node_modules/${name}/`));

function configure(env: Record<string, string>): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("INGEST_")) delete process.env[key];
  }
  Object.assign(process.env, env);
  resetConfigForTests();
  resetIngestQueueForTests();
}

afterEach(() => configure({}));

// Order matters: what a process has loaded stays loaded.
test("direct mode has no queue and loads no driver", async () => {
  configure({});
  assert.equal(await ingestQueue(), null);
  assert.equal(await ingestAccept(), undefined);
  assert.equal(loaded("kafkajs"), false);
});

test("the Postgres driver does not load Kafka", async () => {
  configure({ INGEST_QUEUE: "postgres", DATABASE_URL: "postgres://localhost:1/none" });
  const queue = await ingestQueue();
  assert.ok(queue);
  assert.equal(await ingestQueue(), queue, "one queue per process");
  assert.ok(await ingestAccept());
  assert.equal(loaded("kafkajs"), false);
  assert.equal(loaded("aws-msk-iam-sasl-signer-js"), false);
});

test("the Kafka driver loads when it is the configured one", async () => {
  configure({ INGEST_QUEUE: "kafka" });
  await assert.rejects(ingestQueue(), /needs INGEST_KAFKA_BROKERS/);
  configure({ INGEST_QUEUE: "kafka", INGEST_KAFKA_BROKERS: "a:9092, b:9092" });
  assert.ok(await ingestQueue());
  assert.equal(loaded("kafkajs"), true);
  assert.equal(loaded("aws-msk-iam-sasl-signer-js"), false, "only with IAM");
});

test("Kafka without a topic to publish to only consumes: the routes stay direct", async () => {
  const kafka = { INGEST_QUEUE: "kafka", INGEST_KAFKA_BROKERS: "a:9092" };
  configure(kafka);
  assert.ok(await ingestQueue());
  assert.equal(await ingestAccept(), undefined);
  configure({ ...kafka, INGEST_KAFKA_TOPIC: "ingest" });
  assert.ok(await ingestAccept());
});

test("a group per topic needs a dead-letter topic per topic", async () => {
  configure({
    INGEST_QUEUE: "kafka",
    INGEST_KAFKA_BROKERS: "a:9092",
    INGEST_KAFKA_GROUP_ID: "ratel-ingest.{topic}",
  });
  await assert.rejects(ingestQueue(), /must both hold \{topic\}/);
});

test("the IAM login needs its region", async () => {
  const kafka = {
    INGEST_QUEUE: "kafka",
    INGEST_KAFKA_BROKERS: "a:9098",
    INGEST_KAFKA_SECURITY: "iam",
  };
  configure(kafka);
  await assert.rejects(ingestQueue(), /needs INGEST_KAFKA_REGION/);
  configure({ ...kafka, INGEST_KAFKA_REGION: "eu-central-1" });
  assert.ok(await ingestQueue());
  assert.equal(loaded("aws-msk-iam-sasl-signer-js"), true);
});
