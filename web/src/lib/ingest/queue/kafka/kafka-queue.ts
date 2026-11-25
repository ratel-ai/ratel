import {
  type Consumer,
  type EachBatchPayload,
  type Kafka,
  type KafkaMessage,
  Partitioners,
  type Producer,
} from "kafkajs";
import type { ConsumeOptions, IngestResult } from "@/lib/contracts/ingest-queue";
import { encodeEnvelope } from "@/lib/ingest/queue/envelope";
import type {
  EnvelopeConsumer,
  EnvelopeHandler,
  EnvelopeQueue,
} from "@/lib/ingest/queue/port/envelope-queue";
import {
  errorReason,
  RETRY_POLICY,
  type RetryPolicy,
  readFrame,
  runHandler,
  type Settlement,
  settle,
} from "@/lib/ingest/queue/port/settle";
import { getLogger } from "@/lib/platform/logger";

const logger = getLogger("ingest:kafka");

/** A 4,000,000-byte body, its header and the record's own bytes (ADR-0009). */
const MAX_MESSAGE_BYTES = 4_200_000;
const HEARTBEAT_MS = 3_000;
const SESSION_TIMEOUT_MS = 45_000;
const RESTART_WAIT_MS = 5_000;

export interface KafkaQueueOptions {
  /** Where `publish` writes; absent, this process only consumes. */
  topic?: string;
  /**
   * The topics to consume, an explicit list. Read again every `topicsRefreshMs`, so that a topic
   * can be added or removed while the process runs.
   */
  topics: () => Promise<readonly string[]>;
  groupId: string;
  deadLetterTopic: string;
  policy?: RetryPolicy;
  /** Partitions that one consumer processes at the same time. */
  concurrency?: number;
  topicsRefreshMs?: number;
}

export interface KafkaQueue extends EnvelopeQueue {
  /** Closes the producer. Consumers stop through their own handle. */
  close(): Promise<void>;
}

type Settings = Required<Omit<KafkaQueueOptions, "topic">> & Pick<KafkaQueueOptions, "topic">;

/** The managed service's queue (ADR-0009). Loaded only with `INGEST_QUEUE=kafka`. */
export function createKafkaQueue(kafka: Kafka, options: KafkaQueueOptions): KafkaQueue {
  const settings: Settings = {
    ...options,
    policy: options.policy ?? RETRY_POLICY,
    concurrency: options.concurrency ?? 4,
    topicsRefreshMs: options.topicsRefreshMs ?? 30_000,
  };
  const producer = lazyProducer(kafka);
  return {
    async publish(envelope) {
      const frame = encodeEnvelope(envelope);
      const { topic } = settings;
      if (!topic) throw new Error("INGEST_KAFKA_TOPIC is not set");
      await producer.send(topic, { key: envelope.projectId, value: Buffer.from(frame) });
    },
    consume(handler, consumeOptions = {}) {
      return new KafkaConsumer(kafka, producer, settings, handler, consumeOptions);
    },
    close: () => producer.close(),
  };
}

interface LazyProducer {
  /** Resolves after every in-sync replica has the record. */
  send(topic: string, message: Parameters<Producer["send"]>[0]["messages"][number]): Promise<void>;
  close(): Promise<void>;
}

/** Connects on the first send, and again after a connection that failed. */
function lazyProducer(kafka: Kafka): LazyProducer {
  let connected: Promise<Producer> | undefined;
  const connect = async (): Promise<Producer> => {
    const producer = kafka.producer({
      allowAutoTopicCreation: false,
      // The hash of the Java client, so that every writer of a topic puts a project in one partition.
      createPartitioner: Partitioners.DefaultPartitioner,
    });
    await producer.connect();
    return producer;
  };
  return {
    async send(topic, message) {
      connected ??= connect();
      let producer: Producer;
      try {
        producer = await connected;
      } catch (error) {
        connected = undefined;
        throw error;
      }
      await producer.send({ topic, acks: -1, timeout: 8_000, messages: [message] });
    },
    async close() {
      const open = connected;
      connected = undefined;
      await (await open?.catch(() => undefined))?.disconnect();
    },
  };
}

/** A message that failed and is the next one of its partition. */
interface FailedMessage {
  offset: string;
  attempts: number;
  outages: number;
  firstFailedAt: Date | null;
}

