import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { IngestResult, SettledDelivery } from "@/lib/contracts/ingest-queue";
import {
  decodeEnvelope,
  ENVELOPE_VERSION,
  type Envelope,
  encodeEnvelope,
} from "@/lib/ingest/queue/envelope";
import type { EnvelopeConsumer, EnvelopeQueue } from "@/lib/ingest/queue/port/envelope-queue";
import { maxDeliveries, type RetryPolicy } from "@/lib/ingest/queue/port/settle";

export interface DeadLetter {
  id: string | null;
  frame: Uint8Array;
  reason: string;
  deliveries: number;
  firstFailedAt: Date;
  lastFailedAt: Date;
}

/** One driver over its own empty storage. */
export interface QueueHarness {
  /** A queue as one process holds it. Every call opens another over the same storage. */
  open(): Promise<EnvelopeQueue>;
  /** Puts a frame on the queue as another writer does, without the driver's own checks. */
  publishFrame(projectId: string, frame: Uint8Array): Promise<void>;
  /** Projects that exist, at least two. */
  projectIds: readonly string[];
  deadLetters(): Promise<DeadLetter[]>;
  close(): Promise<void>;
}

export type QueueHarnessFactory = (policy: RetryPolicy) => Promise<QueueHarness>;

export interface ConformanceOptions {
  /** How long a case waits for a delivery. A driver with slow claims needs more. */
  waitMs?: number;
  /** How long a case looks for a delivery that must not come. */
  quietMs?: number;
}

const POLICY: RetryPolicy = {
  waitsMs: [10, 20, 30, 40],
  outageWaitMs: { first: 5, max: 20 },
};
const ACK: IngestResult = { outcome: "ack" };

