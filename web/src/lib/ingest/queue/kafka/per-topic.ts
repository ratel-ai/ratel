import type { Kafka } from "kafkajs";
import type { ConsumeOptions } from "@/lib/contracts/ingest-queue";
import type { EnvelopeConsumer, EnvelopeHandler } from "@/lib/ingest/queue/port/envelope-queue";
import { errorReason } from "@/lib/ingest/queue/port/settle";
import { getLogger } from "@/lib/platform/logger";
import { createKafkaQueue, type KafkaQueue, type KafkaQueueOptions } from "./kafka-queue";

const logger = getLogger("ingest:kafka");

/** What a consumer group or dead-letter topic name holds in place of the topic. */
export const TOPIC_PLACEHOLDER = "{topic}";

/**
 * A Kafka queue that reads each topic in a consumer group of its own (`groupId` and
 * `deadLetterTopic` hold `{topic}`). Another reader of the same group can then hand a topic over
 * with its committed offsets, and a topic that comes or goes never disturbs the others.
 */
export function createPerTopicKafkaQueue(kafka: Kafka, options: KafkaQueueOptions): KafkaQueue {
  const publisher = createKafkaQueue(kafka, options);
  return {
    publish: (envelope) => publisher.publish(envelope),
    consume: (handler, consumeOptions = {}) =>
      new PerTopicConsumer(kafka, options, handler, consumeOptions),
    close: () => publisher.close(),
  };
}

interface TopicReader {
  stop(): Promise<void>;
  /** Set while the message in hand finishes; the topic starts again only after it. */
  stopping?: Promise<void>;
}

class PerTopicConsumer implements EnvelopeConsumer {
  private readonly readers = new Map<string, TopicReader>();
  private stopping = false;
  private interrupt: (() => void) | undefined;
  private readonly finished: Promise<void>;

  constructor(
    private readonly kafka: Kafka,
    private readonly options: KafkaQueueOptions,
    private readonly handler: EnvelopeHandler,
    private readonly consumeOptions: ConsumeOptions,
  ) {
    this.finished = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.interrupt?.();
    await this.finished;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      const listed = await this.listTopics();
      if (listed && !this.stopping) this.follow(listed);
      await this.pause(this.options.topicsRefreshMs ?? 10_000);
    }
    await Promise.all([...this.readers].map(([topic, reader]) => this.end(topic, reader)));
  }

  /** Null when the list cannot be read: the readers stay as they are. */
  private async listTopics(): Promise<Set<string> | null> {
    try {
      return new Set(await this.options.topics());
    } catch (error) {
      logger.error({ reason: errorReason(error) }, "read ingest topics failed");
      return null;
    }
  }

  private follow(listed: ReadonlySet<string>): void {
    for (const [topic, reader] of this.readers) {
      if (!listed.has(topic) && !reader.stopping) void this.end(topic, reader);
    }
    for (const topic of listed) {
      if (!this.readers.has(topic)) this.begin(topic);
    }
  }

  private begin(topic: string): void {
    const named = (pattern: string) => pattern.replaceAll(TOPIC_PLACEHOLDER, topic);
    const queue = createKafkaQueue(this.kafka, {
      ...this.options,
      topics: async () => [topic],
      groupId: named(this.options.groupId),
      deadLetterTopic: named(this.options.deadLetterTopic),
    });
    const consumer = queue.consume(this.handler, this.consumeOptions);
    this.readers.set(topic, {
      stop: async () => {
        await consumer.stop();
        await queue.close();
      },
    });
    logger.info({ topic, groupId: named(this.options.groupId) }, "ingest topic started");
  }

  private end(topic: string, reader: TopicReader): Promise<void> {
    reader.stopping ??= reader
      .stop()
      .then(() => logger.info({ topic }, "ingest topic stopped"))
      .catch((error: unknown) =>
        logger.error({ topic, reason: errorReason(error) }, "ingest topic stop failed"),
      )
      .finally(() => {
        if (this.readers.get(topic) === reader) this.readers.delete(topic);
      });
    return reader.stopping;
  }

  private async pause(ms: number): Promise<void> {
    if (this.stopping) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.interrupt = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.interrupt = undefined;
  }
}