/** Reads the topic list, and keeps one Kafka consumer running on it. */
class KafkaConsumer implements EnvelopeConsumer {
  private stopping = false;
  private interrupt: (() => void) | undefined;
  private readonly finished: Promise<void>;

  constructor(
    private readonly kafka: Kafka,
    private readonly producer: LazyProducer,
    private readonly settings: Settings,
    private readonly handler: EnvelopeHandler,
    private readonly options: ConsumeOptions,
  ) {
    this.finished = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.interrupt?.();
    await this.finished;
  }

  private async run(): Promise<void> {
    let session: TopicsSession | undefined;
    let topics: readonly string[] = [];
    while (!this.stopping) {
      const listed = await this.listTopics();
      if (listed && (!sameTopics(listed, topics) || session?.failed)) {
        await session?.stop();
        session = undefined;
        topics = listed;
        if (topics.length > 0 && !this.stopping) session = await this.start(topics);
      }
      const failed = topics.length > 0 && (!session || session.failed);
      await this.pause(failed ? RESTART_WAIT_MS : this.settings.topicsRefreshMs, session);
      if (failed && !session) topics = [];
    }
    await session?.stop();
  }

  private async listTopics(): Promise<readonly string[] | null> {
    try {
      return [...new Set(await this.settings.topics())].sort();
    } catch (error) {
      logger.error({ reason: errorReason(error) }, "read ingest topics failed");
      return null;
    }
  }

  private async start(topics: readonly string[]): Promise<TopicsSession | undefined> {
    const session = new TopicsSession(
      this.kafka,
      this.producer,
      this.settings,
      this.handler,
      this.options,
    );
    try {
      await session.start(topics, () => this.interrupt?.());
      logger.info(
        { topics: topics.length, groupId: this.settings.groupId },
        "consume ingest topics",
      );
      return session;
    } catch (error) {
      logger.error({ reason: errorReason(error), topics }, "consume ingest topics failed");
      await session.stop().catch(() => undefined);
      return undefined;
    }
  }