/** The suite that every driver passes (ADR-0010). */
export function runQueueConformance(
  name: string,
  createHarness: QueueHarnessFactory,
  { waitMs = 10_000, quietMs = 150 }: ConformanceOptions = {},
): void {
  const suiteCase = (
    title: string,
    run: (context: CaseContext) => Promise<void>,
    policy: RetryPolicy = POLICY,
  ): void => {
    test(`${name}: ${title}`, async () => {
      const harness = await createHarness(policy);
      const consumers: EnvelopeConsumer[] = [];
      try {
        await run({
          harness,
          projects: harness.projectIds,
          consume: (queue, handler, options) => {
            const consumer = queue.consume(handler, options);
            consumers.push(consumer);
            return consumer;
          },
          until: (condition, what) => until(condition, what, waitMs),
          quiet: () => sleep(quietMs),
        });
      } finally {
        await Promise.all(consumers.map((consumer) => consumer.stop()));
        await harness.close();
      }
    });
  };

  suiteCase("delivers what was published, before and after the consumer starts", async (t) => {
    const queue = await t.harness.open();
    const before = envelope(t.projects[0]);
    const after = envelope(t.projects[1], { signal: "events", contentType: "application/json" });
    const seen: { envelope: Envelope; attempt: number }[] = [];

    await queue.publish(before);
    t.consume(queue, async (received, { attempt }) => {
      seen.push({ envelope: received, attempt });
      return ACK;
    });
    await t.until(() => seen.length === 1, "the first message");
    await queue.publish(after);
    await t.until(() => seen.length === 2, "the second message");

    assert.deepEqual(
      seen.map(({ envelope: { body, ...header } }) => ({ ...header, body: [...body] })),
      [before, after].map(({ body, ...header }) => ({ ...header, body: [...body] })),
    );
    assert.deepEqual(
      seen.map(({ attempt }) => attempt),
      [1, 1],
    );
  });

  suiteCase("refuses an envelope that has no encoding, and keeps nothing of it", async (t) => {
    const queue = await t.harness.open();
    await assert.rejects(queue.publish({ ...envelope(t.projects[0]), keyId: "not-a-uuid" }));
    const seen: string[] = [];
    t.consume(queue, collect(seen));
    const good = envelope(t.projects[0]);
    await queue.publish(good);
    await t.until(() => seen.length === 1, "the good message");
    assert.deepEqual(seen, [good.id]);
  });

  suiteCase("an acknowledged message is not delivered again", async (t) => {
    const queue = await t.harness.open();
    const seen: string[] = [];
    const first = t.consume(queue, collect(seen));
    const message = envelope(t.projects[0]);
    await queue.publish(message);
    await t.until(() => seen.length === 1, "the message");
    await first.stop();

    t.consume(await t.harness.open(), collect(seen));
    await t.quiet();
    assert.deepEqual(seen, [message.id]);
    assert.deepEqual(await t.harness.deadLetters(), []);
  });

  suiteCase("a retry and an uncaught error are delivered again", async (t) => {
    const queue = await t.harness.open();
    const attempts: number[] = [];
    const settled: SettledDelivery[] = [];
    t.consume(
      queue,
      async (_, { attempt }) => {
        attempts.push(attempt);
        if (attempt === 1) return { outcome: "retry", reason: "busy" };
        if (attempt === 2) throw new TypeError("secret telemetry");
        return ACK;
      },
      { onSettled: (delivery) => settled.push(delivery) },
    );
    const message = envelope(t.projects[0]);
    await queue.publish(message);
    await t.until(() => settled.length === 3, "three deliveries");
    assert.deepEqual(attempts, [1, 2, 3]);
    assert.deepEqual(
      settled.map(({ outcome, reason, messageId, projectId }) => [
        outcome,
        reason,
        messageId,
        projectId,
      ]),
      [
        ["retry", "busy", message.id, message.projectId],
        ["retry", "uncaught TypeError", message.id, message.projectId],
        ["ack", null, message.id, message.projectId],
      ],
    );
    assert.deepEqual(await t.harness.deadLetters(), []);
  });

  suiteCase("a message that keeps failing is a dead letter, and the next one runs", async (t) => {
    const queue = await t.harness.open();
    const failing = envelope(t.projects[0]);
    const next = envelope(t.projects[0]);
    const seen: string[] = [];
    const startedAt = Date.now();
    t.consume(queue, async ({ id }, { attempt }) => {
      seen.push(id);
      return id === failing.id ? { outcome: "retry", reason: `failure ${attempt}` } : ACK;
    });
    await queue.publish(failing);
    await queue.publish(next);
    await t.until(() => seen.includes(next.id), "the next message");

    const deliveries = maxDeliveries(POLICY);
    assert.deepEqual(seen, [...Array(deliveries).fill(failing.id), next.id]);
    const [dead, ...others] = await t.harness.deadLetters();
    assert.deepEqual(others, []);
    assert.equal(dead.id, failing.id);
    assert.equal(dead.reason, `failure ${deliveries}`);
    assert.equal(dead.deliveries, deliveries);
    assert.deepEqual(Buffer.from(dead.frame), Buffer.from(encodeEnvelope(failing)));
    assert.deepEqual(decodeEnvelope(dead.frame).body, failing.body);
    // A driver's clock may be the database's: allow it some skew.
    assert.ok(dead.firstFailedAt.getTime() >= startedAt - 5_000);
    assert.ok(dead.lastFailedAt.getTime() > dead.firstFailedAt.getTime());
  });

  suiteCase("a message that can never pass is a dead letter at once", async (t) => {
    const queue = await t.harness.open();
    const bad = envelope(t.projects[0]);
    const next = envelope(t.projects[0]);
    const seen: string[] = [];
    t.consume(queue, async ({ id }) => {
      seen.push(id);
      return id === bad.id ? { outcome: "dead-letter", reason: "does not decode" } : ACK;
    });
    await queue.publish(bad);
    await queue.publish(next);
    await t.until(() => seen.length === 2, "both messages");
    assert.deepEqual(seen, [bad.id, next.id]);
    const dead = await t.harness.deadLetters();
    assert.deepEqual(
      dead.map(({ id, reason, deliveries }) => ({ id, reason, deliveries })),
      [{ id: bad.id, reason: "does not decode", deliveries: 1 }],
    );
  });

  suiteCase("a frame that does not decode is a dead letter, and never a delivery", async (t) => {
    const queue = await t.harness.open();
    const seen: string[] = [];
    const newer = encodeEnvelope(envelope(t.projects[0]));
    newer[4] = ENVELOPE_VERSION + 1;
    const good = envelope(t.projects[0]);
    await t.harness.publishFrame(t.projects[0], newer);
    await queue.publish(good);
    t.consume(queue, collect(seen));
    await t.until(() => seen.length === 1, "the good message");
    assert.deepEqual(seen, [good.id]);
    const [dead, ...others] = await t.harness.deadLetters();
    assert.deepEqual(others, []);
    assert.deepEqual(Buffer.from(dead.frame), Buffer.from(newer));
    assert.match(dead.reason, /newer than this process/);
  });

  suiteCase("an outage is delivered again without limit and dead-letters nothing", async (t) => {
    const queue = await t.harness.open();
    const attempts: number[] = [];
    const outages = maxDeliveries(POLICY) + 3;
    t.consume(queue, async (_, { attempt }) => {
      attempts.push(attempt);
      if (attempts.length <= outages) return { outcome: "outage", reason: "store is down" };
      return ACK;
    });
    await queue.publish(envelope(t.projects[0]));
    await t.until(() => attempts.length === outages + 1, "the delivery after the outage");
    assert.deepEqual(attempts, Array(outages + 1).fill(1));
    assert.deepEqual(await t.harness.deadLetters(), []);
  });

  suiteCase("keeps each project's order and delivers one of its messages at a time", async (t) => {
    const queues = [await t.harness.open(), await t.harness.open()];
    const published = new Map(t.projects.map((projectId) => [projectId, [] as string[]]));
    const seen = new Map(t.projects.map((projectId) => [projectId, [] as string[]]));
    const inHand = new Set<string>();
    const overlaps: string[] = [];
    const failOnce = new Set<string>();
    const total = t.projects.length * 12;
    let acked = 0;

    const handler = async ({ id, projectId }: Envelope): Promise<IngestResult> => {
      if (inHand.has(projectId)) overlaps.push(id);
      inHand.add(projectId);
      await sleep(2);
      inHand.delete(projectId);
      if (failOnce.delete(id)) return { outcome: "retry", reason: "once" };
      // At least once: a driver can deliver again, for example when the second consumer joins.
      const ids = seen.get(projectId);
      if (ids && !ids.includes(id)) {
        ids.push(id);
        acked += 1;
      }
      return ACK;
    };
    for (let index = 0; index < 12; index++) {
      for (const projectId of t.projects) {
        const message = envelope(projectId);
        if (index % 5 === 0) failOnce.add(message.id);
        await queues[0].publish(message);
        published.get(projectId)?.push(message.id);
      }
      if (index === 4) for (const queue of queues) t.consume(queue, handler);
    }
    await t.until(() => acked === total, "every message");
    assert.deepEqual(overlaps, []);
    assert.deepEqual(seen, published);
  });

  suiteCase("a message that waits for a retry holds its project", async (t) => {
    const queue = await t.harness.open();
    const held = envelope(t.projects[0]);
    const behind = envelope(t.projects[0]);
    const seen: string[] = [];
    t.consume(queue, async ({ id }, { attempt }) => {
      seen.push(id);
      return id === held.id && attempt < 4 ? { outcome: "retry", reason: "again" } : ACK;
    });
    await queue.publish(held);
    await queue.publish(behind);
    await t.until(() => seen.includes(behind.id), "the message behind");
    assert.deepEqual(seen, [held.id, held.id, held.id, held.id, behind.id]);
  });

  suiteCase("stop finishes the message in hand and takes no other", async (t) => {
    const queue = await t.harness.open();
    const inHand = envelope(t.projects[0]);
    const behind = envelope(t.projects[0]);
    const gate = deferred();
    const seen: string[] = [];
    let stopped = false;
    const consumer = t.consume(queue, async ({ id }) => {
      seen.push(id);
      await gate.promise;
      return ACK;
    });
    await queue.publish(inHand);
    await queue.publish(behind);
    await t.until(() => seen.length === 1, "the message in hand");

    const stopping = consumer.stop().then(() => {
      stopped = true;
    });
    await t.quiet();
    assert.equal(stopped, false, "stop resolved before the handler did");
    gate.resolve();
    await stopping;
    await consumer.stop();
    assert.deepEqual(seen, [inHand.id]);

    const later: string[] = [];
    t.consume(await t.harness.open(), collect(later));
    await t.until(() => later.length === 1, "the message behind");
    await t.quiet();
    assert.deepEqual(later, [behind.id]);
  });

  suiteCase(
    "stop gives back a message that waits for a retry",
    async (t) => {
      const queue = await t.harness.open();
      const message = envelope(t.projects[0]);
      let deliveries = 0;
      const consumer = t.consume(queue, async () => {
        deliveries += 1;
        return { outcome: "retry", reason: "later" };
      });
      await queue.publish(message);
      await t.until(() => deliveries === 1, "the first delivery");
      const startedAt = Date.now();
      await consumer.stop();
      assert.ok(Date.now() - startedAt < STOP_WAIT_MS, "stop waited for the retry");

      const seen: string[] = [];
      t.consume(await t.harness.open(), collect(seen));
      await t.until(() => seen.length === 1, "the message again");
      assert.deepEqual(seen, [message.id]);
      assert.deepEqual(await t.harness.deadLetters(), []);
    },
    { ...POLICY, waitsMs: [STOP_WAIT_MS, 20, 30, 40] },
  );
}

const STOP_WAIT_MS = 2_000;

interface CaseContext {
  harness: QueueHarness;
  projects: readonly string[];
  consume: (
    queue: EnvelopeQueue,
    ...args: Parameters<EnvelopeQueue["consume"]>
  ) => EnvelopeConsumer;
  until: (condition: () => boolean, what: string) => Promise<void>;
  quiet: () => Promise<void>;
}

export function envelope(projectId: string, overrides: Partial<Envelope> = {}): Envelope {
  return {
    version: ENVELOPE_VERSION,
    id: randomUUID(),
    projectId,
    organizationId: "0d1f7a3c-5b1e-4c6a-9f00-0000000000a1",
    keyId: "0d1f7a3c-5b1e-4c6a-9f00-0000000000b1",
    keyPolicy: { appendOnlyIngest: false, sharedKeyLimits: false },
    signal: "traces",
    contentType: "application/x-protobuf",
    contentEncoding: "identity",
    receivedAt: 1_764_000_000_000,
    body: Uint8Array.from([0, 1, 127, 128, 255]),
    ...overrides,
  };
}

function collect(seen: string[]) {
  return async ({ id }: Envelope): Promise<IngestResult> => {
    seen.push(id);
    return ACK;
  };
}

async function until(condition: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(5);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
