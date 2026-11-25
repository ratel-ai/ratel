import type { ConsumeOptions, IngestResult } from "@/lib/contracts/ingest-queue";
import { encodeEnvelope } from "@/lib/ingest/queue/envelope";
import type {
  EnvelopeConsumer,
  EnvelopeHandler,
  EnvelopeQueue,
} from "@/lib/ingest/queue/port/envelope-queue";
import {
  errorReason,
  maxDeliveries,
  RETRY_POLICY,
  type RetryPolicy,
  readFrame,
  runHandler,
  type Settlement,
  settle,
} from "@/lib/ingest/queue/port/settle";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  type ClaimedMessage,
  claimMessage,
  deadLetterMessage,
  giveBackMessage,
  insertMessage,
  redeliverMessage,
  removeMessage,
  renewClaim,
  type SpoolDb,
} from "./store";

const logger = getLogger("ingest:queue");

export interface PostgresQueueOptions {
  db?: SpoolDb;
  policy?: RetryPolicy;
  /** Projects that one consumer processes at the same time. */
  concurrency?: number;
  /** How often an idle consumer looks for messages of other processes. */
  pollMs?: number;
  /** A claim that is not renewed for this long is free: its process is gone. */
  leaseMs?: number;
}

type Settings = Required<PostgresQueueOptions>;

/** The ingest queue on one Postgres table, for a deployment with nothing else (ADR-0009). */
export function createPostgresQueue(options: PostgresQueueOptions = {}): EnvelopeQueue {
  const settings: Settings = {
    db: options.db ?? getDb(),
    policy: options.policy ?? RETRY_POLICY,
    concurrency: options.concurrency ?? 4,
    pollMs: options.pollMs ?? 500,
    leaseMs: options.leaseMs ?? 60_000,
  };
  const consumers = new Set<PostgresConsumer>();
  return {
    async publish(envelope) {
      const frame = encodeEnvelope(envelope);
      await insertMessage(settings.db, {
        messageId: envelope.id,
        projectId: envelope.projectId,
        frame,
      });
      for (const consumer of consumers) consumer.wake();
    },
    consume(handler, consumeOptions = {}) {
      const consumer = new PostgresConsumer(settings, handler, consumeOptions, () =>
        consumers.delete(consumer),
      );
      consumers.add(consumer);
      return consumer;
    },
  };
}

class PostgresConsumer implements EnvelopeConsumer {
  private stopping = false;
  private woken = false;
  private interrupt: (() => void) | undefined;
  private readonly inHand = new Set<Promise<void>>();
  private readonly finished: Promise<void>;

  constructor(
    private readonly settings: Settings,
    private readonly handler: EnvelopeHandler,
    private readonly options: ConsumeOptions,
    private readonly onStop: () => void,
  ) {
    this.finished = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.onStop();
    this.wake();
    await this.finished;
  }

  /** Ends the current wait, or the next one. */
  wake(): void {
    this.woken = true;
    this.interrupt?.();
  }

  private async run(): Promise<void> {
    const { db, leaseMs, concurrency, pollMs } = this.settings;
    while (!this.stopping) {
      if (this.inHand.size >= concurrency) {
        await Promise.race(this.inHand);
        continue;
      }
      let claim: ClaimedMessage | null = null;
      try {
        claim = await claimMessage(db, leaseMs);
      } catch (error) {
        // The query's error quotes its parameters.
        logger.error({ reason: errorReason(error) }, "claim ingest message failed");
      }
      if (!claim) {
        await this.pause(pollMs);
        continue;
      }
      const delivery = this.deliver(claim).finally(() => {
        this.inHand.delete(delivery);
        // Its project may have a next message.
        this.wake();
      });
      this.inHand.add(delivery);
    }
    await Promise.all(this.inHand);
  }

  private async deliver(claim: ClaimedMessage): Promise<void> {
    if (this.stopping) {
      await this.persist(claim, () => giveBackMessage(this.settings.db, claim).then(() => true));
      return;
    }
    const renewal = this.keepClaim(claim);
    try {
      await this.settleDelivery(claim, await this.handle(claim));
    } finally {
      clearInterval(renewal);
    }
  }

  private async handle(claim: ClaimedMessage): Promise<IngestResult> {
    // The claim counts the delivery first, so this bounds a message that kills its process.
    if (claim.deliveries > maxDeliveries(this.settings.policy)) {
      return { outcome: "dead-letter", reason: "the last delivery ended without a result" };
    }
    const read = readFrame(claim.frame);
    if (!read.ok) return read.result;
    return runHandler(this.handler, read.envelope, { attempt: claim.deliveries });
  }

  private async settleDelivery(claim: ClaimedMessage, result: IngestResult): Promise<void> {
    const { policy } = this.settings;
    const attempt = Math.min(claim.deliveries, maxDeliveries(policy));
    const settlement = settle(result, { attempt, outages: claim.outages }, policy);
    const held = await this.persist(claim, () => this.write(claim, settlement, attempt));
    if (!held) return;
    this.options.onSettled?.({
      messageId: claim.messageId,
      projectId: claim.projectId,
      attempt,
      outcome: settlement.action === "dead-letter" ? "dead-letter" : result.outcome,
      reason: settlement.action === "ack" ? null : settlement.reason,
    });
  }

  private write(claim: ClaimedMessage, settlement: Settlement, attempt: number): Promise<boolean> {
    const { db } = this.settings;
    switch (settlement.action) {
      case "ack":
        return removeMessage(db, claim);
      case "redeliver":
        return redeliverMessage(db, claim, settlement);
      case "dead-letter":
        return deadLetterMessage(db, claim, settlement.reason, attempt);
    }
  }

  /**
   * Writes the end of a delivery, also through a database outage: the result is kept rather than
   * made again. While the process stops it gives up after a few tries, and the message is
   * delivered again when its claim ends. False when the result did not reach the row.
   */
  private async persist(claim: ClaimedMessage, write: () => Promise<boolean>): Promise<boolean> {
    for (let failures = 0; ; ) {
      try {
        const held = await write();
        if (!held) {
          logger.warn(
            { projectId: claim.projectId, messageId: claim.messageId },
            "ingest claim lost",
          );
        }
        return held;
      } catch (error) {
        failures += 1;
        logger.error(
          { reason: errorReason(error), messageId: claim.messageId, failures },
          "settle ingest message failed",
        );
        if (this.stopping && failures >= MAX_STOPPING_WRITES) return false;
        await sleep(Math.min(5_000, 250 * 2 ** failures));
      }
    }
  }

  private keepClaim(claim: ClaimedMessage): NodeJS.Timeout {
    const { db, leaseMs } = this.settings;
    return setInterval(() => {
      renewClaim(db, claim, leaseMs).catch((error: unknown) => {
        logger.warn({ reason: errorReason(error) }, "renew ingest claim failed");
      });
    }, leaseMs / 3);
  }

  private async pause(ms: number): Promise<void> {
    if (this.woken || this.stopping) {
      this.woken = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.interrupt = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.interrupt = undefined;
    this.woken = false;
  }
}

const MAX_STOPPING_WRITES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