  private async pause(ms: number, session: TopicsSession | undefined): Promise<void> {
    if (this.stopping || session?.failed) return;
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

/** One Kafka consumer over a fixed list of topics. */
class TopicsSession {
  /** The client gave up: the consumer needs a new one. */
  failed = false;
  private stopping = false;
  private readonly consumer: Consumer;
  private readonly inHand = new Set<Promise<void>>();
  private readonly timers = new Set<NodeJS.Timeout>();
  /** The failed message of each partition, in memory only: a rebalance starts its count again. */
  private readonly failures = new Map<string, FailedMessage>();

  constructor(
    kafka: Kafka,
    private readonly producer: LazyProducer,
    private readonly settings: Settings,
    private readonly handler: EnvelopeHandler,
    private readonly options: ConsumeOptions,
  ) {
    this.consumer = kafka.consumer({
      groupId: settings.groupId,
      allowAutoTopicCreation: false,
      sessionTimeout: SESSION_TIMEOUT_MS,
      heartbeatInterval: HEARTBEAT_MS,
      maxBytesPerPartition: MAX_MESSAGE_BYTES,
      maxWaitTimeInMs: 500,
      retry: { restartOnFailure: async () => !this.stopping },
    });
  }

  async start(topics: readonly string[], onFailed: () => void): Promise<void> {
    this.consumer.on(this.consumer.events.CRASH, ({ payload }) => {
      if (payload.restart) return;
      this.failed = true;
      onFailed();
    });
    await this.consumer.connect();
    // Without a committed offset, from the start: a moved topic holds what nobody has read.
    await this.consumer.subscribe({ topics: [...topics], fromBeginning: true });
    await this.consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      partitionsConsumedConcurrently: this.settings.concurrency,
      eachBatch: (batch) => this.track(this.consumeBatch(batch)),
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearTimeout(timer);
    // The message in hand and its commit, before the consumer leaves the group.
    await Promise.allSettled(this.inHand);
    await this.consumer.disconnect();
  }

  private track(work: Promise<void>): Promise<void> {
    this.inHand.add(work);
    return work.finally(() => this.inHand.delete(work));
  }

  private async consumeBatch(payload: EachBatchPayload): Promise<void> {
    const { batch, heartbeat, isRunning, isStale, resolveOffset } = payload;
    for (const message of batch.messages) {
      if (this.stopping || !isRunning() || isStale()) return;
      const settled = await this.deliver(payload, message);
      if (!settled) return;
      resolveOffset(message.offset);
      await heartbeat();
    }
  }

  /** False when the message stays the next one of its partition. */
  private async deliver(payload: EachBatchPayload, message: KafkaMessage): Promise<boolean> {
    const { topic, partition } = payload.batch;
    const failure = this.failureOf(topic, partition, message.offset);
    const attempt = failure.attempts + 1;
    const renewal = setInterval(() => {
      // A rebalance shows at the next heartbeat of the loop.
      payload.heartbeat().catch(() => undefined);
    }, HEARTBEAT_MS);
    try {
      const frame = message.value ?? Buffer.alloc(0);
      const read = readFrame(frame);
      const result: IngestResult = read.ok
        ? await runHandler(this.handler, read.envelope, { attempt })
        : read.result;
      let settlement = settle(result, { attempt, outages: failure.outages }, this.settings.policy);
      if (settlement.action !== "ack" && result.outcome !== "outage") {
        failure.attempts = attempt;
        failure.firstFailedAt ??= new Date();
      }
      if (settlement.action === "dead-letter") {
        settlement = await this.deadLetter(message, frame, settlement, failure, topic, partition);
      }
      if (settlement.action === "redeliver") {
        if (settlement.outage) failure.outages += 1;
        else failure.outages = 0;
        this.holdPartition(topic, partition, message.offset, settlement.waitMs);
      } else {
        await this.commitPast(topic, partition, message.offset);
      }
      this.options.onSettled?.({
        messageId: read.ok ? read.envelope.id : null,
        projectId: message.key?.toString("utf8") ?? null,
        attempt,
        outcome: outcomeOf(settlement),
        reason: settlement.action === "ack" ? null : settlement.reason,
      });
      return settlement.action !== "redeliver";
    } finally {
      clearInterval(renewal);
    }
  }

  private failureOf(topic: string, partition: number, offset: string): FailedMessage {
    const key = `${topic}:${partition}`;
    const known = this.failures.get(key);
    if (known?.offset === offset) return known;
    const fresh = { offset, attempts: 0, outages: 0, firstFailedAt: null };
    this.failures.set(key, fresh);
    return fresh;
  }

  /** A dead letter that cannot be written is not lost: the message is delivered again. */
  private async deadLetter(
    message: KafkaMessage,
    frame: Buffer,
    settlement: Extract<Settlement, { action: "dead-letter" }>,
    failure: FailedMessage,
    topic: string,
    partition: number,
  ): Promise<Settlement> {
    const now = new Date();
    try {
      await this.producer.send(this.settings.deadLetterTopic, {
        key: message.key,
        value: frame,
        headers: {
          reason: settlement.reason,
          deliveries: String(failure.attempts),
          first_failed_at: (failure.firstFailedAt ?? now).toISOString(),
          last_failed_at: now.toISOString(),
          source: `${topic}/${partition}/${message.offset}`,
        },
      });
      return settlement;
    } catch (error) {
      logger.error({ reason: errorReason(error) }, "write ingest dead letter failed");
      // The message has failed as often as it may: the next delivery ends here again.
      failure.attempts = Math.max(0, failure.attempts - 1);
      return settle(
        { outcome: "outage", reason: "the dead letter could not be written" },
        { attempt: failure.attempts, outages: failure.outages },
        this.settings.policy,
      );
    }
  }

  /** Waits without the partition's later messages, and then reads it from this message again. */
  private holdPartition(topic: string, partition: number, offset: string, waitMs: number): void {
    const partitions = [{ topic, partitions: [partition] }];
    this.consumer.pause(partitions);
    this.consumer.seek({ topic, partition, offset });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopping) this.consumer.resume(partitions);
    }, waitMs);
    this.timers.add(timer);
  }

  private async commitPast(topic: string, partition: number, offset: string): Promise<void> {
    await this.consumer.commitOffsets([
      { topic, partition, offset: (BigInt(offset) + BigInt(1)).toString() },
    ]);
  }
}

function outcomeOf(settlement: Settlement): IngestResult["outcome"] {
  if (settlement.action !== "redeliver") return settlement.action;
  return settlement.outage ? "outage" : "retry";
}

function sameTopics(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((topic, index) => topic === b[index]);
}
