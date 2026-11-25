import type { Config } from "@/config";
import { createKafkaClient } from "./client";
import { createKafkaQueue, type KafkaQueue } from "./kafka-queue";

/** The Kafka queue of this deployment's settings. Throws when one that it needs is missing. */
export async function openKafkaQueue({ kafka }: Config["ingest"]): Promise<KafkaQueue> {
  const brokers = listOf(kafka.brokers);
  if (brokers.length === 0) throw new Error("INGEST_QUEUE=kafka needs INGEST_KAFKA_BROKERS");
  const topics = listOf(kafka.topics);
  return createKafkaQueue(
    await createKafkaClient({ brokers, security: kafka.security, region: kafka.region }),
    {
      ...(kafka.topic ? { topic: kafka.topic } : {}),
      topics: async () => topics,
      groupId: kafka.groupId,
      deadLetterTopic: kafka.deadLetterTopic,
    },
  );
}

function listOf(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
