import type { Config } from "@/config";
import { createKafkaClient } from "./client";
import { createKafkaQueue, type KafkaQueue } from "./kafka-queue";
import { createPerTopicKafkaQueue, TOPIC_PLACEHOLDER } from "./per-topic";

/**
 * The Kafka queue of this deployment's settings. Throws when one that it needs is missing.
 * `editionTopics` are read again while the queue runs, besides the configured ones.
 */
export async function openKafkaQueue(
  { kafka }: Config["ingest"],
  editionTopics: () => Promise<readonly string[]> = async () => [],
): Promise<KafkaQueue> {
  const brokers = listOf(kafka.brokers);
  if (brokers.length === 0) throw new Error("INGEST_QUEUE=kafka needs INGEST_KAFKA_BROKERS");
  const perTopic = kafka.groupId.includes(TOPIC_PLACEHOLDER);
  if (perTopic !== kafka.deadLetterTopic.includes(TOPIC_PLACEHOLDER)) {
    throw new Error(
      "INGEST_KAFKA_GROUP_ID and INGEST_KAFKA_DEAD_LETTER_TOPIC must both hold {topic}, or neither",
    );
  }
  const configured = listOf(kafka.topics);
  const client = await createKafkaClient({
    brokers,
    security: kafka.security,
    region: kafka.region,
  });
  return (perTopic ? createPerTopicKafkaQueue : createKafkaQueue)(client, {
    topics: async () => [...new Set([...configured, ...(await editionTopics())])],
    groupId: kafka.groupId,
    deadLetterTopic: kafka.deadLetterTopic,
  });
}

function listOf(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
