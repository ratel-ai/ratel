/**
 * The queue between accept and process (ADR-0009). The message type is the caller's: the core's
 * is the envelope (`lib/ingest/queue`). A driver has no offset, partition or topic here.
 */
export interface IngestQueue<Message> {
  /** Resolves after the message is durable, and rejects otherwise. */
  publish(message: Message): Promise<void>;
  /**
   * Starts to deliver messages, at least once each. One message of a project is delivered at a
   * time, in the order that the queue confirmed them, across every consumer of the queue.
   */
  consume(handler: IngestHandler<Message>, options?: ConsumeOptions): IngestConsumer;
}

/** Handles one delivery. A throw counts as `retry`. */
export type IngestHandler<Message> = (
  message: Message,
  delivery: IngestDelivery,
) => Promise<IngestResult>;

export interface IngestDelivery {
  /** 1 for the first delivery. An outage does not count. */
  attempt: number;
}

/** How a delivery ends. A reason is kept and logged, so it holds no telemetry content. */
export type IngestResult =
  /** Stored, or nothing to store. */
  | { outcome: "ack" }
  /** A failure of this message that can pass. Dead-lettered after the last delivery. */
  | { outcome: "retry"; reason: string }
  /** The store cannot be reached or refuses all work. Delivered again without limit. */
  | { outcome: "outage"; reason: string }
  /** It can never pass. */
  | { outcome: "dead-letter"; reason: string };

export interface ConsumeOptions {
  /** Told each time a delivery has ended and the driver has made that durable. */
  onSettled?: (settled: SettledDelivery) => void;
}

export interface SettledDelivery {
  /** Null for a message that cannot be read. */
  messageId: string | null;
  projectId: string | null;
  attempt: number;
  /** `retry` and `outage` will be delivered again. */
  outcome: IngestResult["outcome"];
  reason: string | null;
}

export interface IngestConsumer {
  /**
   * Takes no new message, lets the handlers in hand finish, makes their result durable and
   * releases the driver's claims. A message that waits for a retry is given back. Idempotent.
   */
  stop(): Promise<void>;
}
